import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { buildContainer, type Container } from '../../src/container.js';
import { buildApp } from '../../src/http/app.js';
import { migrate } from '../../src/adapters/postgres/migrator.js';
import { CashfreeSimulator, DEFAULT_SIM_CONFIG, type SimConfig } from '../../tools/cashfree-sim/server.js';
import { FixedClock } from '../../src/domain/clock.js';
import type { FastifyInstance } from 'fastify';

/**
 * End-to-end harness.
 *
 * It boots the REAL application — real Fastify server, real Postgres, real
 * Redis, real Cashfree adapter — and points that adapter at a local server
 * implementing Cashfree's HTTP contract. Nothing inside `src/` is substituted,
 * so what these tests exercise is the code that ships.
 */

const BASE_ADMIN_SECRET = 'test-jwt-secret-at-least-32-characters-long-x';

export interface HarnessOptions {
  sim?: Partial<SimConfig>;
  env?: Record<string, string>;
  clock?: FixedClock;
  /** Use a dedicated schema so parallel suites do not collide. */
  schema?: string;
}

export interface Harness {
  container: Container;
  app: FastifyInstance;
  sim: CashfreeSimulator;
  clock: FixedClock;
  baseUrl: string;
  request: <T = unknown>(
    method: string,
    path: string,
    options?: { body?: unknown; token?: string; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: T; headers: Record<string, unknown> }>;
  /** Run every asynchronous pipeline to quiescence. */
  settle: (rounds?: number) => Promise<void>;
  close: () => Promise<void>;
}

let portCursor = 19_000;
function nextPort(): number {
  portCursor += 1 + Math.floor(Math.random() * 5);
  return portCursor;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const schema = options.schema ?? `t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const simPort = options.sim?.port ?? nextPort();

  const sim = new CashfreeSimulator({
    ...DEFAULT_SIM_CONFIG,
    ...options.sim,
    port: simPort,
    appId: 'TEST_APP_ID',
    secretKey: 'TEST_SECRET_KEY',
    webhookSecret: 'TEST_SECRET_KEY',
  });
  const actualSimPort = await sim.listen();

  const clock = options.clock ?? new FixedClock(new Date('2026-04-10T06:30:00.000Z'));

  const baseDbUrl = process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres@127.0.0.1:5433/craftguild_test';
  const dbUrl = `${baseDbUrl}${baseDbUrl.includes('?') ? '&' : '?'}options=-c%20search_path%3D${schema}`;

  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    // The API binds to an ephemeral port via app.listen below; this value only
    // has to satisfy configuration validation.
    PORT: '8080',
    LOG_LEVEL: process.env['TEST_LOG_LEVEL'] ?? 'silent',
    DATABASE_URL: dbUrl,
    DATABASE_POOL_MAX: '24',
    REDIS_URL: process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6380',
    JWT_SECRET: BASE_ADMIN_SECRET,
    CASHFREE_BASE_URL: `http://127.0.0.1:${actualSimPort}`,
    CASHFREE_APP_ID: 'TEST_APP_ID',
    CASHFREE_SECRET_KEY: 'TEST_SECRET_KEY',
    CASHFREE_WEBHOOK_SECRET: 'TEST_SECRET_KEY',
    CASHFREE_MAX_RETRIES: '3',
    CASHFREE_TIMEOUT_MS: '10000',
    RATE_LIMIT_RPM: '100000',
    RATE_LIMIT_AUTH_BURST: '100000',
    RATE_LIMIT_AUTH_PER_MINUTE: '100000',
    RATE_LIMIT_PAYMENT_BURST: '100000',
    RATE_LIMIT_PAYMENT_PER_MINUTE: '100000',
    RATE_LIMIT_UNLOCK_BURST: '100000',
    RATE_LIMIT_UNLOCK_PER_MINUTE: '100000',
    RATE_LIMIT_ONBOARD_BURST: '100000',
    RATE_LIMIT_ONBOARD_PER_MINUTE: '100000',
    MAX_TOPUP_PER_HOUR: '100000',
    MAX_TOPUP_VALUE_PER_DAY_RUPEES: '100000000',
    FIRST_PAYOUT_HOLD_DAYS: '0',
    ...options.env,
  };

  // Create the isolated schema before the pool starts handing out connections.
  const { PostgresDatabase } = await import('../../src/adapters/postgres/database.js');
  const { createLogger } = await import('../../src/observability/logger.js');
  const bootstrapLogger = createLogger('silent');

  let container: Container | undefined;
  let app: FastifyInstance | undefined;
  let baseUrl: string;

  // Anything that fails from here on must not leave the simulator's listener
  // open: a leaked handle turns a clean test failure into a hung run.
  try {
    const bootstrap = new PostgresDatabase(
      { connectionString: baseDbUrl, max: 1, statementTimeoutMs: 60_000 },
      bootstrapLogger,
    );
    await bootstrap.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.close();

    container = buildContainer({ env, clock });
    await migrate(container.db, container.logger);

    app = await buildApp(container);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  } catch (e) {
    await app?.close().catch(() => undefined);
    await container?.shutdown().catch(() => undefined);
    await sim.close().catch(() => undefined);
    throw e;
  }

  const c = container!;
  const a = app!;

  // The webhook target must point at this instance, not at the configured
  // public URL, so the simulator can call back into it.
  (c.cashfree as unknown as { config: { notifyUrl: string } }).config.notifyUrl =
    `${baseUrl}/v1/webhooks/cashfree`;

  const request: Harness['request'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return {
      status: res.status,
      body: body as never,
      headers: Object.fromEntries(res.headers.entries()),
    };
  };

  const settle: Harness['settle'] = async (rounds = 12) => {
    for (let i = 0; i < rounds; i++) {
      await sim.drainWebhooks();
      const webhooks = await c.services.webhooks.processPending(500);
      const outbox = await c.services.outbox.drain(500);
      await sim.drainWebhooks();
      const more = await c.services.webhooks.processPending(500);
      if (
        webhooks.processed + webhooks.failed + outbox.processed + outbox.failed + more.processed + more.failed ===
        0
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  return {
    container: c,
    app: a,
    sim,
    clock,
    baseUrl,
    request,
    settle,
    async close() {
      await a.close();
      await sim.close();
      await c.shutdown();
      const cleanup = new PostgresDatabase(
        { connectionString: baseDbUrl, max: 1, statementTimeoutMs: 60_000 },
        bootstrapLogger,
      );
      await cleanup.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await cleanup.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** PANs that satisfy the real format check; 4th char encodes holder status. */
export const PAN_POOL = {
  individual: (n: number) => `ABCP${String.fromCharCode(65 + (n % 26))}${String(1000 + (n % 9000))}${String.fromCharCode(65 + (n % 26))}`,
  company: (n: number) => `ABCC${String.fromCharCode(65 + (n % 26))}${String(1000 + (n % 9000))}${String.fromCharCode(65 + (n % 26))}`,
};

/** Build a GSTIN with a correct check digit for a given PAN and state. */
export function makeGstin(pan: string, stateCode = '33', entityNumber = '1'): string {
  const first14 = `${stateCode}${pan}${entityNumber}Z`;
  const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = charset.indexOf(first14[i]!);
    const factor = i % 2 === 0 ? 1 : 2;
    const product = value * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return `${first14}${charset[(36 - (sum % 36)) % 36]}`;
}

export interface TestReader {
  userId: string;
  email: string;
  token: string;
}

export interface TestCreator extends TestReader {
  creatorId: string;
  workId: string;
  chapterIds: string[];
  pan: string;
  gstin: string | null;
}

let seq = 0;
function uniq(): number {
  return ++seq;
}

export async function createReader(h: Harness, label = 'reader'): Promise<TestReader> {
  const n = uniq();
  const email = `${label}.${n}.${randomUUID().slice(0, 8)}@craftguild.test`;
  const res = await h.request<{ token: string; user: { id: string } }>('POST', '/v1/auth/register', {
    body: { email, password: 'Str0ng-Passw0rd!', displayName: `${label} ${n}`, phone: `9${String(800000000 + n).slice(0, 9)}` },
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { userId: res.body.user.id, email, token: res.body.token };
}

export async function createCreator(
  h: Harness,
  options: { gstRegistered?: boolean; chapters?: number[]; label?: string } = {},
): Promise<TestCreator> {
  const n = uniq();
  const reader = await createReader(h, options.label ?? 'creator');
  const pan = PAN_POOL.individual(n);
  const gstin = options.gstRegistered ? makeGstin(pan, '33') : null;

  const onboard = await h.request<{ creatorId: string; kycStatus: string }>('POST', '/v1/creators/onboard', {
    token: reader.token,
    body: {
      legalName: `Legal Name ${n}`,
      penName: `Pen ${n}`,
      pan,
      gstin,
      stateCode: '33',
      phone: `9${String(700000000 + n).slice(0, 9)}`,
      bank: {
        accountNumber: String(100000000000 + n),
        ifsc: 'HDFC0001234',
        accountHolder: `Legal Name ${n}`,
      },
    },
  });
  if (onboard.status !== 201) throw new Error(`onboard failed: ${JSON.stringify(onboard.body)}`);

  // Re-login so the token carries the creator role.
  const login = await h.request<{ token: string }>('POST', '/v1/auth/login', {
    body: { email: reader.email, password: 'Str0ng-Passw0rd!' },
  });
  const token = login.body.token;

  const work = await h.request<{ id: string }>('POST', '/v1/works', {
    token,
    body: { title: `Work ${n}`, synopsis: 'A serialized story.' },
  });
  if (work.status !== 201) throw new Error(`create work failed: ${JSON.stringify(work.body)}`);

  const prices = options.chapters ?? [10, 10, 25];
  const chapterIds: string[] = [];
  for (const price of prices) {
    const chapter = await h.request<{ id: string }>('POST', `/v1/works/${work.body.id}/chapters`, {
      token,
      body: { title: `Chapter ${chapterIds.length + 1}`, priceCredits: price },
    });
    if (chapter.status !== 201) throw new Error(`add chapter failed: ${JSON.stringify(chapter.body)}`);
    const publish = await h.request('POST', `/v1/chapters/${chapter.body.id}/publish`, { token });
    if (publish.status !== 200) throw new Error(`publish failed: ${JSON.stringify(publish.body)}`);
    chapterIds.push(chapter.body.id);
  }

  return { ...reader, token, creatorId: onboard.body.creatorId, workId: work.body.id, chapterIds, pan, gstin };
}

/**
 * Mint a token valid at the harness's CURRENT clock.
 *
 * Tests that advance the clock across settlement windows outlive the one-hour
 * token lifetime, exactly as a real session would; they re-mint rather than
 * weaken the expiry the application enforces.
 */
export function mintToken(
  h: Harness,
  subject: { userId: string },
  role: 'reader' | 'creator' | 'admin' = 'reader',
  creatorId?: string,
): string {
  return h.container.jwt.sign(
    { sub: subject.userId, role, ...(creatorId ? { creatorId } : {}) },
    h.clock.now().getTime(),
  );
}

export async function makeAdmin(h: Harness, reader: TestReader): Promise<string> {
  await h.container.db.transaction(async (uow) => {
    await uow.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [reader.userId]);
  });
  return h.container.jwt.sign({ sub: reader.userId, role: 'admin' }, h.clock.now().getTime());
}

/** Buy credits end to end: create the order, pay it at the simulator, settle webhooks. */
export async function buyCredits(h: Harness, reader: TestReader, sku = 'coins_500'): Promise<string> {
  const res = await h.request<{ orderId: string }>('POST', '/v1/credits/orders', {
    token: reader.token,
    headers: { 'idempotency-key': `topup-${randomUUID()}` },
    body: { sku },
  });
  if (res.status !== 201) throw new Error(`topup failed: ${JSON.stringify(res.body)}`);
  h.sim.payOrder(res.body.orderId);
  await h.settle();
  return res.body.orderId;
}
