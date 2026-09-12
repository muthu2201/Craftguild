import { randomUUID } from 'node:crypto';
import { derivedIdempotencyKey } from '../domain/ids.js';
import type { Clock } from '../domain/clock.js';
import type { Database } from '../ports/repository.port.js';
import type { PaymentPort } from '../ports/payment.port.js';
import type { PayoutService } from './payout.service.js';
import type { Logger } from '../observability/logger.js';

/**
 * Transactional outbox.
 *
 * External calls are never made inside the transaction that produced them: the
 * intent is committed as a row here, and this relay makes the call afterwards.
 * That is what stops a payment-aggregator timeout from rolling back a ledger
 * posting, and stops a committed ledger posting from silently losing its
 * external effect.
 */

const MAX_ATTEMPTS = 10;
const LEASE_MS = 60_000;

export type OutboxHandler = (payload: Record<string, unknown>) => Promise<void>;

export class OutboxService {
  private readonly handlers = new Map<string, OutboxHandler>();
  private readonly workerId = randomUUID();

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  register(topic: string, handler: OutboxHandler): void {
    this.handlers.set(topic, handler);
  }

  async drain(batchSize = 25): Promise<{ processed: number; failed: number; dead: number }> {
    const claimed = await this.db.transaction(async (uow) => {
      const res = await uow.query<{ id: string; topic: string; payload: Record<string, unknown>; attempts: number }>(
        `UPDATE outbox
            SET status = 'processing', attempts = attempts + 1,
                locked_by = $2, locked_until = now() + ($3 || ' milliseconds')::interval
          WHERE id IN (
            SELECT id FROM outbox
             WHERE status IN ('pending','processing')
               AND available_at <= now()
               AND (locked_until IS NULL OR locked_until < now())
               AND attempts < $4
             ORDER BY created_at
             FOR UPDATE SKIP LOCKED
             LIMIT $1
          )
          RETURNING id, topic, payload, attempts`,
        [batchSize, this.workerId, String(LEASE_MS), MAX_ATTEMPTS],
      );
      return res.rows;
    });

    let processed = 0;
    let failed = 0;
    let dead = 0;

    for (const message of claimed) {
      const handler = this.handlers.get(message.topic);
      if (!handler) {
        this.logger.error({ topic: message.topic, id: message.id }, 'no handler registered for outbox topic');
        await this.markDead(message.id, `no handler for topic ${message.topic}`);
        dead++;
        continue;
      }

      try {
        await handler(message.payload);
        await this.db.transaction(async (uow) => {
          await uow.query(
            `UPDATE outbox SET status = 'done', completed_at = now(), locked_by = NULL, locked_until = NULL
              WHERE id = $1`,
            [message.id],
          );
        });
        processed++;
      } catch (e) {
        const attempts = message.attempts;
        if (attempts >= MAX_ATTEMPTS) {
          await this.markDead(message.id, (e as Error).message);
          dead++;
        } else {
          const backoffSeconds = Math.min(1800, 2 ** Math.min(attempts, 10));
          await this.db.transaction(async (uow) => {
            await uow.query(
              `UPDATE outbox
                  SET status = 'pending', last_error = $2, locked_by = NULL, locked_until = NULL,
                      available_at = now() + ($3 || ' seconds')::interval
                WHERE id = $1`,
              [message.id, String((e as Error).message).slice(0, 1000), String(backoffSeconds)],
            );
          });
          failed++;
        }
        this.logger.error({ err: e, topic: message.topic, id: message.id, attempts }, 'outbox handler failed');
      }
    }

    return { processed, failed, dead };
  }

  private async markDead(id: string, reason: string): Promise<void> {
    await this.db.transaction(async (uow) => {
      await uow.query(
        `UPDATE outbox SET status = 'dead', last_error = $2, locked_by = NULL, locked_until = NULL WHERE id = $1`,
        [id, reason.slice(0, 1000)],
      );
    });
  }

  async deadLetterCount(): Promise<number> {
    return this.db.transaction(
      async (uow) => {
        const res = await uow.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM outbox WHERE status = 'dead'`);
        return res.rows[0]?.count ?? 0;
      },
      { readOnly: true },
    );
  }
}

/** Wire the standard handlers: refund dispatch and payout dispatch. */
export function registerStandardHandlers(
  outbox: OutboxService,
  deps: { db: Database; payments: PaymentPort; payouts: PayoutService; logger: Logger },
): void {
  outbox.register('refund.dispatch', async (payload) => {
    const refundId = String(payload['refundId']);
    const orderId = String(payload['orderId']);
    const providerPaymentId = String(payload['providerPaymentId']);
    const amount = Number(payload['amount']);
    const reason = String(payload['reason'] ?? 'refund');

    const ref = await deps.payments.createRefund({
      orderId,
      providerPaymentId,
      refundId,
      amount,
      note: reason,
      idempotencyKey: derivedIdempotencyKey('refund-dispatch', refundId),
    });

    await deps.db.transaction(async (uow) => {
      await uow.query(
        `UPDATE refunds SET provider_refund_id = $2, status = $3 WHERE id = $1 AND status = 'pending'`,
        [refundId, ref.providerRefundId, ref.status === 'failed' ? 'failed' : 'processing'],
      );
    });
  });

  outbox.register('payout.dispatch', async (payload) => {
    await deps.payouts.dispatch(String(payload['payoutId']));
  });
}
