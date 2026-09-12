import { derivedIdempotencyKey } from '../domain/ids.js';
import { err } from '../domain/errors.js';
import type { Clock } from '../domain/clock.js';
import { sum, type Paise } from '../domain/money/money.js';
import { buildEntry, compact, credit, debit } from '../domain/ledger/journal.js';
import { payoutFeeFor, type FeeSchedule } from '../domain/pricing/fee-schedule.js';
import type { Database, PayoutRecord, UnitOfWork } from '../ports/repository.port.js';
import type { SettlementPort } from '../ports/payment.port.js';
import type { PostgresLedgerRepository } from '../adapters/postgres/ledger.repository.js';
import { LOCK_NS } from '../adapters/postgres/database.js';
import type { Logger } from '../observability/logger.js';

/**
 * Payout dispatch.
 *
 * The money is already the creator's and is already sitting in the aggregator's
 * escrow against their vendor account; this instructs the aggregator to move it
 * to the creator's own bank account or VPA. A failure here reinstates the
 * payable — the creator is never left with money that exists nowhere.
 */
export class PayoutService {
  constructor(
    private readonly db: Database,
    private readonly settlementPort: SettlementPort,
    private readonly ledger: PostgresLedgerRepository,
    private readonly schedule: FeeSchedule,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly maxAttempts = 5,
  ) {}

  /** Dispatch one queued payout. Safe to call repeatedly for the same payout. */
  async dispatch(payoutId: string): Promise<{ status: PayoutRecord['status']; providerTransferId: string | null }> {
    const claimed = await this.db.transaction(async (uow) => {
      await uow.advisoryLock(LOCK_NS.PAYOUT, payoutId);
      const res = await uow.query<PayoutRow & { vendor_ref: string | null; payouts_enabled: boolean; pen_name: string }>(
        `SELECT p.*, c.vendor_ref, c.payouts_enabled, c.pen_name
           FROM payouts p JOIN creators c ON c.id = p.creator_id
          WHERE p.id = $1 FOR UPDATE OF p`,
        [payoutId],
      );
      if (res.rowCount === 0) throw err.notFound('payout.not_found', 'payout does not exist', { payoutId });
      const row = res.rows[0]!;

      if (row.status === 'succeeded' || row.status === 'reversed') return null;
      if (row.attempts >= this.maxAttempts && row.status === 'failed') {
        throw err.precondition('payout.attempts_exhausted', 'payout has exhausted its retry budget', { payoutId });
      }
      if (!row.payouts_enabled || !row.vendor_ref) {
        throw err.precondition('payout.creator_not_payable', 'creator is not enabled for payouts', { payoutId });
      }

      await uow.query(`UPDATE payouts SET status = 'instructed', attempts = attempts + 1 WHERE id = $1`, [payoutId]);
      return row;
    });

    if (!claimed) {
      return { status: 'succeeded', providerTransferId: null };
    }

    try {
      const transfer = await this.settlementPort.transferToVendor({
        transferId: payoutId,
        vendorRef: claimed.vendor_ref!,
        amount: claimed.amount_paise,
        idempotencyKey: derivedIdempotencyKey('payout-transfer', payoutId),
        remarks: `CraftGuild settlement ${claimed.statement_id}`,
      });

      if (transfer.status === 'success') {
        await this.markSettled(payoutId, transfer.providerTransferId, transfer.utr, transfer.processedAt ?? this.clock.now());
        return { status: 'succeeded', providerTransferId: transfer.providerTransferId };
      }

      if (transfer.status === 'failed' || transfer.status === 'reversed') {
        await this.markFailed(payoutId, transfer.failureReason ?? 'aggregator rejected the transfer');
        return { status: 'failed', providerTransferId: transfer.providerTransferId };
      }

      await this.db.transaction(async (uow) => {
        await uow.query(
          `UPDATE payouts SET status = 'processing', provider_transfer_id = $2 WHERE id = $1 AND status = 'instructed'`,
          [payoutId, transfer.providerTransferId],
        );
      });
      return { status: 'processing', providerTransferId: transfer.providerTransferId };
    } catch (e) {
      this.logger.error({ err: e, payoutId }, 'payout dispatch failed');
      const terminal = (e as { retryable?: boolean }).retryable === false;
      if (terminal) {
        await this.markFailed(payoutId, (e as Error).message.slice(0, 500));
      } else {
        await this.db.transaction(async (uow) => {
          await uow.query(`UPDATE payouts SET status = 'queued', failure_reason = $2 WHERE id = $1`, [
            payoutId,
            (e as Error).message.slice(0, 500),
          ]);
        });
      }
      throw e;
    }
  }

  /** Confirmed settled to the creator's own account: money has left escrow. */
  async markSettled(payoutId: string, providerTransferId: string, utr: string | null, settledAt: Date): Promise<boolean> {
    return this.db.transaction(async (uow) => {
      await uow.advisoryLock(LOCK_NS.PAYOUT, payoutId);
      const res = await uow.query<PayoutRow>('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [payoutId]);
      if (res.rowCount === 0) return false;
      const payout = res.rows[0]!;
      if (payout.status === 'succeeded') return false;

      const fee = payoutFeeFor(this.schedule, payout.amount_paise);
      const feeWithGst = fee + Math.round((fee * 18) / 100);

      await uow.query(
        `UPDATE payouts SET status = 'succeeded', provider_transfer_id = $2, utr = $3, settled_at = $4,
                            fee_paise = $5, failure_reason = NULL
          WHERE id = $1`,
        [payoutId, providerTransferId, utr, settledAt, feeWithGst],
      );
      await uow.query(`UPDATE creator_statements SET status = 'paid' WHERE id = $1`, [payout.statement_id]);

      await this.ledger.post(
        uow,
        buildEntry({
          entryType: 'payout_settled',
          occurredAt: settledAt,
          referenceType: 'payout',
          referenceId: payoutId,
          idempotencyKey: derivedIdempotencyKey('payout-settled', payoutId),
          postings: [
            debit('PAYOUT_CLEARING', payout.amount_paise, payout.creator_id),
            credit('PA_ESCROW_RECEIVABLE', payout.amount_paise),
          ],
          metadata: { utr, providerTransferId },
        }),
      );

      // The aggregator's per-payout charge and the accumulated split fee are
      // charged against escrow, netting the recoveries already booked.
      const statement = await uow.query<{ split_fee_paise: number; gst_on_split_fee_paise: number }>(
        'SELECT split_fee_paise, gst_on_split_fee_paise FROM creator_statements WHERE id = $1',
        [payout.statement_id],
      );
      const splitFeeTotal = sum(
        statement.rows[0]?.split_fee_paise ?? 0,
        statement.rows[0]?.gst_on_split_fee_paise ?? 0,
      );

      if (feeWithGst > 0 || splitFeeTotal > 0) {
        await this.ledger.post(
          uow,
          buildEntry({
            entryType: 'payout_fee_incurred',
            occurredAt: settledAt,
            referenceType: 'payout',
            referenceId: payoutId,
            idempotencyKey: derivedIdempotencyKey('payout-fee', payoutId),
            postings: compact([
              feeWithGst > 0 ? debit('PAYOUT_FEE_EXPENSE', feeWithGst) : null,
              splitFeeTotal > 0 ? debit('SPLIT_FEE_EXPENSE', splitFeeTotal) : null,
              credit('PA_ESCROW_RECEIVABLE', sum(feeWithGst, splitFeeTotal)),
            ]),
          }),
        );
      }

      return true;
    });
  }

  /** The transfer bounced: reinstate the payable so the creator keeps their money. */
  async markFailed(payoutId: string, reason: string): Promise<boolean> {
    return this.db.transaction(async (uow) => {
      await uow.advisoryLock(LOCK_NS.PAYOUT, payoutId);
      const res = await uow.query<PayoutRow>('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [payoutId]);
      if (res.rowCount === 0) return false;
      const payout = res.rows[0]!;
      if (payout.status === 'failed' || payout.status === 'succeeded') return false;

      await uow.query(`UPDATE payouts SET status = 'failed', failure_reason = $2 WHERE id = $1`, [
        payoutId,
        reason.slice(0, 500),
      ]);
      await uow.query(
        `UPDATE creator_statements SET status = 'carried_forward', carried_forward_paise = $2 WHERE id = $1`,
        [payout.statement_id, payout.amount_paise],
      );

      await this.ledger.post(
        uow,
        buildEntry({
          entryType: 'payout_failed',
          occurredAt: this.clock.now(),
          referenceType: 'payout',
          referenceId: payoutId,
          idempotencyKey: derivedIdempotencyKey('payout-failed', payoutId),
          postings: [
            debit('PAYOUT_CLEARING', payout.amount_paise, payout.creator_id),
            credit('CREATOR_PAYABLE', payout.amount_paise, payout.creator_id),
          ],
          metadata: { reason: reason.slice(0, 200) },
        }),
      );

      await uow.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, subject_type, subject_id, details)
         VALUES (NULL, 'system', 'payout.failed', 'payout', $1, $2::jsonb)`,
        [payoutId, JSON.stringify({ reason: reason.slice(0, 200), amount: payout.amount_paise })],
      );
      return true;
    });
  }

  async listQueued(limit = 100): Promise<{ id: string; creatorId: string; amount: Paise }[]> {
    return this.db.transaction(
      async (uow) => {
        const res = await uow.query<{ id: string; creator_id: string; amount_paise: number }>(
          `SELECT id, creator_id, amount_paise FROM payouts
            WHERE status = 'queued' AND attempts < $2
            ORDER BY created_at LIMIT $1`,
          [limit, this.maxAttempts],
        );
        return res.rows.map((r) => ({ id: r.id, creatorId: r.creator_id, amount: r.amount_paise }));
      },
      { readOnly: true },
    );
  }

  async byId(uow: UnitOfWork, payoutId: string): Promise<PayoutRecord | null> {
    const res = await uow.query<PayoutRow>('SELECT * FROM payouts WHERE id = $1', [payoutId]);
    return res.rowCount > 0 ? mapPayout(res.rows[0]!) : null;
  }
}

interface PayoutRow {
  id: string;
  creator_id: string;
  statement_id: string;
  amount_paise: number;
  fee_paise: number;
  status: PayoutRecord['status'];
  provider_transfer_id: string | null;
  utr: string | null;
  attempts: number;
  failure_reason: string | null;
  created_at: Date;
  settled_at: Date | null;
}

function mapPayout(r: PayoutRow): PayoutRecord {
  return {
    id: r.id,
    creatorId: r.creator_id,
    statementId: r.statement_id,
    amountPaise: r.amount_paise,
    feePaise: r.fee_paise,
    status: r.status,
    providerTransferId: r.provider_transfer_id,
    utr: r.utr,
    attempts: r.attempts,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
    settledAt: r.settled_at,
  };
}
