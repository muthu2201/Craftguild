import { newId, derivedIdempotencyKey } from '../domain/ids.js';
import { err } from '../domain/errors.js';
import { addDays, type Clock } from '../domain/clock.js';
import { applyRateHalfUp, sum, subtract, type Paise } from '../domain/money/money.js';
import { buildEntry, compact, credit, debit } from '../domain/ledger/journal.js';
import { computeSplit } from '../domain/pricing/split.js';
import { bundleBySku, type FeeSchedule } from '../domain/pricing/fee-schedule.js';
import type { Database, OrderRecord, UnitOfWork } from '../ports/repository.port.js';
import type { PaymentPort, PaymentResult } from '../ports/payment.port.js';
import type { PostgresLedgerRepository } from '../adapters/postgres/ledger.repository.js';
import type { SettlementPeriodService } from './settlement-period.service.js';
import type { Logger } from '../observability/logger.js';
import { LOCK_NS } from '../adapters/postgres/database.js';
import { RiskService } from './risk.service.js';

/**
 * Closed-loop credits ("coins") and the money-in path.
 *
 * Selling coins is not a supply of goods or services (CBIC Circular
 * 243/37/2024), so no GST arises at top-up; it arises at redemption, on the
 * underlying supply. That is why the top-up entry books a liability, not
 * revenue, and why nothing taxable is recognised here.
 */

export interface CreateTopUpInput {
  userId: string;
  sku: string;
  idempotencyKey: string;
  customer: { email: string; phone: string; name?: string };
}

export interface CreateTopUpResult {
  orderId: string;
  amountPaise: Paise;
  credits: number;
  paymentSessionId: string;
  providerOrderId: string;
  expiresAt: string | null;
  status: OrderRecord['status'];
}

export interface CreateTipInput {
  userId: string;
  creatorId: string;
  amountPaise: Paise;
  idempotencyKey: string;
  customer: { email: string; phone: string; name?: string };
  message?: string;
}

export class CreditsService {
  constructor(
    private readonly db: Database,
    private readonly payments: PaymentPort,
    private readonly ledger: PostgresLedgerRepository,
    private readonly periods: SettlementPeriodService,
    private readonly risk: RiskService,
    private readonly schedule: FeeSchedule,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly orderTtlMinutes = 30,
  ) {}

  // -------------------------------------------------------------------------
  // Order creation
  // -------------------------------------------------------------------------

  async createTopUpOrder(input: CreateTopUpInput, uow: UnitOfWork): Promise<CreateTopUpResult> {
    const bundle = bundleBySku(this.schedule, input.sku);
    if (!bundle) throw err.validation('credits.unknown_bundle', 'no such credit bundle', { sku: input.sku });

    await this.risk.assertTopUpAllowed(uow, input.userId, bundle.pricePaise, this.clock.now());

    const orderId = newId('order');
    const credits = bundle.credits + bundle.bonusCredits;
    const expiresAt = new Date(this.clock.now().getTime() + this.orderTtlMinutes * 60_000);

    await uow.query(
      `INSERT INTO orders (id, user_id, kind, sku, amount_paise, credits, status, idempotency_key, expires_at)
       VALUES ($1, $2, 'credit_topup', $3, $4, $5, 'created', $6, $7)`,
      [orderId, input.userId, bundle.sku, bundle.pricePaise, credits, input.idempotencyKey, expiresAt],
    );

    const ref = await this.payments.createOrder({
      orderId,
      amount: bundle.pricePaise,
      currency: 'INR',
      customer: {
        customerId: input.userId,
        email: input.customer.email,
        phone: input.customer.phone,
        ...(input.customer.name ? { name: input.customer.name } : {}),
      },
      idempotencyKey: input.idempotencyKey,
      note: `CraftGuild ${bundle.label}`,
      expiresAt,
    });

    await uow.query(
      `UPDATE orders SET provider_order_id = $2, payment_session_id = $3, status = 'pending' WHERE id = $1`,
      [orderId, ref.providerOrderId, ref.paymentSessionId],
    );

    return {
      orderId,
      amountPaise: bundle.pricePaise,
      credits,
      paymentSessionId: ref.paymentSessionId,
      providerOrderId: ref.providerOrderId,
      expiresAt: expiresAt.toISOString(),
      status: 'pending',
    };
  }

  /**
   * A tip is a direct payment, split at capture: the creator's share is routed
   * to their own vendor account and the platform retains only its commission
   * (zero by default on tips).
   */
  async createTipOrder(input: CreateTipInput, uow: UnitOfWork): Promise<CreateTopUpResult> {
    if (input.amountPaise < 1000) {
      throw err.validation('credits.tip_too_small', 'the minimum tip is Rs 10');
    }
    await this.risk.assertTopUpAllowed(uow, input.userId, input.amountPaise, this.clock.now());

    const creator = await uow.query<{ id: string; vendor_ref: string | null; payouts_enabled: boolean; user_id: string }>(
      'SELECT id, vendor_ref, payouts_enabled, user_id FROM creators WHERE id = $1',
      [input.creatorId],
    );
    if (creator.rowCount === 0) throw err.notFound('credits.creator_missing', 'creator does not exist');
    const c = creator.rows[0]!;
    if (!c.payouts_enabled || !c.vendor_ref) {
      throw err.precondition('credits.creator_not_payable', 'this creator cannot receive payments yet');
    }
    if (c.user_id === input.userId) {
      throw err.forbidden('credits.self_tip', 'a creator cannot tip themselves');
    }

    const split = computeSplit({
      grossPaise: input.amountPaise,
      kind: 'tip',
      schedule: this.schedule,
      pgFeeAlreadyBorneAtTopUp: false,
    });

    const orderId = newId('order');
    const expiresAt = new Date(this.clock.now().getTime() + this.orderTtlMinutes * 60_000);

    await uow.query(
      `INSERT INTO orders (id, user_id, kind, amount_paise, credits, target_creator_id, status, idempotency_key, expires_at)
       VALUES ($1, $2, 'tip', $3, 0, $4, 'created', $5, $6)`,
      [orderId, input.userId, input.amountPaise, input.creatorId, input.idempotencyKey, expiresAt],
    );

    const ref = await this.payments.createOrder({
      orderId,
      amount: input.amountPaise,
      currency: 'INR',
      customer: {
        customerId: input.userId,
        email: input.customer.email,
        phone: input.customer.phone,
        ...(input.customer.name ? { name: input.customer.name } : {}),
      },
      idempotencyKey: input.idempotencyKey,
      note: (input.message ?? 'Tip').slice(0, 100),
      expiresAt,
      // The creator's share is settled to their own account by the aggregator.
      splits: [{ vendorRef: c.vendor_ref, amount: split.creatorGross }],
    });

    await uow.query(
      `UPDATE orders SET provider_order_id = $2, payment_session_id = $3, status = 'pending' WHERE id = $1`,
      [orderId, ref.providerOrderId, ref.paymentSessionId],
    );

    return {
      orderId,
      amountPaise: input.amountPaise,
      credits: 0,
      paymentSessionId: ref.paymentSessionId,
      providerOrderId: ref.providerOrderId,
      expiresAt: expiresAt.toISOString(),
      status: 'pending',
    };
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  /**
   * Apply a captured payment. Called from webhook processing and from the
   * reconciliation poller, so it must be safe to invoke any number of times for
   * the same payment: every write below is keyed on the payment identity.
   */
  async applyCapturedPayment(uow: UnitOfWork, payment: PaymentResult): Promise<{ applied: boolean; orderId: string }> {
    const orderRes = await uow.query<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [payment.orderId]);
    if (orderRes.rowCount === 0) {
      throw err.notFound('credits.order_missing', 'no such order', { orderId: payment.orderId });
    }
    const order = mapOrder(orderRes.rows[0]!);

    if (payment.amount !== order.amountPaise) {
      // Never grant value for an amount we did not ask for.
      throw err.conflict('credits.amount_mismatch', 'captured amount does not match the order', {
        orderId: order.id,
        expected: order.amountPaise,
        captured: payment.amount,
      });
    }

    const existing = await uow.query<{ id: string }>('SELECT id FROM payments WHERE provider_payment_id = $1', [
      payment.providerPaymentId,
    ]);
    if (existing.rowCount > 0 && order.status === 'paid') {
      return { applied: false, orderId: order.id };
    }

    const capturedAt = payment.capturedAt ?? this.clock.now();
    const pgFee = applyRateHalfUp(order.amountPaise, this.schedule.pgFeePpm);
    const gstOnPgFee = applyRateHalfUp(pgFee, this.schedule.gstOnPgFeePpm);
    const paymentId = newId('payment');

    await uow.query(
      `INSERT INTO payments
         (id, order_id, provider_payment_id, status, amount_paise, method, pg_fee_paise, gst_on_pg_fee_paise,
          bank_reference, captured_at)
       VALUES ($1,$2,$3,'success',$4,$5,$6,$7,$8,$9)
       ON CONFLICT (provider_payment_id) DO NOTHING`,
      [
        paymentId,
        order.id,
        payment.providerPaymentId,
        payment.amount,
        payment.method,
        pgFee,
        gstOnPgFee,
        payment.bankReference,
        capturedAt,
      ],
    );

    await uow.query(`UPDATE orders SET status = 'paid', paid_at = $2 WHERE id = $1 AND status <> 'paid'`, [
      order.id,
      capturedAt,
    ]);

    if (order.kind === 'credit_topup') {
      await this.grantCredits(uow, order, capturedAt, pgFee, gstOnPgFee);
    } else {
      await this.recogniseTip(uow, order, capturedAt, pgFee, gstOnPgFee);
    }

    return { applied: true, orderId: order.id };
  }

  private async grantCredits(
    uow: UnitOfWork,
    order: OrderRecord,
    capturedAt: Date,
    pgFee: Paise,
    gstOnPgFee: Paise,
  ): Promise<void> {
    await uow.advisoryLock(LOCK_NS.WALLET, order.userId);

    const lotId = newId('order');
    const pgFeeInclusive = sum(pgFee, gstOnPgFee);

    // A coin is always worth its face value on redemption, whether it was paid
    // for or granted as a bundle bonus. The liability is therefore the full
    // face value of the coins issued, and the shortfall against the cash
    // received is promotional spend the platform bears.
    const faceValue = order.credits * this.schedule.creditValuePaise;
    const promotionalCost = subtract(faceValue, order.amountPaise);
    if (promotionalCost < 0) {
      throw err.internal('credits.bundle_underfunded', 'a bundle granted less face value than the price paid', {
        orderId: order.id,
        faceValue,
        amountPaise: order.amountPaise,
      });
    }

    const lotInserted = await uow.query(
      `INSERT INTO credit_lots (id, user_id, order_id, credits_granted, credits_remaining, paise_per_credit, granted_at, expires_at)
       SELECT $1, $2, $3, $4, $4, $5, $6, $7
        WHERE NOT EXISTS (SELECT 1 FROM credit_lots WHERE order_id = $3)`,
      [
        lotId,
        order.userId,
        order.id,
        order.credits,
        this.schedule.creditValuePaise,
        capturedAt,
        addDays(capturedAt, this.schedule.creditExpiryDays),
      ],
    );

    if (lotInserted.rowCount === 0) return; // already granted

    await uow.query(
      `INSERT INTO credit_wallets (user_id, balance_credits, lifetime_purchased, version)
       VALUES ($1, $2, $2, 1)
       ON CONFLICT (user_id) DO UPDATE
         SET balance_credits = credit_wallets.balance_credits + EXCLUDED.balance_credits,
             lifetime_purchased = credit_wallets.lifetime_purchased + EXCLUDED.lifetime_purchased,
             version = credit_wallets.version + 1,
             updated_at = now()`,
      [order.userId, order.credits],
    );

    await uow.query(
      `INSERT INTO credit_movements (user_id, lot_id, delta, reason, reference_id)
       VALUES ($1, $2, $3, 'topup', $4)
       ON CONFLICT DO NOTHING`,
      [order.userId, lotId, order.credits, order.id],
    );

    // Ledger: the coins are a liability, not revenue. The aggregator's fee is a
    // real cost borne now and recovered from creators at redemption.
    const entry = buildEntry({
      entryType: 'credit_topup_captured',
      occurredAt: capturedAt,
      referenceType: 'order',
      referenceId: order.id,
      idempotencyKey: derivedIdempotencyKey('topup', order.id),
      postings: compact([
        debit('PA_ESCROW_RECEIVABLE', subtract(order.amountPaise, pgFeeInclusive)),
        pgFeeInclusive > 0 ? debit('PG_FEE_EXPENSE', pgFeeInclusive) : null,
        promotionalCost > 0 ? debit('PROMOTIONAL_CREDIT_EXPENSE', promotionalCost, null, 'bundle bonus coins') : null,
        credit('CREDIT_LIABILITY', faceValue),
      ]),
      metadata: { sku: order.sku, credits: order.credits, faceValue, promotionalCost, pgFee, gstOnPgFee },
    });
    await this.ledger.post(uow, entry);
  }

  private async recogniseTip(
    uow: UnitOfWork,
    order: OrderRecord,
    capturedAt: Date,
    pgFee: Paise,
    gstOnPgFee: Paise,
  ): Promise<void> {
    if (!order.targetCreatorId) {
      throw err.internal('credits.tip_without_creator', 'tip order has no target creator');
    }

    const split = computeSplit({
      grossPaise: order.amountPaise,
      kind: 'tip',
      schedule: this.schedule,
      pgFeeAlreadyBorneAtTopUp: false,
    });

    const period = await this.periods.currentPeriod(uow);
    const redemptionId = newId('redemption');
    const idem = derivedIdempotencyKey('tip', order.id);

    const inserted = await uow.query(
      `INSERT INTO redemptions
         (id, user_id, chapter_id, creator_id, period_id, kind, gross_paise, pg_fee_paise, gst_on_pg_fee_paise,
          platform_fee_paise, gst_on_platform_fee_paise, split_fee_paise, gst_on_split_fee_paise,
          creator_gross_paise, reserve_held_paise, funding_order_id, idempotency_key, created_at)
       VALUES ($1,$2,NULL,$3,$4,'tip',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        redemptionId,
        order.userId,
        order.targetCreatorId,
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
        order.id,
        idem,
        capturedAt,
      ],
    );
    if (inserted.rowCount === 0) return;

    await uow.query('UPDATE creators SET lifetime_gross_paise = lifetime_gross_paise + $2 WHERE id = $1', [
      order.targetCreatorId,
      split.gross,
    ]);

    // The aggregator nets its own fees from the gross before escrow, so the
    // platform's escrow claim is the post-fee amount.
    const escrowClaim = sum(split.creatorGross, split.platformFee, split.gstOnPlatformFee);
    await this.ledger.post(
      uow,
      buildEntry({
        entryType: 'tip',
        occurredAt: capturedAt,
        referenceType: 'redemption',
        referenceId: redemptionId,
        idempotencyKey: idem,
        postings: compact([
          debit('PA_ESCROW_RECEIVABLE', escrowClaim),
          credit('CREATOR_PAYABLE', split.creatorGross, order.targetCreatorId),
          split.platformFee > 0 ? credit('PLATFORM_FEE_REVENUE', split.platformFee) : null,
          split.gstOnPlatformFee > 0 ? credit('GST_OUTPUT_PAYABLE', split.gstOnPlatformFee) : null,
        ]),
        metadata: { orderId: order.id, pgFee, gstOnPgFee },
      }),
    );

    if (split.reserveHeld > 0) {
      await this.ledger.post(
        uow,
        buildEntry({
          entryType: 'reserve_held',
          occurredAt: capturedAt,
          referenceType: 'redemption',
          referenceId: redemptionId,
          idempotencyKey: derivedIdempotencyKey('reserve', redemptionId),
          postings: [
            debit('CREATOR_PAYABLE', split.reserveHeld, order.targetCreatorId),
            credit('RESERVE_HOLDBACK', split.reserveHeld, order.targetCreatorId),
          ],
        }),
      );
    }
  }

  async markOrderFailed(uow: UnitOfWork, orderId: string, status: 'failed' | 'expired' | 'cancelled', reason: string): Promise<void> {
    await uow.query(
      `UPDATE orders SET status = $2 WHERE id = $1 AND status IN ('created','pending')`,
      [orderId, status],
    );
    await uow.query(
      `INSERT INTO audit_log (actor_id, actor_role, action, subject_type, subject_id, details)
       VALUES (NULL, 'system', 'order.' || $2, 'order', $1, $3::jsonb)`,
      [orderId, status, JSON.stringify({ reason })],
    );
  }

  async walletBalance(userId: string): Promise<{ credits: number; valuePaise: Paise }> {
    return this.db.transaction(
      async (uow) => {
        const res = await uow.query<{ balance_credits: number }>(
          'SELECT balance_credits FROM credit_wallets WHERE user_id = $1',
          [userId],
        );
        const credits = res.rows[0]?.balance_credits ?? 0;
        return { credits, valuePaise: credits * this.schedule.creditValuePaise };
      },
      { readOnly: true },
    );
  }

  async getOrder(uow: UnitOfWork, orderId: string): Promise<OrderRecord | null> {
    const res = await uow.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [orderId]);
    return res.rowCount > 0 ? mapOrder(res.rows[0]!) : null;
  }

  async getOrderByProviderId(uow: UnitOfWork, providerOrderId: string): Promise<OrderRecord | null> {
    const res = await uow.query<OrderRow>('SELECT * FROM orders WHERE provider_order_id = $1', [providerOrderId]);
    return res.rowCount > 0 ? mapOrder(res.rows[0]!) : null;
  }
}

interface OrderRow {
  id: string;
  user_id: string;
  kind: 'credit_topup' | 'tip';
  sku: string | null;
  amount_paise: number;
  credits: number;
  target_creator_id: string | null;
  status: OrderRecord['status'];
  provider_order_id: string | null;
  payment_session_id: string | null;
  idempotency_key: string;
  created_at: Date;
  paid_at: Date | null;
}

export function mapOrder(r: OrderRow): OrderRecord {
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    sku: r.sku,
    amountPaise: r.amount_paise,
    credits: r.credits,
    status: r.status,
    providerOrderId: r.provider_order_id,
    paymentSessionId: r.payment_session_id,
    targetCreatorId: r.target_creator_id,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
    paidAt: r.paid_at,
  };
}
