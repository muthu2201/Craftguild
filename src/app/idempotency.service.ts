import { createHash } from 'node:crypto';
import type { Database, UnitOfWork } from '../ports/repository.port.js';
import { err, isAppError } from '../domain/errors.js';
import type { Clock } from '../domain/clock.js';

/**
 * Request-level idempotency.
 *
 * A client retrying `POST /v1/credits/orders` with the same `Idempotency-Key`
 * must receive the original response, not a second order. The key is claimed in
 * its own committed transaction so that a concurrent duplicate sees `in_flight`
 * and is told to retry rather than racing the first request.
 */

export interface IdempotentOutcome<T> {
  readonly status: number;
  readonly body: T;
  readonly replayed: boolean;
}

const DEFAULT_TTL_HOURS = 24;

export class IdempotencyService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly ttlHours = DEFAULT_TTL_HOURS,
  ) {}

  static fingerprint(payload: unknown): string {
    return createHash('sha256').update(stableStringify(payload)).digest('hex');
  }

  /**
   * Run `work` at most once for (scope, key).
   *
   * `work` receives its own unit of work and must be side-effect complete
   * within it: the key is marked completed in the same transaction, so either
   * both the business effect and the idempotency record land, or neither does.
   */
  async run<T>(args: {
    scope: string;
    key: string;
    userId: string | null;
    request: unknown;
    work: (uow: UnitOfWork) => Promise<{ status: number; body: T }>;
  }): Promise<IdempotentOutcome<T>> {
    const requestHash = IdempotencyService.fingerprint(args.request);
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.ttlHours * 3600_000);

    // Phase 1: claim the key in its own transaction.
    const claim = await this.db.transaction(async (uow) => {
      const existing = await uow.query<{
        state: string;
        request_hash: string;
        response_status: number | null;
        response_body: unknown;
      }>(
        `SELECT state, request_hash, response_status, response_body
           FROM idempotency_keys WHERE scope = $1 AND key = $2`,
        [args.scope, args.key],
      );

      if (existing.rowCount > 0) {
        const row = existing.rows[0]!;
        if (row.request_hash !== requestHash) {
          throw err.conflict(
            'idempotency.payload_mismatch',
            'this Idempotency-Key was already used with a different request body',
            { scope: args.scope },
          );
        }
        return { kind: 'existing' as const, row };
      }

      await uow.query(
        `INSERT INTO idempotency_keys (scope, key, user_id, request_hash, state, expires_at)
         VALUES ($1, $2, $3, $4, 'in_flight', $5)`,
        [args.scope, args.key, args.userId, requestHash, expiresAt],
      );
      return { kind: 'claimed' as const };
    });

    if (claim.kind === 'existing') {
      const row = claim.row;
      if (row.state === 'completed' && row.response_status !== null) {
        return { status: row.response_status, body: row.response_body as T, replayed: true };
      }
      if (row.state === 'in_flight') {
        throw err.conflict(
          'idempotency.in_flight',
          'an identical request is still being processed; retry shortly',
          { scope: args.scope },
        );
      }
      // A previously failed attempt may be retried: release the key and recurse.
      await this.db.transaction(async (uow) => {
        await uow.query('DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2 AND state = $3', [
          args.scope,
          args.key,
          'failed',
        ]);
      });
      return this.run(args);
    }

    // Phase 2: do the work and record the response atomically.
    try {
      return await this.db.transaction(async (uow) => {
        const result = await args.work(uow);
        const updated = await uow.query(
          `UPDATE idempotency_keys
              SET state = 'completed', response_status = $3, response_body = $4::jsonb, completed_at = now()
            WHERE scope = $1 AND key = $2 AND state = 'in_flight'`,
          [args.scope, args.key, result.status, JSON.stringify(result.body ?? null)],
        );
        if (updated.rowCount !== 1) {
          throw err.conflict('idempotency.claim_lost', 'idempotency claim was lost mid-flight');
        }
        return { status: result.status, body: result.body, replayed: false };
      });
    } catch (e) {
      // Mark the key failed so a corrected retry is possible, but keep
      // deterministic client errors sticky: replaying them must not re-run work.
      const sticky = isAppError(e) && e.category !== 'internal' && e.category !== 'upstream';
      await this.db
        .transaction(async (uow) => {
          if (sticky) {
            await uow.query(
              `UPDATE idempotency_keys
                  SET state = 'completed', response_status = $3, response_body = $4::jsonb, completed_at = now()
                WHERE scope = $1 AND key = $2`,
              [
                args.scope,
                args.key,
                (e as { httpStatus: number }).httpStatus,
                JSON.stringify({ error: (e as { toJSON(): unknown }).toJSON() }),
              ],
            );
          } else {
            await uow.query(
              `UPDATE idempotency_keys SET state = 'failed', completed_at = now()
                WHERE scope = $1 AND key = $2`,
              [args.scope, args.key],
            );
          }
        })
        .catch(() => undefined);
      throw e;
    }
  }

  /** Housekeeping: drop expired keys. Run from the maintenance worker. */
  async purgeExpired(): Promise<number> {
    return this.db.transaction(async (uow) => {
      const res = await uow.query('DELETE FROM idempotency_keys WHERE expires_at < now()');
      return res.rowCount;
    });
  }
}

/** Deterministic JSON so key ordering never changes a fingerprint. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
