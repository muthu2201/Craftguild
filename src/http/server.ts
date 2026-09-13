import { buildContainer } from '../container.js';
import { buildApp } from './app.js';
import { migrate } from '../adapters/postgres/migrator.js';
import { startLoops } from '../jobs/worker.js';

/** API process entry point. */
async function main(): Promise<void> {
  const container = buildContainer();
  const { config, logger } = container;

  if (process.env['RUN_MIGRATIONS_ON_BOOT'] === 'true') {
    await migrate(container.db, logger);
  }

  const app = await buildApp(container);

  // On a single-container deployment the background loops run here rather than
  // in their own process. They claim work with SKIP LOCKED and advisory locks,
  // so this is the same code doing the same thing from a different process —
  // and shutdown has to stop them before the container's pools are released.
  const stopLoops = config.env.RUN_WORKER_IN_PROCESS ? startLoops(container) : null;
  if (stopLoops) logger.info('background loops running in the api process');

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
      if (stopLoops) await stopLoops();
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
