import { newId } from '../domain/ids.js';
import { err, isAppError } from '../domain/errors.js';
import type { Clock } from '../domain/clock.js';
import { rupeesToPaise } from '../domain/money/money.js';
import type { Database, UnitOfWork } from '../ports/repository.port.js';
import type { PaymentPort, WebhookEnvelope } from '../ports/payment.port.js';
import type { CreditsService } from './credits.service.js';
import type { RefundService } from './refund.service.js';
import type { PayoutService } from './payout.service.js';
import type { CreatorService } from './creator.service.js';
import type { Logger } from '../observability/logger.js';

/**
 * Webhook ingestion and processing.
 *
 * Ingestion is deliberately tiny: verify the signature, persist the raw
 * delivery, return 200. Processing happens asynchronously, which means a slow
 * database or a downstream failure can never cause the aggregator to see a
 * timeout and start retrying a delivery we already hold.
 *
 * Every delivery is deduplicated on (provider, provider_event_id), and every
 * effect it triggers is itself idempotent, so at-least-once delivery produces
 * exactly-once effects.
 */

const MAX_ATTEMPTS = 12;

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
  type: string;
}

export class WebhookService {
  constructor(
    private readonly db: Database,
    private readonly payments: PaymentPort,
    private readonly credits: CreditsService,
    private readonly refunds: RefundService,
    private readonly payouts: PayoutService,
    private readonly creators: CreatorService,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** Verify and persist. Never does business work on the request thread. */
  async ingest(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<IngestResult> {
    const envelope = this.payments.verifyWebhook(rawBody, headers);

    return this.db.transaction(async (uow) => {
      const id = newId('event');
      const now = this.clock.now();
      // received_at and available_at come from the application clock, never
      // from the database's now(): the claim query below compares against the
      // same clock, and mixing the two sources would strand deliveries.
      const inserted = await uow.query<{ id: string }>(
        `INSERT INTO webhook_events
           (id, provider, provider_event_id, event_type, signature_valid, payload, raw_body, received_at, available_at)
         VALUES ($1, 'cashfree', $2, $3, TRUE, $4::jsonb, $5, $6, $6)
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING id`,
        [id, envelope.eventId, envelope.type, JSON.stringify(envelope.payload), rawBody, now],
      );

      if (inserted.rowCount === 0) {
        return { eventId: envelope.eventId, duplicate: true, type: envelope.type };
      }
      return { eventId: envelope.eventId, duplicate: false, type: envelope.type };
    });
  }

  /** Claim and process a batch of pending deliveries. Returns how many were handled. */
  async processPending(batchSize = 25): Promise<{ processed: number; failed: number; ignored: number }> {
    const claimed = await this.db.transaction(async (uow) => {
      const res = await uow.query<{ id: string; event_type: string; payload: Record<string, unknown>; attempts: number }>(
        `UPDATE webhook_events SET status = 'processing', attempts = attempts + 1
          WHERE id IN (
            SELECT id FROM webhook_events
             WHERE status IN ('pending','failed') AND available_at <= $2 AND attempts < $3
             ORDER BY received_at
             FOR UPDATE SKIP LOCKED
             LIMIT $1
          )
          RETURNING id, event_type, payload, attempts`,
        [batchSize, this.clock.now(), MAX_ATTEMPTS],
      );
      return res.rows;
    });

    let processed = 0;
    let failed = 0;
    let ignored = 0;

    for (const event of claimed) {
      try {
        const outcome = await this.handle(event.event_type, event.payload);
        await this.db.transaction(async (uow) => {
          await uow.query(
            `UPDATE webhook_events SET status = $2, processed_at = $3, last_error = NULL WHERE id = $1`,
            [event.id, outcome === 'ignored' ? 'ignored' : 'processed', this.clock.now()],
          );
        });
        if (outcome === 'ignored') ignored++;
        else processed++;
      } catch (e) {
        failed++;
        const permanent = isAppError(e) && e.category === 'validation';
        const backoffSeconds = Math.min(3600, 2 ** Math.min(event.attempts, 10));
        this.logger.error(
          { err: e, eventId: event.id, type: event.event_type, attempts: event.attempts },
          'webhook processing failed',
        );
        await this.db.transaction(async (uow) => {
          await uow.query(
            `UPDATE webhook_events
                SET status = $2, last_error = $3, available_at = $5::timestamptz + ($4 || ' seconds')::interval
              WHERE id = $1`,
            [
              event.id,
              permanent ? 'ignored' : 'failed',
              String((e as Error).message).slice(0, 1000),
              String(backoffSeconds),
              this.clock.now(),
            ],
          );
        });
      }
    }

    return { processed, failed, ignored };
  }

  private async handle(type: string, payload: Record<string, unknown>): Promise<'handled' | 'ignored'> {
    const data = (payload['data'] ?? {}) as Record<string, unknown>;

    switch (type) {
      case 'PAYMENT_SUCCESS_WEBHOOK':
        return this.handlePaymentSuccess(data);

      case 'PAYMENT_FAILED_WEBHOOK':
      case 'PAYMENT_USER_DROPPED_WEBHOOK':
        return this.handlePaymentNotCompleted(data, type);

      case 'REFUND_STATUS_WEBHOOK':
        return this.handleRefundStatus(data);

      case 'PAYMENT_DISPUTE_WEBHOOK':
      case 'DISPUTE_CREATED_WEBHOOK':
        return this.handleDispute(data);

      case 'VENDOR_STATUS_WEBHOOK':
      case 'EASY_SPLIT_VENDOR_STATUS_WEBHOOK':
        return this.handleVendorStatus(data);

      case 'VENDOR_SETTLEMENT_WEBHOOK':
      case 'SETTLEMENT_SUCCESS_WEBHOOK':
        return this.handleVendorSettlement(data);

      default:
        this.logger.info({ type }, 'webhook type not handled; recorded and ignored');
        return 'ignored';
    }
  }

  private async handlePaymentSuccess(data: Record<string, unknown>): Promise<'handled'> {
    const order = (data['order'] ?? {}) as Record<string, unknown>;
    const payment = (data['payment'] ?? {}) as Record<string, unknown>;

    const orderId = String(order['order_id'] ?? '');
    const providerPaymentId = String(payment['cf_payment_id'] ?? '');
    if (!orderId || !providerPaymentId) {
      throw err.validation('webhook.incomplete_payment_payload', 'payment webhook is missing identifiers');
    }

    // Never take the amount from the webhook alone. Re-read the authoritative
    // payment record from the aggregator before granting any value.
    const verified = await this.payments.getPaymentStatus(orderId);
    if (!verified || verified.status !== 'success') {
      throw err.upstream(
        'webhook.payment_not_confirmed',
        'aggregator does not (yet) report this payment as successful',
        { orderId, providerPaymentId },
      );
    }
    if (verified.providerPaymentId !== providerPaymentId) {
      this.logger.warn(
        { orderId, webhookPaymentId: providerPaymentId, verifiedPaymentId: verified.providerPaymentId },
        'webhook payment id differs from the aggregator’s current successful payment',
      );
    }

    await this.db.transaction(async (uow) => {
      await this.credits.applyCapturedPayment(uow, verified);
    });
    return 'handled';
  }

  private async handlePaymentNotCompleted(data: Record<string, unknown>, type: string): Promise<'handled'> {
    const order = (data['order'] ?? {}) as Record<string, unknown>;
    const orderId = String(order['order_id'] ?? '');
    if (!orderId) throw err.validation('webhook.incomplete_payload', 'order id missing');

    const status = type === 'PAYMENT_USER_DROPPED_WEBHOOK' ? 'cancelled' : 'failed';
    await this.db.transaction(async (uow) => {
      await this.credits.markOrderFailed(uow, orderId, status, type);
    });
    return 'handled';
  }

  private async handleRefundStatus(data: Record<string, unknown>): Promise<'handled' | 'ignored'> {
    const refund = (data['refund'] ?? {}) as Record<string, unknown>;
    const refundId = String(refund['refund_id'] ?? '');
    const status = String(refund['refund_status'] ?? '').toUpperCase();
    if (!refundId) throw err.validation('webhook.incomplete_refund_payload', 'refund id missing');

    if (status !== 'SUCCESS') {
      if (status === 'FAILED' || status === 'CANCELLED') {
        await this.db.transaction(async (uow) => {
          await uow.query(`UPDATE refunds SET status = 'failed' WHERE id = $1 AND status <> 'succeeded'`, [refundId]);
        });
        return 'handled';
      }
      return 'ignored';
    }

    const processedAt = refund['processed_at'] ? new Date(String(refund['processed_at'])) : this.clock.now();
    await this.db.transaction(async (uow) => {
      await this.refunds.settleSourceRefund(uow, refundId, processedAt);
    });
    return 'handled';
  }

  private async handleDispute(data: Record<string, unknown>): Promise<'handled'> {
    const dispute = (data['dispute'] ?? {}) as Record<string, unknown>;
    const providerDisputeId = String(dispute['dispute_id'] ?? dispute['cf_dispute_id'] ?? '');
    const providerPaymentId = String(dispute['cf_payment_id'] ?? '');
    const amountRupees = dispute['dispute_amount'] ?? dispute['amount'];

    if (!providerDisputeId || !providerPaymentId || amountRupees === undefined) {
      throw err.validation('webhook.incomplete_dispute_payload', 'dispute webhook is missing identifiers or amount');
    }

    await this.db.transaction(async (uow) => {
      await this.refunds.applyChargeback(uow, {
        providerDisputeId,
        providerPaymentId,
        amount: rupeesToPaise(Number(amountRupees)),
        reason: String(dispute['reason'] ?? dispute['dispute_type'] ?? 'chargeback'),
        occurredAt: this.clock.now(),
      });
    });
    return 'handled';
  }

  private async handleVendorStatus(data: Record<string, unknown>): Promise<'handled' | 'ignored'> {
    const vendor = (data['vendor'] ?? data) as Record<string, unknown>;
    const vendorRef = String(vendor['vendor_id'] ?? '');
    const status = String(vendor['status'] ?? '').toUpperCase();
    if (!vendorRef) throw err.validation('webhook.incomplete_vendor_payload', 'vendor id missing');

    const creator = await this.db.transaction((uow) => this.creators.byVendorRef(uow, vendorRef), { readOnly: true });
    if (!creator) {
      this.logger.warn({ vendorRef }, 'vendor status webhook for an unknown vendor');
      return 'ignored';
    }

    const mapped =
      status === 'ACTIVE'
        ? 'active'
        : status === 'BLOCKED' || status === 'DELETED'
          ? 'blocked'
          : status === 'REJECTED'
            ? 'rejected'
            : status === 'IN_REVIEW'
              ? 'in_review'
              : 'pending';

    await this.creators.applyVendorStatus(
      creator.id,
      vendorRef,
      mapped,
      mapped === 'rejected' || mapped === 'blocked' ? String(vendor['remarks'] ?? status) : null,
    );
    return 'handled';
  }

  private async handleVendorSettlement(data: Record<string, unknown>): Promise<'handled' | 'ignored'> {
    const settlement = (data['settlement'] ?? data) as Record<string, unknown>;
    const transferId = String(settlement['settlement_id'] ?? '');
    const status = String(settlement['status'] ?? '').toUpperCase();
    if (!transferId) throw err.validation('webhook.incomplete_settlement_payload', 'settlement id missing');

    const processedAt = settlement['processed_on']
      ? new Date(String(settlement['processed_on']))
      : this.clock.now();

    if (status === 'SUCCESS') {
      await this.payouts.markSettled(
        transferId,
        String(settlement['cf_settlement_id'] ?? transferId),
        settlement['utr'] ? String(settlement['utr']) : null,
        processedAt,
      );
      return 'handled';
    }
    if (status === 'FAILED' || status === 'REJECTED' || status === 'REVERSED') {
      await this.payouts.markFailed(transferId, String(settlement['failure_reason'] ?? status));
      return 'handled';
    }
    return 'ignored';
  }

  /** Deliveries that exhausted their retries and need a human. */
  async deadLetters(limit = 50): Promise<unknown[]> {
    return this.db.transaction(
      async (uow) => {
        const res = await uow.query(
          `SELECT id, event_type, attempts, last_error, received_at
             FROM webhook_events
            WHERE status = 'failed' AND attempts >= $1
            ORDER BY received_at DESC LIMIT $2`,
          [MAX_ATTEMPTS, limit],
        );
        return res.rows;
      },
      { readOnly: true },
    );
  }
}
