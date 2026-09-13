import { z } from 'zod';
import { DEFAULT_FEE_SCHEDULE, type FeeSchedule } from '../domain/pricing/fee-schedule.js';

/**
 * Configuration is validated once at boot and then immutable. A missing
 * production secret is a startup failure, never a silent default.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(v)));

const int = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : Number(v)))
    .pipe(z.number().int().min(min));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : Number(v)))
    .pipe(z.number());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(8080, 1),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: int(20, 1),
  DATABASE_STATEMENT_TIMEOUT_MS: int(15_000, 100),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_SECONDS: int(3600, 60),
  PASSWORD_PEPPER: z.string().default(''),

  // Payment aggregator (Cashfree Payments: PG + Easy Split)
  CASHFREE_BASE_URL: z.string().default('https://sandbox.cashfree.com'),
  CASHFREE_APP_ID: z.string().min(1, 'CASHFREE_APP_ID is required'),
  CASHFREE_SECRET_KEY: z.string().min(1, 'CASHFREE_SECRET_KEY is required'),
  CASHFREE_API_VERSION: z.string().default('2023-08-01'),
  CASHFREE_WEBHOOK_SECRET: z.string().min(1, 'CASHFREE_WEBHOOK_SECRET is required'),
  CASHFREE_TIMEOUT_MS: int(12_000, 500),
  CASHFREE_MAX_RETRIES: int(3, 0),
  PUBLIC_BASE_URL: z.string().default('http://localhost:8080'),

  // Commercial policy
  PLATFORM_FEE_PERCENT: num(10),
  TIP_FEE_PERCENT: num(0),
  PG_FEE_PERCENT: num(2.0),
  SPLIT_FEE_PERCENT: num(0.25),
  RESERVE_PERCENT: num(10),
  MINIMUM_PAYOUT_RUPEES: num(100),
  FIRST_PAYOUT_HOLD_DAYS: int(7, 0),

  // Settlement
  SETTLEMENT_ACCRUAL_DAYS: int(30, 1),
  SETTLEMENT_GRACE_DAYS: int(5, 0),

  // Risk controls
  MAX_TOPUP_PER_HOUR: int(10, 1),
  MAX_TOPUP_VALUE_PER_DAY_RUPEES: num(50_000),
  RATE_LIMIT_RPM: int(300, 1),
  // Per-endpoint throttles. Each is "burst capacity" paired with a sustained
  // per-minute refill, tuned separately because a login attempt and a chapter
  // unlock have very different legitimate rates.
  RATE_LIMIT_AUTH_BURST: int(10, 1),
  RATE_LIMIT_AUTH_PER_MINUTE: int(30, 1),
  RATE_LIMIT_PAYMENT_BURST: int(10, 1),
  RATE_LIMIT_PAYMENT_PER_MINUTE: int(30, 1),
  RATE_LIMIT_UNLOCK_BURST: int(60, 1),
  RATE_LIMIT_UNLOCK_PER_MINUTE: int(240, 1),
  RATE_LIMIT_ONBOARD_BURST: int(5, 1),
  RATE_LIMIT_ONBOARD_PER_MINUTE: int(10, 1),

  // Workers
  WORKER_CONCURRENCY: int(4, 1),
  WORKER_POLL_INTERVAL_MS: int(250, 50),
  // Run the background loops inside the API process instead of a separate
  // worker. A single-container deployment is the cheapest way to host this and
  // is safe because every loop already claims its work with SKIP LOCKED or an
  // advisory lock; co-locating them changes who runs a loop, not how.
  RUN_WORKER_IN_PROCESS: bool(false),

  TRUST_PROXY: bool(false),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  readonly env: Env;
  readonly isProduction: boolean;
  readonly feeSchedule: FeeSchedule;
  readonly settlement: { readonly accrualDays: number; readonly graceDays: number };
  readonly rateLimits: Record<RateLimitBucket, { readonly burst: number; readonly perMinute: number }>;
}

export type RateLimitBucket = 'auth' | 'payment' | 'unlock' | 'onboard';

function percentToPpm(p: number): number {
  return Math.round(p * 10_000);
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const env = parsed.data;

  if (env.NODE_ENV === 'production') {
    if (env.CASHFREE_BASE_URL.includes('sandbox')) {
      throw new Error('CASHFREE_BASE_URL points at sandbox while NODE_ENV=production');
    }
    if (env.JWT_SECRET.length < 48) {
      throw new Error('JWT_SECRET must be at least 48 characters in production');
    }
  }

  const feeSchedule: FeeSchedule = {
    ...DEFAULT_FEE_SCHEDULE,
    platformFeePpm: percentToPpm(env.PLATFORM_FEE_PERCENT),
    tipFeePpm: percentToPpm(env.TIP_FEE_PERCENT),
    pgFeePpm: percentToPpm(env.PG_FEE_PERCENT),
    splitFeePpm: percentToPpm(env.SPLIT_FEE_PERCENT),
    reservePpm: percentToPpm(env.RESERVE_PERCENT),
    minimumPayoutPaise: Math.round(env.MINIMUM_PAYOUT_RUPEES * 100),
  };

  return {
    env,
    isProduction: env.NODE_ENV === 'production',
    feeSchedule,
    settlement: { accrualDays: env.SETTLEMENT_ACCRUAL_DAYS, graceDays: env.SETTLEMENT_GRACE_DAYS },
    rateLimits: {
      auth: { burst: env.RATE_LIMIT_AUTH_BURST, perMinute: env.RATE_LIMIT_AUTH_PER_MINUTE },
      payment: { burst: env.RATE_LIMIT_PAYMENT_BURST, perMinute: env.RATE_LIMIT_PAYMENT_PER_MINUTE },
      unlock: { burst: env.RATE_LIMIT_UNLOCK_BURST, perMinute: env.RATE_LIMIT_UNLOCK_PER_MINUTE },
      onboard: { burst: env.RATE_LIMIT_ONBOARD_BURST, perMinute: env.RATE_LIMIT_ONBOARD_PER_MINUTE },
    },
  };
}
