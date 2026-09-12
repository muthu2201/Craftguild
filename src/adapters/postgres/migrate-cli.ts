import { PostgresDatabase } from './database.js';
import { migrate, resetSchema } from './migrator.js';
import { createLogger } from '../../observability/logger.js';

/** `npm run migrate [--reset]` */
async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');

  const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info', 'migrate');
  const db = new PostgresDatabase(
    { connectionString: url, max: 2, statementTimeoutMs: 120_000, applicationName: 'craftguild-migrate' },
    logger,
  );

  try {
    if (process.argv.includes('--reset')) {
      logger.warn('resetting schema');
      await resetSchema(db, 'yes-destroy-everything');
    }
    const result = await migrate(db, logger);
    logger.info({ applied: result.applied, skipped: result.skipped.length }, 'migration complete');
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
