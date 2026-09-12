import { derivedIdempotencyKey, newId } from '../domain/ids.js';
import { err } from '../domain/errors.js';
import { financialYear, type Clock } from '../domain/clock.js';
import { clampNonNegative, subtract, sum, type Paise } from '../domain/money/money.js';
import { buildEntry, compact, credit, debit } from '../domain/ledger/journal.js';
import { assertFinalisable } from '../domain/settlement/cycle.js';
import { computeWithholding } from '../domain/pricing/split.js';
import type { FeeSchedule } from '../domain/pricing/fee-schedule.js';
import type { TaxPolicy } from '../domain/tax/policy.js';
import type { Database, SettlementPeriodRecord, UnitOfWork } from '../ports/repository.port.js';
import type { PostgresLedgerRepository } from '../adapters/postgres/ledger.repository.js';
import type { SettlementPeriodService } from './settlement-period.service.js';
import { mapCreator, taxProfileOf } from './creator.service.js';
import { LOCK_NS } from '../adapters/postgres/database.js';
import type { Logger } from '../observability/logger.js';
import type { RiskService } from './risk.service.js';

/**
 * Settlement close (blueprint Part 8).
 *
 *   Day 36: release the reserve, compute TCS and TDS over the period's
 *   aggregates, issue the creator statement, and queue a payout for anyone
 *   above the minimum threshold. Everything below threshold or blocked by risk
 *   carries forward in `CREATOR_PAYABLE` — the money stays the creator's.
 *
 * The whole close for one creator is a single transaction. A crash mid-close
 * leaves the period unfinalised and the run is simply repeated: every ledger
 * posting is keyed on (period, creator), so the repeat is a no-op for whoever
 * already completed.
 */

export interface CloseResult {
  periodId: string;
  creatorsProcessed: number;
  statementsIssued: number;
  carriedForward: number;
  payoutsQueued: number;
  totalNetPayable: Paise;
  totalTcs: Paise;
  totalTds: Paise;
  totalReserveReleased: Paise;
  durationMs: number;
}

interface PeriodAggregate {
  creator_id: string;
  gross: number;
  pg_fee: number;
  gst_on_pg_fee: number;
  platform_fee: number;
  gst_on_platform_fee: number;
  split_fee: number;
  gst_on_split_fee: number;
  creator_gross: number;
  refunded: number;
  reserve_outstanding: number;
  txn_count: number;
}

export class SettlementService {
  constructor(
    private readonly db: Database,
    private readonly ledger: PostgresLedgerRepository,
    private readonly periods: SettlementPeriodService,
    private readonly taxPolicy: TaxPolicy,
    private readonly risk: RiskService,
    private readonly schedule: FeeSchedule,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** Finalise every period whose grace window has closed. */
  async closeDuePeriods(): Promise<CloseResult[]> {
    const due = await this.db.transaction((uow) => this.periods.findFinalisable(uow), { readOnly: true });
    const results: CloseResult[] = [];
    for (const period of due) {
      results.push(await this.closePeriod(period.id));
    }
    return results;
  }

  async closePeriod(periodId: string): Promise<CloseResult> {
    const startedAt = Date.now();
    const now = this.clock.now();

    const period = await this.db.transaction(async (uow) => {
      await uow.advisoryLock(LOCK_NS.PERIOD, periodId);
      const p = await this.periods.byId(uow, periodId);
      if (!p) throw err.notFound('settlement.period_not_found', 'settlement period does not exist', { periodId });
      assertFinalisable(p, now);
      await this.periods.setStatus(uow, periodId, 'finalising');
      return p;
    });

    const creatorIds = await this.db.transaction(
      async (uow) => {
        const res = await uow.query<{ creator_id: string }>(
          'SELECT DISTINCT creator_id FROM redemptions WHERE period_id = $1 ORDER BY creator_id',
          [periodId],
        );
        return res.rows.map((r) => r.creator_id);
      },
      { readOnly: true },
    );

    const result: CloseResult = {
      periodId,
      creatorsProcessed: 0,
      statementsIssued: 0,
      carriedForward: 0,
      payoutsQueued: 0,
      totalNetPayable: 0,
      totalTcs: 0,
      totalTds: 0,
      totalReserveReleased: 0,
      durationMs: 0,
    };

    for (const creatorId of creatorIds) {
      try {
        const one = await this.closeCreator(period, creatorId, now);
        result.creatorsProcessed++;
        result.totalTcs = sum(result.totalTcs, one.tcs);
        result.totalTds = sum(result.totalTds, one.tds);
        result.totalReserveReleased = sum(result.totalReserveReleased, one.reserveReleased);
        result.totalNetPayable = sum(result.totalNetPayable, clampNonNegative(one.netPayable));
        if (one.payoutQueued) result.payoutsQueued++;
        if (one.status === 'carried_forward') result.carriedForward++;
        else result.statementsIssued++;
      } catch (e) {
        this.logger.error({ err: e, creatorId, periodId }, 'creator settlement failed; period stays unfinalised');
        throw e;
      }
    }

    await this.db.transaction(async (uow) => {
      await this.periods.setStatus(uow, periodId, 'finalised');
      await uow.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, subject_type, subject_id, details)
         VALUES (NULL, 'system', 'settlement.period_finalised', 'settlement_period', $1, $2::jsonb)`,
        [periodId, JSON.stringify({ ...result, durationMs: Date.now() - startedAt })],
      );
    });

    result.durationMs = Date.now() - startedAt;
    this.logger.info({ ...result }, 'settlement period finalised');
    return result;
  }

  private async closeCreator(
    period: SettlementPeriodRecord,
    creatorId: string,
    now: Date,
  ): Promise<{
    tcs: Paise;
    tds: Paise;
    reserveReleased: Paise;
    netPayable: Paise;
    payoutQueued: boolean;
    status: 'issued' | 'carried_forward';
  }> {
    return this.db.transaction(async (uow) => {
      await uow.advisoryLock(LOCK_NS.CREATOR, creatorId);

      // Idempotence: a completed statement short-circuits the whole close.
      const existing = await uow.query<{
        id: string;
        status: string;
        tcs_paise: number;
        tds_paise: number;
        reserve_released_paise: number;
        net_payable_paise: number;
      }>('SELECT id, status, tcs_paise, tds_paise, reserve_released_paise, net_payable_paise FROM creator_statements WHERE period_id = $1 AND creator_id = $2', [
        period.id,
        creatorId,
      ]);
      if (existing.rowCount > 0 && existing.rows[0]!.status !== 'draft') {
        const row = existing.rows[0]!;
        return {
          tcs: row.tcs_paise,
          tds: row.tds_paise,
          reserveReleased: row.reserve_released_paise,
          netPayable: row.net_payable_paise,
          payoutQueued: false,
          status: row.status === 'carried_forward' ? 'carried_forward' : 'issued',
        };
      }

      const creatorRes = await uow.query('SELECT * FROM creators WHERE id = $1 FOR UPDATE', [creatorId]);
      if (creatorRes.rowCount === 0) throw err.notFound('settlement.creator_missing', 'creator does not exist');
      const creator = mapCreator(creatorRes.rows[0] as never);

      const agg = await this.aggregatePeriod(uow, period.id, creatorId);

      // 1. Release the reserve now that the dispute window has closed.
      const reserveOutstanding = agg.reserve_outstanding;
      if (reserveOutstanding > 0) {
        await this.ledger.post(
          uow,
          buildEntry({
            entryType: 'reserve_released',
            occurredAt: now,
            referenceType: 'settlement_period',
            referenceId: period.id,
            idempotencyKey: derivedIdempotencyKey('reserve-release', period.id, creatorId),
            postings: [
              debit('RESERVE_HOLDBACK', reserveOutstanding, creatorId),
              credit('CREATOR_PAYABLE', reserveOutstanding, creatorId),
            ],
            metadata: { creatorId },
          }),
        );
        await uow.query(
          `UPDATE redemptions SET reserve_released_paise = reserve_held_paise
            WHERE period_id = $1 AND creator_id = $2 AND reserve_released_paise < reserve_held_paise`,
          [period.id, creatorId],
        );
      }

      // 2. Statutory withholding over the period's aggregates.
      const fy = financialYear(period.periodEnd);
      const fyRes = await uow.query<{ gross_paise: number; tds_deducted_paise: number; tcs_collected_paise: number }>(
        `SELECT gross_paise, tds_deducted_paise, tcs_collected_paise
           FROM creator_fy_tax WHERE creator_id = $1 AND financial_year = $2 FOR UPDATE`,
        [creatorId, fy],
      );
      const prior = fyRes.rows[0] ?? { gross_paise: 0, tds_deducted_paise: 0, tcs_collected_paise: 0 };

      const netTaxableValue = clampNonNegative(subtract(agg.gross, agg.refunded));
      const withholding = computeWithholding({
        periodGross: netTaxableValue,
        periodNetTaxableValue: netTaxableValue,
        priorFyGross: prior.gross_paise,
        priorFyTdsDeducted: prior.tds_deducted_paise,
        profile: taxProfileOf(creator),
        policy: this.taxPolicy,
        on: period.periodEnd,
      });

      if (withholding.tcs > 0) {
        await this.ledger.post(
          uow,
          buildEntry({
            entryType: 'tcs_withheld',
            occurredAt: now,
            referenceType: 'settlement_period',
            referenceId: period.id,
            idempotencyKey: derivedIdempotencyKey('tcs', period.id, creatorId),
            postings: [
              debit('CREATOR_PAYABLE', withholding.tcs, creatorId),
              credit('TCS_PAYABLE', withholding.tcs),
            ],
            metadata: { creatorId, base: netTaxableValue, ratePpm: withholding.tcsLine.ratePpm },
          }),
        );
      }
      if (withholding.tds > 0) {
        await this.ledger.post(
          uow,
          buildEntry({
            entryType: 'tds_withheld',
            occurredAt: now,
            referenceType: 'settlement_period',
            referenceId: period.id,
            idempotencyKey: derivedIdempotencyKey('tds', period.id, creatorId),
            postings: [
              debit('CREATOR_PAYABLE', withholding.tds, creatorId),
              credit('TDS_PAYABLE', withholding.tds),
            ],
            metadata: { creatorId, base: netTaxableValue, ratePpm: withholding.tdsLine.ratePpm, financialYear: fy },
          }),
        );
      }

      await uow.query(
        `INSERT INTO creator_fy_tax (creator_id, financial_year, gross_paise, tds_deducted_paise, tcs_collected_paise)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (creator_id, financial_year) DO UPDATE
           SET gross_paise = creator_fy_tax.gross_paise + EXCLUDED.gross_paise,
               tds_deducted_paise = creator_fy_tax.tds_deducted_paise + EXCLUDED.tds_deducted_paise,
               tcs_collected_paise = creator_fy_tax.tcs_collected_paise + EXCLUDED.tcs_collected_paise,
               updated_at = now()`,
        [creatorId, fy, netTaxableValue, withholding.tds, withholding.tcs],
      );

      // 3. Whatever remains in CREATOR_PAYABLE is the creator's money. It
      //    already reflects refunds, claw-backs and prior carry-forward, which
      //    is why the payable balance — not a recomputed sum — is the payout.
      const carryRes = await uow.query<{ carried_forward_paise: number }>(
        `SELECT cs.carried_forward_paise
           FROM creator_statements cs
           JOIN settlement_periods sp ON sp.id = cs.period_id
          WHERE cs.creator_id = $1 AND sp.sequence < $2
          ORDER BY sp.sequence DESC LIMIT 1`,
        [creatorId, period.sequence],
      );
      const openingCarry = carryRes.rows[0]?.carried_forward_paise ?? 0;
      const netPayable = await this.ledger.creatorPayable(uow, creatorId);

      const blocked = await this.risk.hasBlockingSignal(uow, creatorId);
      const holdActive = !!creator.firstPayoutHoldUntil && creator.firstPayoutHoldUntil > now;
      const eligible =
        netPayable >= this.schedule.minimumPayoutPaise && creator.payoutsEnabled && !blocked && !holdActive;

      const statementId = existing.rows[0]?.id ?? newId('statement');
      const status: 'issued' | 'carried_forward' = eligible ? 'issued' : 'carried_forward';

      await uow.query(
        `INSERT INTO creator_statements
           (id, period_id, creator_id, gross_paise, pg_fee_paise, gst_on_pg_fee_paise, platform_fee_paise,
            gst_on_platform_fee_paise, split_fee_paise, gst_on_split_fee_paise, creator_gross_paise,
            tcs_paise, tds_paise, tcs_rate_ppm, tds_rate_ppm, reserve_released_paise, refund_adjustment_paise,
            opening_carry_forward_paise, net_payable_paise, carried_forward_paise, transaction_count, status, issued_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         ON CONFLICT (period_id, creator_id) DO UPDATE SET
           gross_paise = EXCLUDED.gross_paise,
           pg_fee_paise = EXCLUDED.pg_fee_paise,
           gst_on_pg_fee_paise = EXCLUDED.gst_on_pg_fee_paise,
           platform_fee_paise = EXCLUDED.platform_fee_paise,
           gst_on_platform_fee_paise = EXCLUDED.gst_on_platform_fee_paise,
           split_fee_paise = EXCLUDED.split_fee_paise,
           gst_on_split_fee_paise = EXCLUDED.gst_on_split_fee_paise,
           creator_gross_paise = EXCLUDED.creator_gross_paise,
           tcs_paise = EXCLUDED.tcs_paise,
           tds_paise = EXCLUDED.tds_paise,
           tcs_rate_ppm = EXCLUDED.tcs_rate_ppm,
           tds_rate_ppm = EXCLUDED.tds_rate_ppm,
           reserve_released_paise = EXCLUDED.reserve_released_paise,
           refund_adjustment_paise = EXCLUDED.refund_adjustment_paise,
           opening_carry_forward_paise = EXCLUDED.opening_carry_forward_paise,
           net_payable_paise = EXCLUDED.net_payable_paise,
           carried_forward_paise = EXCLUDED.carried_forward_paise,
           transaction_count = EXCLUDED.transaction_count,
           status = EXCLUDED.status,
           issued_at = EXCLUDED.issued_at`,
        [
          statementId,
          period.id,
          creatorId,
          agg.gross,
          agg.pg_fee,
          agg.gst_on_pg_fee,
          agg.platform_fee,
          agg.gst_on_platform_fee,
          agg.split_fee,
          agg.gst_on_split_fee,
          agg.creator_gross,
          withholding.tcs,
          withholding.tds,
          withholding.tcsLine.ratePpm,
          withholding.tdsLine.ratePpm,
          reserveOutstanding,
          agg.refunded,
          openingCarry,
          clampNonNegative(netPayable),
          eligible ? 0 : clampNonNegative(netPayable),
          agg.txn_count,
          status,
          now,
        ],
      );

      let payoutQueued = false;
      if (eligible) {
        await this.queuePayout(uow, creatorId, statementId, netPayable, now);
        payoutQueued = true;
      }

      await this.risk.evaluatePayerConcentration(uow, creatorId);

      return {
        tcs: withholding.tcs,
        tds: withholding.tds,
        reserveReleased: reserveOutstanding,
        netPayable,
        payoutQueued,
        status,
      };
    });
  }

  private async aggregatePeriod(uow: UnitOfWork, periodId: string, creatorId: string): Promise<PeriodAggregate> {
    const res = await uow.query<PeriodAggregate>(
      `SELECT $2::text AS creator_id,
              COALESCE(SUM(gross_paise), 0)                                     AS gross,
              COALESCE(SUM(pg_fee_paise), 0)                                    AS pg_fee,
              COALESCE(SUM(gst_on_pg_fee_paise), 0)                             AS gst_on_pg_fee,
              COALESCE(SUM(platform_fee_paise), 0)                              AS platform_fee,
              COALESCE(SUM(gst_on_platform_fee_paise), 0)                       AS gst_on_platform_fee,
              COALESCE(SUM(split_fee_paise), 0)                                 AS split_fee,
              COALESCE(SUM(gst_on_split_fee_paise), 0)                          AS gst_on_split_fee,
              COALESCE(SUM(creator_gross_paise), 0)                             AS creator_gross,
              COALESCE(SUM(refunded_paise), 0)                                  AS refunded,
              COALESCE(SUM(reserve_held_paise - reserve_released_paise), 0)      AS reserve_outstanding,
              COUNT(*)::int                                                      AS txn_count
         FROM redemptions
        WHERE period_id = $1 AND creator_id = $2`,
      [periodId, creatorId],
    );
    return (
      res.rows[0] ?? {
        creator_id: creatorId,
        gross: 0,
        pg_fee: 0,
        gst_on_pg_fee: 0,
        platform_fee: 0,
        gst_on_platform_fee: 0,
        split_fee: 0,
        gst_on_split_fee: 0,
        creator_gross: 0,
        refunded: 0,
        reserve_outstanding: 0,
        txn_count: 0,
      }
    );
  }

  private async queuePayout(
    uow: UnitOfWork,
    creatorId: string,
    statementId: string,
    amount: Paise,
    now: Date,
  ): Promise<string> {
    const payoutId = newId('payout');
    const inserted = await uow.query<{ id: string }>(
      `INSERT INTO payouts (id, creator_id, statement_id, amount_paise, status, idempotency_key, created_at)
       VALUES ($1,$2,$3,$4,'queued',$5,$6)
       ON CONFLICT (statement_id) DO NOTHING
       RETURNING id`,
      [payoutId, creatorId, statementId, amount, derivedIdempotencyKey('payout', statementId), now],
    );
    if (inserted.rowCount === 0) {
      const existing = await uow.query<{ id: string }>('SELECT id FROM payouts WHERE statement_id = $1', [statementId]);
      return existing.rows[0]!.id;
    }

    // Move the money out of the payable and into payout clearing: it is
    // instructed but not yet confirmed settled to the creator's own account.
    await this.ledger.post(
      uow,
      buildEntry({
        entryType: 'payout_instructed',
        occurredAt: now,
        referenceType: 'payout',
        referenceId: payoutId,
        idempotencyKey: derivedIdempotencyKey('payout-instructed', payoutId),
        postings: [debit('CREATOR_PAYABLE', amount, creatorId), credit('PAYOUT_CLEARING', amount, creatorId)],
        metadata: { statementId },
      }),
    );

    await uow.query(`INSERT INTO outbox (id, topic, payload) VALUES ($1, 'payout.dispatch', $2::jsonb)`, [
      newId('outbox'),
      JSON.stringify({ payoutId, creatorId, amount }),
    ]);

    return payoutId;
  }

  /** A creator's statement history. */
  async statementsFor(creatorId: string, limit = 24) {
    return this.db.transaction(
      async (uow) => {
        const res = await uow.query(
          `SELECT cs.*, sp.period_start, sp.period_end, sp.grace_end, sp.sequence
             FROM creator_statements cs
             JOIN settlement_periods sp ON sp.id = cs.period_id
            WHERE cs.creator_id = $1
            ORDER BY sp.sequence DESC
            LIMIT $2`,
          [creatorId, Math.min(limit, 100)],
        );
        return res.rows;
      },
      { readOnly: true },
    );
  }
}
