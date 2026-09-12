import { loadConfig, type AppConfig } from './config/config.js';
import { createLogger, type Logger } from './observability/logger.js';
import { PostgresDatabase } from './adapters/postgres/database.js';
import { PostgresLedgerRepository } from './adapters/postgres/ledger.repository.js';
import { RedisClient, RateLimiter, DistributedLock } from './adapters/redis/redis.js';
import { CashfreeAdapter } from './adapters/cashfree/cashfree.adapter.js';
import { ScryptPasswordHasher } from './adapters/crypto/passwords.js';
import { JwtSigner } from './adapters/crypto/jwt.js';
import { systemClock, type Clock } from './domain/clock.js';
import { StatutoryTaxPolicy } from './domain/tax/policy.js';
import { AuthService } from './app/auth.service.js';
import { CreatorService } from './app/creator.service.js';
import { CatalogService } from './app/catalog.service.js';
import { CreditsService } from './app/credits.service.js';
import { RedemptionService } from './app/redemption.service.js';
import { RefundService } from './app/refund.service.js';
import { SettlementPeriodService } from './app/settlement-period.service.js';
import { SettlementService } from './app/settlement.service.js';
import { PayoutService } from './app/payout.service.js';
import { WebhookService } from './app/webhook.service.js';
import { ReportingService } from './app/reporting.service.js';
import { IdempotencyService } from './app/idempotency.service.js';
import { OutboxService, registerStandardHandlers } from './app/outbox.service.js';
import { RiskService, DEFAULT_RISK_LIMITS } from './app/risk.service.js';
import { MaintenanceService } from './app/maintenance.service.js';

/** The composition root. Nothing else constructs an adapter. */
export interface Container {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  db: PostgresDatabase;
  redis: RedisClient;
  rateLimiter: RateLimiter;
  locks: DistributedLock;
  cashfree: CashfreeAdapter;
  ledger: PostgresLedgerRepository;
  jwt: JwtSigner;
  hasher: ScryptPasswordHasher;
  services: {
    auth: AuthService;
    creators: CreatorService;
    catalog: CatalogService;
    credits: CreditsService;
    redemption: RedemptionService;
    refunds: RefundService;
    periods: SettlementPeriodService;
    settlement: SettlementService;
    payouts: PayoutService;
    webhooks: WebhookService;
    reporting: ReportingService;
    idempotency: IdempotencyService;
    outbox: OutboxService;
    risk: RiskService;
    maintenance: MaintenanceService;
  };
  shutdown(): Promise<void>;
}

export function buildContainer(options: { env?: NodeJS.ProcessEnv; clock?: Clock } = {}): Container {
  const config = loadConfig(options.env);
  const logger = createLogger(config.env.LOG_LEVEL);
  const clock = options.clock ?? systemClock;

  const db = new PostgresDatabase(
    {
      connectionString: config.env.DATABASE_URL,
      max: config.env.DATABASE_POOL_MAX,
      statementTimeoutMs: config.env.DATABASE_STATEMENT_TIMEOUT_MS,
      applicationName: 'craftguild-api',
    },
    logger,
  );

  const redis = new RedisClient(config.env.REDIS_URL, logger);
  const rateLimiter = new RateLimiter(redis);
  const locks = new DistributedLock(redis);

  const cashfree = new CashfreeAdapter(
    {
      baseUrl: config.env.CASHFREE_BASE_URL,
      appId: config.env.CASHFREE_APP_ID,
      secretKey: config.env.CASHFREE_SECRET_KEY,
      apiVersion: config.env.CASHFREE_API_VERSION,
      webhookSecret: config.env.CASHFREE_WEBHOOK_SECRET,
      timeoutMs: config.env.CASHFREE_TIMEOUT_MS,
      maxRetries: config.env.CASHFREE_MAX_RETRIES,
      notifyUrl: `${config.env.PUBLIC_BASE_URL}/v1/webhooks/cashfree`,
      returnUrl: `${config.env.PUBLIC_BASE_URL}/checkout/return?order_id={order_id}`,
    },
    logger,
  );

  const ledger = new PostgresLedgerRepository();
  const jwt = new JwtSigner({ secret: config.env.JWT_SECRET, ttlSeconds: config.env.JWT_TTL_SECONDS });
  const hasher = new ScryptPasswordHasher(config.env.PASSWORD_PEPPER);
  const taxPolicy = new StatutoryTaxPolicy();

  const risk = new RiskService(
    {
      ...DEFAULT_RISK_LIMITS,
      maxTopUpsPerHour: config.env.MAX_TOPUP_PER_HOUR,
      maxTopUpValuePerDay: Math.round(config.env.MAX_TOPUP_VALUE_PER_DAY_RUPEES * 100),
    },
    logger,
  );

  const auth = new AuthService(db, hasher, jwt, clock, config.env.JWT_TTL_SECONDS);
  const creators = new CreatorService(db, cashfree, auth, clock, logger, config.env.FIRST_PAYOUT_HOLD_DAYS);
  const catalog = new CatalogService(db, clock, config.feeSchedule.creditValuePaise);
  const periods = new SettlementPeriodService(db, clock, config.settlement.accrualDays, config.settlement.graceDays);
  const credits = new CreditsService(db, cashfree, ledger, periods, risk, config.feeSchedule, clock, logger);
  const redemption = new RedemptionService(db, ledger, periods, risk, config.feeSchedule, clock, logger);
  const refunds = new RefundService(db, cashfree, ledger, periods, clock, config.feeSchedule.creditValuePaise, logger);
  const payouts = new PayoutService(db, cashfree, ledger, config.feeSchedule, clock, logger);
  const settlement = new SettlementService(db, ledger, periods, taxPolicy, risk, config.feeSchedule, clock, logger);
  const webhooks = new WebhookService(db, cashfree, credits, refunds, payouts, creators, clock, logger);
  const reporting = new ReportingService(db, ledger);
  const idempotency = new IdempotencyService(db, clock);
  const outbox = new OutboxService(db, clock, logger);
  const maintenance = new MaintenanceService(db, ledger, clock, config.feeSchedule, logger);

  registerStandardHandlers(outbox, { db, payments: cashfree, payouts, logger });

  return {
    config,
    logger,
    clock,
    db,
    redis,
    rateLimiter,
    locks,
    cashfree,
    ledger,
    jwt,
    hasher,
    services: {
      auth,
      creators,
      catalog,
      credits,
      redemption,
      refunds,
      periods,
      settlement,
      payouts,
      webhooks,
      reporting,
      idempotency,
      outbox,
      risk,
      maintenance,
    },
    async shutdown() {
      logger.info('shutting down');
      await Promise.allSettled([cashfree.close(), redis.close(), db.close()]);
    },
  };
}
