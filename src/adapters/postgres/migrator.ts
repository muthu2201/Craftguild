import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PostgresDatabase } from './database.js';
import type { Logger } from '../../observability/logger.js';

const MIGRATIONS_DIR = path.resolve(fileURLToPath(new URL('../../../migrations', import.meta.url)));

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const LOCK_ID = 8_472_913;

/**
 * Forward-only migrator with checksum verification.
 *
 * The whole run holds ONE pinned connection: `pg_advisory_lock` is
 * session-scoped, so taking it on a pooled connection and releasing it on
 * whichever connection the pool hands out next would leave the lock held
 * forever and wedge the next deploy.
 */
export async function migrate(db: PostgresDatabase, logger: Logger, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  return db.withClient(async (exec) => {
    await exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        duration_ms INTEGER NOT NULL
      )
    `);

    await exec('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    try {
      const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
      const existing = await exec('SELECT version, checksum FROM schema_migrations');
      const applied = new Map(existing.rows.map((r) => [r.version as string, r.checksum as string]));

      const result: MigrationResult = { applied: [], skipped: [] };

      for (const file of files) {
        const version = file.replace(/\.sql$/, '');
        const sql = await readFile(path.join(dir, file), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');

        const previous = applied.get(version);
        if (previous) {
          if (previous !== checksum) {
            throw new Error(
              `migration ${version} was modified after being applied (checksum ${previous} -> ${checksum}). ` +
                'Forward-only migrations must never be edited in place.',
            );
          }
          result.skipped.push(version);
          continue;
        }

        const started = Date.now();
        logger.info({ version }, 'applying migration');
        await exec('BEGIN');
        try {
          await exec(sql);
          await exec('INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)', [
            version,
            checksum,
            Date.now() - started,
          ]);
          await exec('COMMIT');
        } catch (e) {
          await exec('ROLLBACK').catch(() => undefined);
          throw new Error(`migration ${version} failed: ${(e as Error).message}`, { cause: e });
        }
        result.applied.push(version);
      }

      logger.info({ applied: result.applied.length, skipped: result.skipped.length }, 'migrations up to date');
      return result;
    } finally {
      await exec('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    }
  });
}

/** Drop every application object. Guarded so it can never touch production. */
export async function resetSchema(db: PostgresDatabase, confirm: string): Promise<void> {
  if (confirm !== 'yes-destroy-everything') {
    throw new Error('resetSchema requires explicit confirmation');
  }
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('refusing to reset schema with NODE_ENV=production');
  }
  await db.exec('DROP SCHEMA public CASCADE');
  await db.exec('CREATE SCHEMA public');
}
