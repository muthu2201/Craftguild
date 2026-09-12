import { buildContainer } from '../container.js';
import { buildApp } from './app.js';
import { migrate } from '../adapters/postgres/migrator.js';

/** API process entry point. */
async function main(): Promise<void> {
  const container = buildContainer();
  const { config, logger } = container;

  if (process.env['RUN_MIGRATIONS_ON_BOOT'] === 'true') {
    await migrate(container.db, logger);
  }

  const app = await buildApp(container);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'received shutdown signal');
    // Stop accepting connections first, then drain, then release resources.
    const timer = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 25_000);
    timer.unref();
    try {
      await app.close();
      await container.shutdown();
      clearTimeout(timer);
      process.exit(0);
    } catch (e) {
      logger.error({ err: e }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (e) => {
    logger.fatal({ err: e }, 'uncaught exception; exiting');
    process.exit(1);
  });

  await app.listen({ port: config.env.PORT, host: config.env.HOST });
  logger.info(
    { port: config.env.PORT, host: config.env.HOST, env: config.env.NODE_ENV },
    'craftguild payments api listening',
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('fatal startup error:', e);
  process.exit(1);
});
