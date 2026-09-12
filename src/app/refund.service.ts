import { derivedIdempotencyKey, newId } from '../domain/ids.js';
import { err } from '../domain/errors.js';
import type { Clock } from '../domain/clock.js';
import { min, subtract, sum, type Paise } from '../domain/money/money.js';
import { buildEntry, compact, credit, debit } from '../domain/ledger/journal.js';
import type { Database, RedemptionRecord, UnitOfWork } from '../ports/repository.port.js';
import type { PaymentPort } from '../ports/payment.port.js';
import type { PostgresLedgerRepository } from '../adapters/postgres/ledger.repository.js';
import type { SettlementPeriodService } from './settlement-period.service.js';
import { mapRedemption, type RedemptionRow } from './redemption.service.js';
import { LOCK_NS } from '../adapters/postgres/database.js';
import type { Logger } from '../observability/logger.js';

/**
 * Refunds and chargebacks.
 *
 * A refund inside the grace window unwinds the original split exactly: the
 * creator's share is debited back, the platform's commission and its GST are
 * reversed, and the aggregator-fee recovery is given back. After finalisation
 * the creator's money is gone to their own bank account, so the reserve is the
 * only recourse and anything beyond it is a platform loss — which is precisely
 * why the reserve exists.
 */

export type RefundMode = 'to_credits' | 'to_source';

export interface RefundRequest {
  redemptionId: string;
  mode: RefundMode;
  reason: string;
  requestedBy: string;
  idempotencyKey: string;
}

export interface RefundOutcome {
  refundId: string;
  amountPaise: Paise;
  mode: RefundMode;
  status: string;
  creditsRestored: number;
}

export class RefundService {
  constructor(
    private readonly db: Database,
    private readonly payments: PaymentPort,
    private readonly ledger: PostgresLedgerRepository,
    private readonly periods: SettlementPeriodService,
    private readonly clock: Clock,
    private readonly creditValuePaise: number,
    private readonly logger: Logger,
  ) {}

  async refundRedemption(uow: UnitOfWork, req: RefundRequest): Promise<RefundOutcome> {
    const redemptionRes = await uow.query<RedemptionRow>('SELECT * FROM redemptions WHERE id = $1 FOR UPDATE', [
      req.redemptionId,
    ]);
    if (redemptionRes.rowCount === 0) {
      throw err.notFound('refund.redemption_not_found', 'redemption does not exist');
    }
    const redemption = mapRedemption(redemptionRes.rows[0]!);

    if (redemption.status === 'refunded') {
      const existing = await uow.query<{ id: string; amount_paise: number; mode: RefundMode; status: string }>(
        'SELECT id, amount_paise, mode, status FROM refunds WHERE redemption_id = $1 ORDER BY created_at LIMIT 1',
        [redemption.id],
      );
      const row = existing.rows[0];
      if (row) {
        return {
          refundId: row.id,
          amountPaise: row.amount_paise,
          mode: row.mode,
          status: row.status,
          creditsRestored: 0,
        };
      }
    }
    if (redemption.status === 'charged_back') {
      throw err.conflict('refund.charged_back', 'this transaction is already subject to a chargeback');
    }

    const period = await this.periods.byId(uow, redemption.periodId);
    if (!period) throw err.internal('refund.period_missing', 'redemption has no settlement period');

    const now = this.clock.now();
    const withinGrace = period.status !== 'finalised' && now < period.graceEnd;

    await uow.advisoryLock(LOCK_NS.CREATOR, redemption.creatorId);

    const refundable = subtract(redemption.grossPaise, redemption.refundedPaise);
    if (refundable <= 0) throw err.conflict('refund.nothing_refundable', 'this transaction is fully refunded');

    const refundId = newId('refund');
    await uow.query(
      `INSERT INTO refunds (id, redemption_id, creator_id, mode, amount_paise, reason, status, idempotency_key, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        refundId,
        redemption.id,
        redemption.creatorId,
        req.mode,
        refundable,
        req.reason.slice(0, 500),
        req.mode === 'to_credits' ? 'succeeded' : 'pending',
        req.idempotencyKey,
        req.requestedBy,
      ],
    );

    // Release any reserve still held on this transaction first, so the creator
    // payable can absorb the full reversal.
    const reserveOutstanding = subtract(redemption.reserveHeldPaise, redemption.reserveReleasedPaise);
    if (reserveOutstanding > 0) {
      await this.ledger.post(
        uow,
        buildEntry({
          entryType: 'reserve_released',
          occurredAt: now,
          referenceType: 'refund',
          referenceId: refundId,
          idempotencyKey: derivedIdempotencyKey('reserve-release-refund', refundId),
          postings: [
            debit('RESERVE_HOLDBACK', reserveOutstanding, redemption.creatorId),
            credit('CREATOR_PAYABLE', reserveOutstanding, redemption.creatorId),
          ],
        }),
      );
      await uow.query('UPDATE redemptions SET reserve_released_paise = reserve_held_paise WHERE id = $1', [
        redemption.id,
      ]);
    }

    // Unwind the split. The creator's share can go negative here: that is a
    // genuine claw-back carried against their next settlement, not an error.
    const creditTarget = req.mode === 'to_credits' ? 'CREDIT_LIABILITY' : 'REFUND_LIABILITY';
    await this.ledger.post(
      uow,
      buildEntry({
        entryType: req.mode === 'to_credits' ? 'refund_to_credits' : 'refund_to_source',
        occurredAt: now,
        referenceType: 'refund',
        referenceId: refundId,
        idempotencyKey: derivedIdempotencyKey('refund', refundId),
        postings: compact([
          debit('CREATOR_PAYABLE', redemption.creatorGrossPaise, redemption.creatorId),
          redemption.platformFeePaise > 0 ? debit('PLATFORM_FEE_REVENUE', redemption.platformFeePaise) : null,
          redemption.gstOnPlatformFeePaise > 0 ? debit('GST_OUTPUT_PAYABLE', redemption.gstOnPlatformFeePaise) : null,
          redemption.pgFeePaise + redemption.gstOnPgFeePaise > 0
            ? debit('PG_FEE_EXPENSE', redemption.pgFeePaise + redemption.gstOnPgFeePaise, null, 'pass-through reversal')
            : null,
          redemption.splitFeePaise + redemption.gstOnSplitFeePaise > 0
            ? debit('SPLIT_FEE_EXPENSE', redemption.splitFeePaise + redemption.gstOnSplitFeePaise, null, 'split fee reversal')
            : null,
          credit(creditTarget, refundable),
        ]),
        metadata: { redemptionId: redemption.id, withinGrace, mode: req.mode },
      }),
    );

    await uow.query(
      `UPDATE redemptions SET refunded_paise = refunded_paise + $2, status = 'refunded' WHERE id = $1`,
      [redemption.id, refundable],
    );
    await uow.query('UPDATE creators SET lifetime_gross_paise = GREATEST(0, lifetime_gross_paise - $2) WHERE id = $1', [
      redemption.creatorId,
      refundable,
    ]);

    let creditsRestored = 0;
    if (req.mode === 'to_credits') {
      creditsRestored = Math.round(refundable / this.creditValuePaise);
      await this.restoreCredits(uow, redemption, creditsRestored, refundId, now);
      await uow.query('UPDATE refunds SET settled_at = $2 WHERE id = $1', [refundId, now]);
    } else {
      await this.enqueueSourceRefund(uow, redemption, refundId, refundable, req.reason);
    }

    // Revoke the entitlement so the reader loses access to what they returned.
    if (redemption.chapterId) {
      await uow.query('UPDATE entitlements SET revoked_at = $3 WHERE user_id = $1 AND chapter_id = $2', [
        redemption.userId,
        redemption.chapterId,
        now,
      ]);
    }

    return {
      refundId,
      amountPaise: refundable,
      mode: req.mode,
      status: req.mode === 'to_credits' ? 'succeeded' : 'pending',
      creditsRestored,
    };
  }

  private async restoreCredits(
    uow: UnitOfWork,
    redemption: RedemptionRecord,
    credits: number,
    refundId: string,
    now: Date,
  ): Promise<void> {
    if (credits <= 0) return;
    await uow.advisoryLock(LOCK_NS.WALLET, redemption.userId);

    const lotId = newId('order');
    await uow.query(
      `INSERT INTO credit_lots (id, user_id, order_id, credits_granted, credits_remaining, paise_per_credit, granted_at, expires_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7)`,
      [
        lotId,
        redemption.userId,
        refundId,
        credits,
        this.creditValuePaise,
        now,
        new Date(now.getTime() + 1095 * 86_400_000),
      ],
    );
    await uow.query(
      `UPDATE credit_wallets
          SET balance_credits = balance_credits + $2, lifetime_spent = GREATEST(0, lifetime_spent - $2),
              version = version + 1, updated_at = now()
        WHERE user_id = $1`,
      [redemption.userId, credits],
    );
    await uow.query(
      `INSERT INTO credit_movements (user_id, lot_id, delta, reason, reference_id)
       VALUES ($1, $2, $3, 'refund', $4)`,
      [redemption.userId, lotId, credits, refundId],
    );
  }

  /**
   * A refund to the original instrument must go back through the aggregator
   * (an RBI PA rule). The call happens outside this transaction, driven by the
   * outbox, so a PA outage cannot roll back the ledger reversal.
   */
  private async enqueueSourceRefund(
    uow: UnitOfWork,
    redemption: RedemptionRecord,
    refundId: string,
    amount: Paise,
    reason: string,
  ): Promise<void> {
    const fundingOrderId = redemption.fundingOrderId ?? (await this.findFundingOrder(uow, redemption));
    if (!fundingOrderId) {
      throw err.precondition(
        'refund.no_funding_order',
        'cannot refund to source: the original payment for these credits is not identifiable',
      );
    }
    const paymentRes = await uow.query<{ id: string; provider_payment_id: string }>(
      `SELECT id, provider_payment_id FROM payments WHERE order_id = $1 AND status = 'success' LIMIT 1`,
      [fundingOrderId],
    );
    if (paymentRes.rowCount === 0) {
      throw err.precondition('refund.no_captured_payment', 'the funding order has no captured payment');
    }

    await uow.query('UPDATE refunds SET order_id = $2, payment_id = $3 WHERE id = $1', [
      refundId,
      fundingOrderId,
      paymentRes.rows[0]!.id,
    ]);

    await uow.query(
      `INSERT INTO outbox (id, topic, payload) VALUES ($1, 'refund.dispatch', $2::jsonb)`,
      [
        newId('outbox'),
        JSON.stringify({
          refundId,
          orderId: fundingOrderId,
          providerPaymentId: paymentRes.rows[0]!.provider_payment_id,
          amount,
          reason: reason.slice(0, 100),
        }),
      ],
    );
  }

  /**
   * Mark `amount` of a creator's outstanding holdback as consumed, oldest
   * redemption first, so `reserve_held - reserve_released` across redemptions
   * keeps matching the RESERVE_HOLDBACK control account to the paise.
   */
  private async consumeReserveAgainstRedemptions(
    uow: UnitOfWork,
    creatorId: string,
    amount: Paise,
  ): Promise<void> {
    let outstanding = amount;
    const rows = await uow.query<{ id: string; available: number }>(
      `SELECT id, (reserve_held_paise - reserve_released_paise) AS available
         FROM redemptions
        WHERE creator_id = $1 AND reserve_held_paise > reserve_released_paise
        ORDER BY created_at ASC, id ASC
        FOR UPDATE`,
      [creatorId],
    );

    for (const row of rows.rows) {
      if (outstanding <= 0) break;
      const take = min(row.available, outstanding);
      await uow.query('UPDATE redemptions SET reserve_released_paise = reserve_released_paise + $2 WHERE id = $1', [
        row.id,
        take,
      ]);
      outstanding = subtract(outstanding, take);
    }

    if (outstanding > 0) {
      throw err.internal(
        'refund.reserve_subledger_mismatch',
        'the ledger holds more reserve than the redemptions account for',
        { creatorId, shortfall: outstanding },
      );
    }
  }

  private async findFundingOrder(uow: UnitOfWork, redemption: RedemptionRecord): Promise<string | null> {
    // Credits are fungible; attribute the refund to the reader's most recent
    // paid top-up that is large enough to carry it.
    const res = await uow.query<{ id: string }>(
      `SELECT o.id FROM orders o
        WHERE o.user_id = $1 AND o.kind = 'credit_topup' AND o.status = 'paid'
          AND o.amount_paise >= $2
        ORDER BY o.paid_at DESC LIMIT 1`,
      [redemption.userId, redemption.grossPaise],
    );
    return res.rows[0]?.id ?? null;
  }

  /** Called by the outbox worker after the aggregator accepts the refund. */
  async markRefundDispatched(refundId: string, providerRefundId: string, status: string): Promise<void> {
    await this.db.transaction(async (uow) => {
      await uow.query(
        `UPDATE refunds SET provider_refund_id = $2, status = $3 WHERE id = $1 AND status IN ('pending','processing')`,
        [refundId, providerRefundId, status === 'success' ? 'processing' : 'processing'],
      );
    });
  }

  /** Called when the aggregator confirms the money left escrow. */
  async settleSourceRefund(uow: UnitOfWork, refundId: string, settledAt: Date): Promise<boolean> {
    const res = await uow.query<{ amount_paise: number; status: string }>(
      `SELECT amount_paise, status FROM refunds WHERE id = $1 FOR UPDATE`,
      [refundId],
    );
    if (res.rowCount === 0) return false;
    const row = res.rows[0]!;
    if (row.status === 'succeeded') return false;

    await uow.query(`UPDATE refunds SET status = 'succeeded', settled_at = $2 WHERE id = $1`, [refundId, settledAt]);
    await this.ledger.post(
      uow,
      buildEntry({
        entryType: 'refund_settled',
        occurredAt: settledAt,
        referenceType: 'refund',
        referenceId: refundId,
        idempotencyKey: derivedIdempotencyKey('refund-settled', refundId),
        postings: [
          debit('REFUND_LIABILITY', row.amount_paise),
          credit('PA_ESCROW_RECEIVABLE', row.amount_paise),
        ],
      }),
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // Chargebacks
  // -------------------------------------------------------------------------

  /**
   * A chargeback lands on the original payment, potentially long after the
   * creator's share was settled out. Recover from the creator's reserve first;
   * absorb whatever is left as a platform loss.
   */
  async applyChargeback(
    uow: UnitOfWork,
    input: { providerDisputeId: string; providerPaymentId: string; amount: Paise; reason: string; occurredAt: Date },
  ): Promise<{ recovered: Paise; absorbed: Paise; chargebackId: string } | null> {
    const paymentRes = await uow.query<{ id: string; order_id: string; amount_paise: number }>(
      'SELECT id, order_id, amount_paise FROM payments WHERE provider_payment_id = $1 FOR UPDATE',
      [input.providerPaymentId],
    );
    if (paymentRes.rowCount === 0) {
      throw err.notFound('chargeback.payment_not_found', 'no payment matches this dispute');
    }
    const payment = paymentRes.rows[0]!;

    const chargebackId = newId('chargeback');
    const inserted = await uow.query(
      `INSERT INTO chargebacks (id, payment_id, order_id, amount_paise, provider_dispute_id, reason, status)
       VALUES ($1,$2,$3,$4,$5,$6,'open')
       ON CONFLICT (provider_dispute_id) DO NOTHING`,
      [chargebackId, payment.id, payment.order_id, input.amount, input.providerDisputeId, input.reason.slice(0, 500)],
    );
    if (inserted.rowCount === 0) return null; // already recorded

    // Find the creator(s) whose redemptions this payment funded.
    const affected = await uow.query<{ creator_id: string; gross: number }>(
      `SELECT r.creator_id, SUM(r.gross_paise) AS gross
         FROM redemptions r
        WHERE r.funding_order_id = $1
           OR r.id IN (
             SELECT r2.id FROM redemptions r2
              WHERE r2.user_id = (SELECT user_id FROM orders WHERE id = $1)
                AND r2.created_at >= (SELECT paid_at FROM orders WHERE id = $1)
           )
        GROUP BY r.creator_id
        ORDER BY gross DESC`,
      [payment.order_id],
    );

    let outstanding = input.amount;
    let recovered = 0;

    for (const row of affected.rows) {
      if (outstanding <= 0) break;
      await uow.advisoryLock(LOCK_NS.CREATOR, row.creator_id);
      const reserve = await this.ledger.accountBalance(uow, 'RESERVE_HOLDBACK', row.creator_id);
      if (reserve <= 0) continue;

      const take = min(reserve, outstanding);
      await this.ledger.post(
        uow,
        buildEntry({
          entryType: 'chargeback_recovered_from_reserve',
          occurredAt: input.occurredAt,
          referenceType: 'chargeback',
          referenceId: chargebackId,
          idempotencyKey: derivedIdempotencyKey('cb-reserve', chargebackId, row.creator_id),
          postings: [
            debit('RESERVE_HOLDBACK', take, row.creator_id),
            credit('REFUND_LIABILITY', take),
          ],
          metadata: { creatorId: row.creator_id },
        }),
      );

      // The ledger's reserve balance and the redemptions that fund it are two
      // views of the same money. Consuming reserve in the ledger without
      // marking it consumed on the redemptions would leave the sub-ledger
      // claiming a holdback that no longer exists.
      await this.consumeReserveAgainstRedemptions(uow, row.creator_id, take);

      recovered = sum(recovered, take);
      outstanding = subtract(outstanding, take);
    }

    if (outstanding > 0) {
      await this.ledger.post(
        uow,
        buildEntry({
          entryType: 'chargeback_absorbed',
          occurredAt: input.occurredAt,
          referenceType: 'chargeback',
          referenceId: chargebackId,
          idempotencyKey: derivedIdempotencyKey('cb-absorbed', chargebackId),
          postings: [debit('CHARGEBACK_EXPENSE', outstanding), credit('REFUND_LIABILITY', outstanding)],
        }),
      );
    }

    // The disputed money leaves escrow immediately.
    await this.ledger.post(
      uow,
      buildEntry({
        entryType: 'refund_settled',
        occurredAt: input.occurredAt,
        referenceType: 'chargeback',
        referenceId: chargebackId,
        idempotencyKey: derivedIdempotencyKey('cb-settled', chargebackId),
        postings: [debit('REFUND_LIABILITY', input.amount), credit('PA_ESCROW_RECEIVABLE', input.amount)],
      }),
    );

    await uow.query(
      `UPDATE chargebacks SET recovered_from_reserve_paise = $2, absorbed_paise = $3, status = 'accepted', resolved_at = $4
        WHERE id = $1`,
      [chargebackId, recovered, outstanding, input.occurredAt],
    );
    await uow.query('UPDATE payments SET chargeback_paise = chargeback_paise + $2 WHERE id = $1', [
      payment.id,
      input.amount,
    ]);
    await uow.query(
      `UPDATE redemptions SET status = 'charged_back'
        WHERE funding_order_id = $1 AND status = 'active'`,
      [payment.order_id],
    );

    return { recovered, absorbed: outstanding, chargebackId };
  }
}
