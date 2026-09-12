import pg from 'pg';
import { createHash } from 'node:crypto';
import type { Database, UnitOfWork } from '../../ports/repository.port.js';
import { err, isAppError } from '../../domain/errors.js';
import type { Logger } from '../../observability/logger.js';

const { Pool, types } = pg;

const PG_OID = { INT8: 20, NUMERIC: 1700 } as const;

/**
 * Numeric type parsing.
 *
 * Two OIDs matter and both arrive as strings by default:
 *
 *  - INT8 (bigint) is every paise column in this schema.
 *  - NUMERIC is what `SUM()` over a bigint returns. Left as a string, an
 *    aggregate silently concatenates instead of adding — `0 + "9764" + "236"`
 *    becomes "09764236" — which is a wrong number that still looks like money.
 *    That failure is silent and severe, so it is fixed here once rather than
 *    by remembering a `::bigint` cast at every call site.
 *
 * Anything that is not an exact integer inside the safe range throws, because
 * quietly rounding a monetary value is worse than failing the request.
 */
function parseExactInteger(oid: string, value: string): number {
  if (value === null) return value as unknown as number;
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${oid} value ${value} is not an exact integer; money must never be fractional here`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${oid} value ${value} exceeds JavaScript safe integer range`);
  }
  return n;
}

types.setTypeParser(PG_OID.INT8, (value: string) => parseExactInteger('bigint', value));
types.setTypeParser(PG_OID.NUMERIC, (value: string) => parseExactInteger('numeric', value));

export interface PostgresOptions {
  readonly connectionString: string;
  readonly max: number;
  readonly statementTimeoutMs: number;
  readonly applicationName?: string;
}

class PgUnitOfWork implements UnitOfWork {
  constructor(
    private readonly client: pg.PoolClient,
    private readonly logger: Logger,
  ) {}

  async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
    const started = process.hrtime.bigint();
    try {
      const res = await this.client.query(sql, params as unknown[]);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    } catch (e) {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      this.logger.error({ err: e, sql: sql.slice(0, 400), durationMs }, 'sql query failed');
      throw translatePgError(e, sql);
    }
  }

  /**
   * Transaction-scoped advisory lock. The key is hashed to a stable 32-bit
   * integer; the namespace separates lock domains (wallets, creators, periods)
   * so unrelated work never contends.
   */
  async advisoryLock(namespace: number, key: string): Promise<void> {
    const hashed = createHash('sha256').update(key).digest();
    const keyInt = hashed.readInt32BE(0);
    await this.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [namespace, keyInt]);
  }
}

export const LOCK_NS = {
  WALLET: 1,
  CREATOR: 2,
  PERIOD: 3,
  ORDER: 4,
  REDEMPTION: 5,
  PAYOUT: 6,
} as const;

export class PostgresDatabase implements Database {
  private readonly pool: pg.Pool;
  private closed = false;

  constructor(
    private readonly options: PostgresOptions,
    private readonly logger: Logger,
  ) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.max,
      application_name: options.applicationName ?? 'craftguild',
      statement_timeout: options.statementTimeoutMs,
      idle_in_transaction_session_timeout: options.statementTimeoutMs * 2,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: false,
    });
    this.pool.on('error', (e) => this.logger.error({ err: e }, 'idle postgres client error'));
  }

  async transaction<T>(
    fn: (uow: UnitOfWork) => Promise<T>,
    options: { isolation?: 'read committed' | 'repeatable read' | 'serializable'; readOnly?: boolean } = {},
  ): Promise<T> {
    if (this.closed) throw err.internal('db.closed', 'database pool is closed');

    const isolation = options.isolation ?? 'read committed';
    const maxAttempts = isolation === 'read committed' ? 1 : 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query(
          `BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}${options.readOnly ? ' READ ONLY' : ''}`,
        );
        const uow = new PgUnitOfWork(client, this.logger);
        const result = await fn(uow);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* the connection is already broken; releasing it below discards it */
        }
        if (attempt < maxAttempts && isSerializationFailure(e)) {
          const backoffMs = Math.min(100, 5 * 2 ** attempt) + Math.random() * 10;
          this.logger.warn({ attempt, backoffMs }, 'serialization failure, retrying transaction');
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        throw translatePgError(e, 'transaction');
      } finally {
        client.release();
      }
    }
    throw err.conflict('db.serialization_retries_exhausted', 'transaction could not be serialised');
  }

  /** Run a statement outside any transaction (migrations, admin DDL). */
  async exec(sql: string, params: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const res = await this.pool.query(sql, params as unknown[]);
    return { rows: res.rows, rowCount: res.rowCount ?? 0 };
  }

  /**
   * Pin one connection for the duration of `fn`.
   *
   * Session-scoped state — `pg_advisory_lock`, `SET LOCAL`-free settings,
   * temp tables — is meaningless across a pool, because the next statement may
   * land on a different backend. Anything session-scoped must run in here.
   */
  async withClient<T>(fn: (exec: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(async (sql, params = []) => {
        const res = await client.query(sql, params as unknown[]);
        return { rows: res.rows, rowCount: res.rowCount ?? 0 };
      });
    } finally {
      client.release();
    }
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await this.pool.query('SELECT 1 AS ok');
      return res.rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  get poolStats() {
    return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

function isSerializationFailure(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === '40001' || code === '40P01';
}

/** Map Postgres error codes onto the application's error taxonomy. */
export function translatePgError(e: unknown, context: string): unknown {
  // An application error thrown by the work inside the transaction passes
  // through untouched. AppError carries its own `code`, so without this guard
  // every domain error raised in a transaction would be misread as a Postgres
  // SQLSTATE and reported to the client as a 500.
  if (isAppError(e)) return e;

  const pgErr = e as { code?: string; constraint?: string; detail?: string; message?: string };
  const code = pgErr?.code;
  if (!code) return e;

  switch (code) {
    case '23505':
      return err.conflict('db.unique_violation', `unique constraint violated: ${pgErr.constraint ?? 'unknown'}`, {
        constraint: pgErr.constraint,
        detail: pgErr.detail,
        context,
      });
    case '23503':
      return err.validation('db.foreign_key_violation', `referenced row does not exist: ${pgErr.constraint ?? ''}`, {
        constraint: pgErr.constraint,
        detail: pgErr.detail,
      });
    case '23514':
      return err.validation('db.check_violation', `check constraint violated: ${pgErr.constraint ?? pgErr.message}`, {
        constraint: pgErr.constraint,
        message: pgErr.message,
      });
    case '23502':
      return err.validation('db.not_null_violation', `required column was null: ${pgErr.message ?? ''}`);
    case '40001':
      return err.conflict('db.serialization_failure', 'concurrent update; retry the request');
    case '40P01':
      return err.conflict('db.deadlock', 'deadlock detected; retry the request');
    case '57014':
      return err.internal('db.statement_timeout', 'database statement timed out');
    case '53300':
      return err.internal('db.too_many_connections', 'database connection limit reached');
    case '2F003':
    case 'P0001':
      return err.conflict('db.rule_violation', pgErr.message ?? 'database rule violation');
    default:
      return err.internal('db.error', pgErr.message ?? 'database error', { code, context }, e);
  }
}
