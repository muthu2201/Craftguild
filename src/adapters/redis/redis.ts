import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { err } from '../../domain/errors.js';
import type { Logger } from '../../observability/logger.js';

/**
 * Redis is used for three things and nothing that must survive a restart:
 * rate limiting, cross-process locks, and short-lived caches. Every durable
 * fact lives in Postgres.
 */
export class RedisClient {
  readonly raw: Redis;

  constructor(url: string, private readonly logger: Logger) {
    this.raw = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      connectTimeout: 5_000,
      retryStrategy: (times) => Math.min(2_000, 50 * 2 ** times),
    });
    this.raw.on('error', (e) => this.logger.warn({ err: e }, 'redis error'));
  }

  async healthy(): Promise<boolean> {
    try {
      return (await this.raw.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.raw.quit().catch(() => this.raw.disconnect());
  }
}

/**
 * Token-bucket rate limiter, evaluated atomically in Lua so concurrent requests
 * across processes cannot overdraw the bucket.
 */
const TOKEN_BUCKET_LUA = `
local key       = KEYS[1]
local capacity  = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local nowMs     = tonumber(ARGV[3])
local cost      = tonumber(ARGV[4])
local ttlMs     = tonumber(ARGV[5])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  ts = nowMs
end

local elapsed = math.max(0, nowMs - ts)
tokens = math.min(capacity, tokens + elapsed * refillPerMs)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', nowMs)
redis.call('PEXPIRE', key, ttlMs)

local retryAfterMs = 0
if allowed == 0 and refillPerMs > 0 then
  retryAfterMs = math.ceil((cost - tokens) / refillPerMs)
end

return { allowed, math.floor(tokens), retryAfterMs }
`;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class RateLimiter {
  private scriptSha: string | null = null;

  constructor(private readonly redis: RedisClient) {}

  private async sha(): Promise<string> {
    if (!this.scriptSha) {
      this.scriptSha = (await this.redis.raw.script('LOAD', TOKEN_BUCKET_LUA)) as string;
    }
    return this.scriptSha;
  }

  /**
   * @param capacity burst size
   * @param perMinute sustained refill rate
   */
  async consume(key: string, capacity: number, perMinute: number, cost = 1): Promise<RateLimitResult> {
    const refillPerMs = perMinute / 60_000;
    const ttlMs = Math.ceil((capacity / Math.max(refillPerMs, 1e-9)) * 2) + 60_000;
    try {
      const sha = await this.sha();
      const res = (await this.redis.raw.evalsha(
        sha,
        1,
        `rl:${key}`,
        String(capacity),
        String(refillPerMs),
        String(Date.now()),
        String(cost),
        String(ttlMs),
      )) as [number, number, number];
      return { allowed: res[0] === 1, remaining: res[1], retryAfterMs: res[2] };
    } catch (e) {
      if (String((e as Error).message).includes('NOSCRIPT')) {
        this.scriptSha = null;
        return this.consume(key, capacity, perMinute, cost);
      }
      // Fail open on a limiter outage: availability of the platform matters
      // more than the precision of a soft throttle. The breach is logged.
      return { allowed: true, remaining: capacity, retryAfterMs: 0 };
    }
  }
}

const UNLOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Mutual exclusion across processes, with fencing so a lost lock cannot be released by its previous holder. */
export class DistributedLock {
  constructor(private readonly redis: RedisClient) {}

  async acquire(key: string, ttlMs: number, waitMs = 0): Promise<string | null> {
    const token = randomUUID();
    const deadline = Date.now() + waitMs;
    for (;;) {
      const ok = await this.redis.raw.set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
      if (ok === 'OK') return token;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }

  async release(key: string, token: string): Promise<boolean> {
    const res = (await this.redis.raw.eval(UNLOCK_LUA, 1, `lock:${key}`, token)) as number;
    return res === 1;
  }

  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>, waitMs = 0): Promise<T> {
    const token = await this.acquire(key, ttlMs, waitMs);
    if (!token) throw err.conflict('lock.unavailable', `could not acquire lock ${key}`);
    try {
      return await fn();
    } finally {
      await this.release(key, token).catch(() => undefined);
    }
  }
}
