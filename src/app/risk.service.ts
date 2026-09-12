import { err } from '../domain/errors.js';
import type { Paise } from '../domain/money/money.js';
import type { UnitOfWork } from '../ports/repository.port.js';
import type { Logger } from '../observability/logger.js';

/**
 * Fraud and abuse controls (blueprint Part 12).
 *
 * The attack that matters here is refund/payout laundering: a creator buys
 * their own content with stolen cards and extracts the payout before the
 * chargeback lands. Velocity caps, self-purchase blocking, a delayed first
 * payout and the settlement reserve are the four defences; this service owns
 * the first two.
 */
export interface RiskLimits {
  readonly maxTopUpsPerHour: number;
  readonly maxTopUpValuePerDay: Paise;
  readonly maxUnlocksPerMinute: number;
  /** Share of a creator's gross that may come from one payer before it is flagged. */
  readonly concentrationWarnPpm: number;
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxTopUpsPerHour: 10,
  maxTopUpValuePerDay: 50_000_00,
  maxUnlocksPerMinute: 120,
  concentrationWarnPpm: 600_000, // 60%
};

export class RiskService {
  constructor(
    private readonly limits: RiskLimits,
    private readonly logger: Logger,
  ) {}

  async assertTopUpAllowed(uow: UnitOfWork, userId: string, amount: Paise, now: Date): Promise<void> {
    const res = await uow.query<{ hourly_count: number; daily_value: number }>(
      // Every placeholder is cast explicitly: Postgres cannot infer the type of
      // a bare parameter on the left of an interval subtraction.
      `SELECT
         COUNT(*) FILTER (WHERE created_at > $2::timestamptz - interval '1 hour')::int AS hourly_count,
         COALESCE(SUM(amount_paise) FILTER (
           WHERE created_at > $2::timestamptz - interval '1 day' AND status = 'paid'
         ), 0) AS daily_value
       FROM orders
       WHERE user_id = $1 AND created_at > $2::timestamptz - interval '1 day'`,
      [userId, now],
    );
    const row = res.rows[0] ?? { hourly_count: 0, daily_value: 0 };

    if (row.hourly_count >= this.limits.maxTopUpsPerHour) {
      await this.record(uow, { userId, signal: 'topup_velocity', severity: 'block', details: { count: row.hourly_count } });
      throw err.rateLimited('risk.topup_velocity', 'too many payment attempts in the last hour', {
        limit: this.limits.maxTopUpsPerHour,
      });
    }

    if (row.daily_value + amount > this.limits.maxTopUpValuePerDay) {
      await this.record(uow, {
        userId,
        signal: 'topup_daily_value',
        severity: 'block',
        details: { dailyValue: row.daily_value, attempted: amount },
      });
      throw err.rateLimited('risk.daily_value_cap', 'daily payment value limit reached', {
        limitPaise: this.limits.maxTopUpValuePerDay,
      });
    }
  }

  /** A reader must not be the creator whose chapter they are unlocking. */
  async assertNotSelfPurchase(uow: UnitOfWork, userId: string, creatorId: string): Promise<void> {
    const res = await uow.query<{ user_id: string }>('SELECT user_id FROM creators WHERE id = $1', [creatorId]);
    if (res.rows[0]?.user_id === userId) {
      await this.record(uow, { userId, creatorId, signal: 'self_purchase', severity: 'block', details: {} });
      throw err.forbidden('risk.self_purchase', 'a creator cannot purchase their own content');
    }
  }

  /**
   * Flag a creator whose earnings concentrate in a single payer. Advisory only:
   * it never blocks a legitimate superfan, it raises a signal for review and
   * withholds automatic payout acceleration.
   */
  async evaluatePayerConcentration(uow: UnitOfWork, creatorId: string): Promise<void> {
    const res = await uow.query<{ total: number; top_payer: number }>(
      `WITH per_payer AS (
         SELECT user_id, SUM(gross_paise) AS gross
           FROM redemptions
          WHERE creator_id = $1 AND created_at > now() - interval '30 days'
          GROUP BY user_id
       )
       SELECT COALESCE(SUM(gross), 0) AS total, COALESCE(MAX(gross), 0) AS top_payer FROM per_payer`,
      [creatorId],
    );
    const row = res.rows[0];
    if (!row || row.total <= 0) return;

    const concentrationPpm = Math.round((row.top_payer / row.total) * 1_000_000);
    if (concentrationPpm >= this.limits.concentrationWarnPpm && row.total > 5_000_00) {
      await this.record(uow, {
        creatorId,
        signal: 'payer_concentration',
        severity: 'warn',
        details: { concentrationPpm, thirtyDayGross: row.total },
      });
    }
  }

  async record(
    uow: UnitOfWork,
    input: {
      userId?: string;
      creatorId?: string;
      signal: string;
      severity: 'info' | 'warn' | 'block';
      details: Record<string, unknown>;
    },
  ): Promise<void> {
    await uow.query(
      `INSERT INTO risk_signals (user_id, creator_id, signal, severity, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [input.userId ?? null, input.creatorId ?? null, input.signal, input.severity, JSON.stringify(input.details)],
    );
    if (input.severity !== 'info') {
      this.logger.warn({ ...input }, 'risk signal raised');
    }
  }

  /** Creators with an unresolved blocking signal must not be paid out automatically. */
  async hasBlockingSignal(uow: UnitOfWork, creatorId: string): Promise<boolean> {
    const res = await uow.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM risk_signals
        WHERE creator_id = $1 AND severity = 'block' AND created_at > now() - interval '30 days'`,
      [creatorId],
    );
    return (res.rows[0]?.count ?? 0) > 0;
  }
}
