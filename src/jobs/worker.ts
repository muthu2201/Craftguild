import { buildContainer, type Container } from '../container.js';

/**
 * Background worker process.
 *
 * Five loops, each independently paced and each safe to run in many replicas:
 * webhook processing, outbox relay, settlement close, payout retry and
 * maintenance. Work is claimed with FOR UPDATE SKIP LOCKED or an advisory lock,
 * so horizontal scaling needs no coordination service.
 */

interface LoopSpec {
  name: string;
  intervalMs: number;
  run: (c: Container) => Promise<unknown>;
}

const LOOPS: LoopSpec[] = [
  {
    name: 'webhooks',
    intervalMs: 250,
    run: async (c) => {
      const r = await c.services.webhooks.processPending(50);
      return r.processed + r.failed + r.ignored > 0 ? r : null;
    },
  },
  {
    name: 'outbox',
    intervalMs: 250,
    run: async (c) => {
      const r = await c.services.outbox.drain(50);
      return r.processed + r.failed + r.dead > 0 ? r : null;
    },
  },
  {
    name: 'settlement',
    intervalMs: 60_000,
    run: async (c) => {
      await c.services.periods.refreshStatuses();
      // One replica at a time: closing a period twice would be rejected by the
      // ledger's idempotency keys, but taking the lock avoids the noise.
      return c.locks.withLock('settlement-close', 10 * 60_000, async () => {
        const results = await c.services.settlement.closeDuePeriods();
        return results.length > 0 ? results : null;
      });
    },
  },
  {
    name: 'payout-retry',
    intervalMs: 30_000,
    run: async (c) => {
      const queued = await c.services.payouts.listQueued(50);
      if (queued.length === 0) return null;
      let dispatched = 0;
      for (const p of queued) {
        try {
          await c.services.payouts.dispatch(p.id);
          dispatched++;
        } catch (e) {
          c.logger.warn({ err: e, payoutId: p.id }, 'payout retry failed');
        }
      }
      return { dispatched };
    },
  },
  {
    name: 'maintenance',
    intervalMs: 15 * 60_000,
    run: async (c) =>
      c.locks.withLock('maintenance', 5 * 60_000, async () => {
        const credits = await c.services.maintenance.expireCredits();
        const orders = await c.services.maintenance.expireStaleOrders();
        const keys = await c.services.maintenance.purgeExpiredIdempotencyKeys();
        await c.services.maintenance.flagCreatorsNearingGstThreshold();
        return credits.lotsExpired + orders + keys > 0 ? { credits, orders, keys } : null;
      }),
  },
];

export function startLoops(container: Container): () => Promise<void> {
  let running = true;
  const tasks: Promise<void>[] = [];

  for (const loop of LOOPS) {
    const logger = container.logger.child({ loop: loop.name });
    tasks.push(
      (async () => {
        let consecutiveErrors = 0;
        while (running) {
          const started = Date.now();
          try {
            const result = await loop.run(container);
            consecutiveErrors = 0;
            if (result) logger.info({ result, durationMs: Date.now() - started }, 'loop did work');
          } catch (e) {
            consecutiveErrors++;
            logger.error({ err: e, consecutiveErrors }, 'loop iteration failed');
          }
          const backoff = consecutiveErrors > 0 ? Math.min(30_000, 1000 * 2 ** consecutiveErrors) : 0;
          const wait = Math.max(loop.intervalMs, backoff) - (Date.now() - started);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
      })(),
    );
  }

  return async () => {
    running = false;
    await Promise.allSettled(tasks);
  };
}

async function main(): Promise<void> {
  const container = buildContainer();
  container.logger.info('craftguild worker starting');

  const stop = startLoops(container);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    container.logger.info({ signal }, 'worker shutting down');
    await stop();
    await container.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (process.argv[1]?.includes('worker')) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('fatal worker error:', e);
    process.exit(1);
  });
}
