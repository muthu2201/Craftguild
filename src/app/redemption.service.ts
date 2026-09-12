import { derivedIdempotencyKey, newId } from '../domain/ids.js';
import { err } from '../domain/errors.js';
import type { Clock } from '../domain/clock.js';
import type { Paise } from '../domain/money/money.js';
import { buildEntry, compact, credit, debit } from '../domain/ledger/journal.js';
import { computeSplit } from '../domain/pricing/split.js';
import type { FeeSchedule } from '../domain/pricing/fee-schedule.js';
import type { Database, RedemptionRecord, UnitOfWork } from '../ports/repository.port.js';
import type { PostgresLedgerRepository } from '../adapters/postgres/ledger.repository.js';
import type { SettlementPeriodService } from './settlement-period.service.js';
import type { RiskService } from './risk.service.js';
import { LOCK_NS } from '../adapters/postgres/database.js';
import type { Logger } from '../observability/logger.js';

/**
 * Chapter unlock: spending credits on content.
 *
 * This is the moment the taxable supply happens (the coin sale was not a
 * supply). It must be exactly-once per (reader, chapter): the entitlement's
 * primary key guarantees it, and the wallet debit, the redemption row and the
 * ledger postings all land in the same transaction as that key.
 */

export interface UnlockResult {
  redemptionId: string;
  chapterId: string;
  creditsSpent: number;
  grossPaise: Paise;
  alreadyOwned: boolean;
  walletBalanceCredits: number;
}

export class RedemptionService {
  constructor(
    private readonly db: Database,
    private readonly ledger: PostgresLedgerRepository,
    private readonly periods: SettlementPeriodService,
    private readonly risk: RiskService,
    private readonly schedule: FeeSchedule,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async unlockChapter(uow: UnitOfWork, input: { userId: string; chapterId: string }): Promise<UnlockResult> {
    const chapterRes = await uow.query<{
      id: string;
      creator_id: string;
      price_credits: number;
      status: string;
      title: string;
    }>('SELECT id, creator_id, price_credits, status, title FROM chapters WHERE id = $1', [input.chapterId]);
    if (chapterRes.rowCount === 0) {
      throw err.notFound('redemption.chapter_not_found', 'chapter does not exist', { chapterId: input.chapterId });
    }
    const chapter = chapterRes.rows[0]!;
    if (chapter.status !== 'published') {
      throw err.precondition('redemption.chapter_unavailable', 'this chapter is not available');
    }

    // Existing entitlement short-circuits before any money moves.
    const owned = await uow.query<{ redemption_id: string }>(
      'SELECT redemption_id FROM entitlements WHERE user_id = $1 AND chapter_id = $2',
      [input.userId, input.chapterId],
    );
    if (owned.rowCount > 0) {
      const balance = await this.walletBalance(uow, input.userId);
      return {
        redemptionId: owned.rows[0]!.redemption_id,
        chapterId: input.chapterId,
        creditsSpent: 0,
        grossPaise: 0,
        alreadyOwned: true,
        walletBalanceCredits: balance,
      };
    }

    await this.risk.assertNotSelfPurchase(uow, input.userId, chapter.creator_id);

    const grossPaise = chapter.price_credits * this.schedule.creditValuePaise;
    if (grossPaise <= 0) {
      // Free chapter: grant the entitlement without a financial event.
      const freeRedemption = await this.grantFreeEntitlement(uow, input.userId, chapter.id, chapter.creator_id);
      return {
        redemptionId: freeRedemption,
        chapterId: input.chapterId,
        creditsSpent: 0,
        grossPaise: 0,
        alreadyOwned: false,
        walletBalanceCredits: await this.walletBalance(uow, input.userId),
      };
    }

    // Lock the wallet before reading it so two concurrent unlocks cannot both
    // observe a sufficient balance.
    await uow.advisoryLock(LOCK_NS.WALLET, input.userId);

    const walletRes = await uow.query<{ balance_credits: number }>(
      'SELECT balance_credits FROM credit_wallets WHERE user_id = $1 FOR UPDATE',
      [input.userId],
    );
    if (walletRes.rowCount === 0) {
      throw err.precondition('redemption.no_wallet', 'no credit wallet exists for this reader');
    }
    const balance = walletRes.rows[0]!.balance_credits;
    if (balance < chapter.price_credits) {
      throw err.precondition('redemption.insufficient_credits', 'not enough credits', {
        required: chapter.price_credits,
        available: balance,
      });
    }

    const now = this.clock.now();
    const period = await this.periods.currentPeriod(uow);
    const split = computeSplit({
      grossPaise,
      kind: 'chapter',
      schedule: this.schedule,
      pgFeeAlreadyBorneAtTopUp: true,
    });

    const redemptionId = newId('redemption');
    const idem = derivedIdempotencyKey('unlock', input.userId, input.chapterId);

    const inserted = await uow.query(
      `INSERT INTO redemptions
         (id, user_id, chapter_id, creator_id, period_id, kind, gross_paise, pg_fee_paise, gst_on_pg_fee_paise,
          platform_fee_paise, gst_on_platform_fee_paise, split_fee_paise, gst_on_split_fee_paise,
          creator_gross_paise, reserve_held_paise, idempotency_key, created_at)
       VALUES ($1,$2,$3,$4,$5,'chapter',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        redemptionId,
        input.userId,
        chapter.id,
        chapter.creator_id,
        period.id,
        split.gross,
        split.pgFee,
        split.gstOnPgFee,
        split.platformFee,
        split.gstOnPlatformFee,
        split.splitFee,
        split.gstOnSplitFee,
        split.creatorGross,
        split.reserveHeld,
        idem,
        now,
      ],
    );
    if (inserted.rowCount === 0) {
      // Another transaction won the race for this exact (reader, chapter).
      const existing = await uow.query<{ id: string }>('SELECT id FROM redemptions WHERE idempotency_key = $1', [idem]);
      return {
        redemptionId: existing.rows[0]?.id ?? redemptionId,
        chapterId: input.chapterId,
        creditsSpent: 0,
        grossPaise: 0,
        alreadyOwned: true,
        walletBalanceCredits: balance,
      };
    }

    await this.consumeCreditsFifo(uow, input.userId, chapter.price_credits, redemptionId);

    await uow.query(
      `INSERT INTO entitlements (user_id, chapter_id, redemption_id, granted_at) VALUES ($1, $2, $3, $4)`,
      [input.userId, chapter.id, redemptionId, now],
    );

    await uow.query('UPDATE creators SET lifetime_gross_paise = lifetime_gross_paise + $2 WHERE id = $1', [
      chapter.creator_id,
      split.gross,
    ]);

    // The redemption unwinds the coin liability into the creator's entitlement,
    // the platform's commission and the recovery of the aggregator's fees.
    await this.ledger.post(
      uow,
      buildEntry({
        entryType: 'chapter_redemption',
        occurredAt: now,
        referenceType: 'redemption',
        referenceId: redemptionId,
        idempotencyKey: idem,
        postings: compact([
          debit('CREDIT_LIABILITY', split.gross),
          credit('CREATOR_PAYABLE', split.creatorGross, chapter.creator_id),
          split.platformFee > 0 ? credit('PLATFORM_FEE_REVENUE', split.platformFee) : null,
          split.gstOnPlatformFee > 0 ? credit('GST_OUTPUT_PAYABLE', split.gstOnPlatformFee) : null,
          split.pgFee + split.gstOnPgFee > 0
            ? credit('PG_FEE_EXPENSE', split.pgFee + split.gstOnPgFee, null, 'processing pass-through recovery')
            : null,
          split.splitFee + split.gstOnSplitFee > 0
            ? credit('SPLIT_FEE_EXPENSE', split.splitFee + split.gstOnSplitFee, null, 'split fee recovery')
            : null,
        ]),
        metadata: { chapterId: chapter.id, periodId: period.id, credits: chapter.price_credits },
      }),
    );

    if (split.reserveHeld > 0) {
      await this.ledger.post(
        uow,
        buildEntry({
          entryType: 'reserve_held',
          occurredAt: now,
          referenceType: 'redemption',
          referenceId: redemptionId,
          idempotencyKey: derivedIdempotencyKey('reserve', redemptionId),
          postings: [
            debit('CREATOR_PAYABLE', split.reserveHeld, chapter.creator_id),
            credit('RESERVE_HOLDBACK', split.reserveHeld, chapter.creator_id),
          ],
        }),
      );
    }

    return {
      redemptionId,
      chapterId: chapter.id,
      creditsSpent: chapter.price_credits,
      grossPaise: split.gross,
      alreadyOwned: false,
      walletBalanceCredits: balance - chapter.price_credits,
    };
  }

  /** Spend credits oldest-lot-first so expiry and breakage stay deterministic. */
  private async consumeCreditsFifo(
    uow: UnitOfWork,
    userId: string,
    credits: number,
    referenceId: string,
  ): Promise<void> {
    const lots = await uow.query<{ id: string; credits_remaining: number }>(
      `SELECT id, credits_remaining FROM credit_lots
        WHERE user_id = $1 AND credits_remaining > 0 AND expired = FALSE
        ORDER BY granted_at ASC, id ASC
        FOR UPDATE`,
      [userId],
    );

    let outstanding = credits;
    for (const lot of lots.rows) {
      if (outstanding === 0) break;
      const take = Math.min(outstanding, lot.credits_remaining);
      await uow.query('UPDATE credit_lots SET credits_remaining = credits_remaining - $2 WHERE id = $1', [
        lot.id,
        take,
      ]);
      outstanding -= take;
    }

    if (outstanding > 0) {
      throw err.precondition('redemption.insufficient_lots', 'credit lots do not cover the wallet balance', {
        shortfall: outstanding,
      });
    }

    const updated = await uow.query(
      `UPDATE credit_wallets
          SET balance_credits = balance_credits - $2,
              lifetime_spent = lifetime_spent + $2,
              version = version + 1,
              updated_at = now()
        WHERE user_id = $1 AND balance_credits >= $2`,
      [userId, credits],
    );
    if (updated.rowCount !== 1) {
      throw err.precondition('redemption.insufficient_credits', 'not enough credits');
    }

    await uow.query(
      `INSERT INTO credit_movements (user_id, delta, reason, reference_id) VALUES ($1, $2, 'redeem', $3)`,
      [userId, -credits, referenceId],
    );
  }

  private async grantFreeEntitlement(
    uow: UnitOfWork,
    userId: string,
    chapterId: string,
    creatorId: string,
  ): Promise<string> {
    const now = this.clock.now();
    const period = await this.periods.currentPeriod(uow);
    const redemptionId = newId('redemption');
    const idem = derivedIdempotencyKey('unlock', userId, chapterId);

    // A zero-value redemption row keeps read history complete without touching
    // money; the split columns are all zero and no ledger entry is made.
    await uow.query(
      `INSERT INTO redemptions
         (id, user_id, chapter_id, creator_id, period_id, kind, gross_paise, pg_fee_paise, gst_on_pg_fee_paise,
          platform_fee_paise, gst_on_platform_fee_paise, split_fee_paise, gst_on_split_fee_paise,
          creator_gross_paise, reserve_held_paise, idempotency_key, created_at)
       VALUES ($1,$2,$3,$4,$5,'chapter',1,0,0,0,0,0,0,1,0,$6,$7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [redemptionId, userId, chapterId, creatorId, period.id, idem, now],
    );
    await uow.query(
      `INSERT INTO entitlements (user_id, chapter_id, redemption_id, granted_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [userId, chapterId, redemptionId, now],
    );
    return redemptionId;
  }

  private async walletBalance(uow: UnitOfWork, userId: string): Promise<number> {
    const res = await uow.query<{ balance_credits: number }>(
      'SELECT balance_credits FROM credit_wallets WHERE user_id = $1',
      [userId],
    );
    return res.rows[0]?.balance_credits ?? 0;
  }

  async loadRedemption(uow: UnitOfWork, redemptionId: string, forUpdate = false): Promise<RedemptionRecord> {
    const res = await uow.query<RedemptionRow>(
      `SELECT * FROM redemptions WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [redemptionId],
    );
    if (res.rowCount === 0) {
      throw err.notFound('redemption.not_found', 'redemption does not exist', { redemptionId });
    }
    return mapRedemption(res.rows[0]!);
  }

  async listEntitlements(userId: string, limit = 100, offset = 0) {
    return this.db.transaction(
      async (uow) => {
        const res = await uow.query(
          `SELECT e.chapter_id, e.granted_at, ch.title, ch.sequence, w.title AS work_title, w.id AS work_id
             FROM entitlements e
             JOIN chapters ch ON ch.id = e.chapter_id
             JOIN works w ON w.id = ch.work_id
            WHERE e.user_id = $1 AND e.revoked_at IS NULL
            ORDER BY e.granted_at DESC
            LIMIT $2 OFFSET $3`,
          [userId, Math.min(limit, 200), offset],
        );
        return res.rows;
      },
      { readOnly: true },
    );
  }
}

export interface RedemptionRow {
  id: string;
  user_id: string;
  chapter_id: string | null;
  creator_id: string;
  period_id: string;
  kind: 'chapter' | 'tip';
  gross_paise: number;
  pg_fee_paise: number;
  gst_on_pg_fee_paise: number;
  platform_fee_paise: number;
  gst_on_platform_fee_paise: number;
  split_fee_paise: number;
  gst_on_split_fee_paise: number;
  creator_gross_paise: number;
  reserve_held_paise: number;
  reserve_released_paise: number;
  refunded_paise: number;
  status: RedemptionRecord['status'];
  funding_order_id: string | null;
  created_at: Date;
}

export function mapRedemption(r: RedemptionRow): RedemptionRecord {
  return {
    id: r.id,
    userId: r.user_id,
    chapterId: r.chapter_id,
    creatorId: r.creator_id,
    periodId: r.period_id,
    kind: r.kind,
    grossPaise: r.gross_paise,
    pgFeePaise: r.pg_fee_paise,
    gstOnPgFeePaise: r.gst_on_pg_fee_paise,
    platformFeePaise: r.platform_fee_paise,
    gstOnPlatformFeePaise: r.gst_on_platform_fee_paise,
    splitFeePaise: r.split_fee_paise,
    gstOnSplitFeePaise: r.gst_on_split_fee_paise,
    creatorGrossPaise: r.creator_gross_paise,
    reserveHeldPaise: r.reserve_held_paise,
    reserveReleasedPaise: r.reserve_released_paise,
    refundedPaise: r.refunded_paise,
    status: r.status,
    fundingOrderId: r.funding_order_id,
    createdAt: r.created_at,
  };
}
