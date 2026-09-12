import { derivedIdempotencyKey } from '../domain/ids.js';
import type { Clock } from '../domain/clock.js';
import { buildEntry, credit, debit } from '../domain/ledger/journal.js';
import type { FeeSchedule } from '../domain/pricing/fee-schedule.js';
import type { Database } from '../ports/repository.port.js';
import type { PostgresLedgerRepository } from '../adapters/postgres/ledger.repository.js';
import { LOCK_NS } from '../adapters/postgres/database.js';
import type { Logger } from '../observability/logger.js';

/**
 * Housekeeping that must still be exactly right on the money side:
 * credit expiry (breakage), stale-order cleanup, and idempotency-key purging.
 *
 * Breakage is revenue when the coins expire, and it is not a supply for GST
 * (CBIC Circular 243/37/2024), so it is recognised against income with no
 * output tax.
 */
export class MaintenanceService {
  constructor(
    private readonly db: Database,
    private readonly ledger: PostgresLedgerRepository,
    private readonly clock: Clock,
    private readonly schedule: FeeSchedule,
    private readonly logger: Logger,
  ) {}

  /** Expire credit lots past their expiry date and recognise breakage. */
  async expireCredits(batchSize = 500): Promise<{ lotsExpired: number; creditsExpired: number; breakagePaise: number }> {
    const now = this.clock.now();

    const users = await this.db.transaction(
      async (uow) => {
        const res = await uow.query<{ user_id: string }>(
          `SELECT DISTINCT user_id FROM credit_lots
            WHERE expired = FALSE AND credits_remaining > 0 AND expires_at <= $1
            LIMIT $2`,
          [now, batchSize],
        );
        return res.rows.map((r) => r.user_id);
      },
      { readOnly: true },
    );

    let lotsExpired = 0;
    let creditsExpired = 0;
    let breakagePaise = 0;

    for (const userId of users) {
      const result = await this.db.transaction(async (uow) => {
        await uow.advisoryLock(LOCK_NS.WALLET, userId);

        const lots = await uow.query<{ id: string; credits_remaining: number }>(
          `SELECT id, credits_remaining FROM credit_lots
            WHERE user_id = $1 AND expired = FALSE AND credits_remaining > 0 AND expires_at <= $2
            FOR UPDATE`,
          [userId, now],
        );
        if (lots.rowCount === 0) return { lots: 0, credits: 0, paise: 0 };

        const credits = lots.rows.reduce((a, l) => a + l.credits_remaining, 0);
        const paise = credits * this.schedule.creditValuePaise;

        for (const lot of lots.rows) {
          await uow.query('UPDATE credit_lots SET expired = TRUE, credits_remaining = 0 WHERE id = $1', [lot.id]);
          await uow.query(
            `INSERT INTO credit_movements (user_id, lot_id, delta, reason, reference_id)
             VALUES ($1, $2, $3, 'expiry', $2) ON CONFLICT DO NOTHING`,
            [userId, lot.id, -lot.credits_remaining],
          );
        }

        await uow.query(
          `UPDATE credit_wallets SET balance_credits = GREATEST(0, balance_credits - $2),
                                     version = version + 1, updated_at = now()
            WHERE user_id = $1`,
          [userId, credits],
        );

        if (paise > 0) {
          await this.ledger.post(
            uow,
            buildEntry({
              entryType: 'credit_breakage',
              occurredAt: now,
              referenceType: 'user',
              referenceId: userId,
              idempotencyKey: derivedIdempotencyKey('breakage', userId, now.toISOString().slice(0, 10)),
              postings: [debit('CREDIT_LIABILITY', paise), credit('BREAKAGE_REVENUE', paise)],
              metadata: { credits, lots: lots.rowCount },
            }),
          );
        }

        return { lots: lots.rowCount, credits, paise };
      });

      lotsExpired += result.lots;
      creditsExpired += result.credits;
      breakagePaise += result.paise;
    }

    if (lotsExpired > 0) {
      this.logger.info({ lotsExpired, creditsExpired, breakagePaise }, 'credit breakage recognised');
    }
    return { lotsExpired, creditsExpired, breakagePaise };
  }

  /** Expire orders the reader never completed, so they stop holding an idempotency key. */
  async expireStaleOrders(): Promise<number> {
    return this.db.transaction(async (uow) => {
      const res = await uow.query(
        `UPDATE orders SET status = 'expired'
          WHERE status IN ('created','pending') AND expires_at IS NOT NULL AND expires_at < $1`,
        [this.clock.now()],
      );
      return res.rowCount;
    });
  }

  async purgeExpiredIdempotencyKeys(): Promise<number> {
    return this.db.transaction(async (uow) => {
      const res = await uow.query('DELETE FROM idempotency_keys WHERE expires_at < now()');
      return res.rowCount;
    });
  }

  /** Flag creators nearing their own GST registration threshold so GSTINs can be collected. */
  async flagCreatorsNearingGstThreshold(): Promise<{ creatorId: string; grossPaise: number }[]> {
    return this.db.transaction(async (uow) => {
      const res = await uow.query<{ id: string; lifetime_gross_paise: number; state_code: string | null }>(
        `SELECT id, lifetime_gross_paise, state_code FROM creators
          WHERE gstin IS NULL
            AND lifetime_gross_paise >= CASE
              WHEN state_code IN ('11','12','13','14','15','16','17','05') THEN 800000000
              ELSE 1600000000 END`,
      );
      for (const row of res.rows) {
        await uow.query(
          `INSERT INTO risk_signals (creator_id, signal, severity, details)
           VALUES ($1, 'approaching_gst_threshold', 'warn', $2::jsonb)`,
          [row.id, JSON.stringify({ lifetimeGrossPaise: row.lifetime_gross_paise })],
        );
      }
      return res.rows.map((r) => ({ creatorId: r.id, grossPaise: r.lifetime_gross_paise }));
    });
  }
}
