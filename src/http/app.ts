import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Container } from '../container.js';
import type { RateLimitBucket } from '../config/config.js';
import { AppError, err, isAppError } from '../domain/errors.js';
import type { TokenClaims } from '../adapters/crypto/jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: TokenClaims;
    rawBodyText?: string;
  }
}

export async function buildApp(container: Container): Promise<FastifyInstance> {
  const { config, logger } = container;

  const app = Fastify({
    logger: false,
    trustProxy: config.env.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.isProduction ? [config.env.PUBLIC_BASE_URL] : true,
    credentials: true,
    maxAge: 600,
  });

  // Keep the raw body: the webhook signature is computed over exact bytes, so
  // a re-serialised object would never verify.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBodyText = text;
    if (text.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(err.validation('http.invalid_json', 'request body is not valid JSON') as unknown as Error, undefined);
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    (req as { startedAt?: bigint }).startedAt = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (req, reply) => {
    const started = (req as { startedAt?: bigint }).startedAt;
    const durationMs = started ? Number(process.hrtime.bigint() - started) / 1e6 : 0;
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info';
    logger[level](
      {
        reqId: req.id,
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
        userId: req.auth?.sub,
      },
      'request',
    );
  });

  app.setErrorHandler((error, req, reply) => {
    if (isAppError(error)) {
      if (error.category === 'internal') {
        logger.error({ err: error, reqId: req.id, code: error.code }, 'unhandled application error');
      }
      return reply.status(error.httpStatus).send({ error: error.toJSON(), requestId: req.id });
    }

    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: {
          code: 'http.validation_failed',
          message: 'request failed validation',
          details: {
            issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          },
        },
        requestId: req.id,
      });
    }

    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({
        error: { code: 'http.bad_request', message: (error as Error).message, details: {} },
        requestId: req.id,
      });
    }

    logger.error({ err: error, reqId: req.id }, 'unexpected error');
    return reply.status(500).send({
      error: { code: 'http.internal_error', message: 'an unexpected error occurred', details: {} },
      requestId: req.id,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: { code: 'http.not_found', message: `no route for ${req.method} ${req.url}`, details: {} },
      requestId: req.id,
    });
  });

  await registerRoutes(app, container);
  return app;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

export function requireAuth(container: Container) {
  return async (req: FastifyRequest): Promise<TokenClaims> => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw err.unauthorized('auth.missing_token', 'an Authorization: Bearer token is required');
    }
    const claims = container.jwt.verify(header.slice(7).trim(), container.clock.now().getTime());
    req.auth = claims;
    return claims;
  };
}

function requireRole(claims: TokenClaims, ...roles: TokenClaims['role'][]): void {
  if (!roles.includes(claims.role)) {
    throw err.forbidden('auth.insufficient_role', `this endpoint requires role: ${roles.join(' or ')}`);
  }
}

function clientKey(req: FastifyRequest): string {
  return req.auth?.sub ?? req.ip ?? 'anonymous';
}

function idempotencyKeyOf(req: FastifyRequest): string {
  const key = req.headers['idempotency-key'];
  const value = Array.isArray(key) ? key[0] : key;
  if (!value || value.length < 8 || value.length > 200) {
    throw err.validation(
      'http.missing_idempotency_key',
      'an Idempotency-Key header between 8 and 200 characters is required for this operation',
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(256),
  displayName: z.string().min(1).max(80),
  phone: z.string().optional(),
});

const LoginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(256) });

const OnboardCreatorSchema = z.object({
  legalName: z.string().min(2).max(160),
  penName: z.string().min(1).max(80),
  pan: z.string().length(10),
  gstin: z.string().length(15).nullish(),
  stateCode: z.string().length(2).nullish(),
  phone: z.string().min(10).max(15),
  bank: z
    .object({
      accountNumber: z.string().min(6).max(18),
      ifsc: z.string().length(11),
      accountHolder: z.string().min(2).max(160),
    })
    .optional(),
  upiVpa: z.string().min(5).max(128).optional(),
});

const CreateWorkSchema = z.object({ title: z.string().min(1).max(200), synopsis: z.string().max(4000).optional() });

const AddChapterSchema = z.object({
  title: z.string().min(1).max(200),
  priceCredits: z.number().int().min(0).max(100_000),
  bodyUri: z.string().max(1000).optional(),
});

const TopUpSchema = z.object({ sku: z.string().min(1).max(64) });

const TipSchema = z.object({
  creatorId: z.string().min(10).max(64),
  amountPaise: z.number().int().min(1000).max(100_000_00),
  message: z.string().max(200).optional(),
});

const RefundSchema = z.object({
  mode: z.enum(['to_credits', 'to_source']).default('to_credits'),
  reason: z.string().min(3).max(500),
});

const GstinSchema = z.object({ gstin: z.string().length(15).nullable() });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function registerRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const { services, config, rateLimiter, logger } = container;
  const auth = requireAuth(container);

  // Rate limits are configuration, not literals: operations must be able to
  // widen a throttle during a launch spike without shipping a build.
  const limit = async (req: FastifyRequest, bucket: RateLimitBucket) => {
    const { burst, perMinute } = config.rateLimits[bucket];
    const result = await rateLimiter.consume(`${bucket}:${clientKey(req)}`, burst, perMinute);
    if (!result.allowed) {
      throw err.rateLimited('http.rate_limited', 'too many requests', {
        retryAfterMs: result.retryAfterMs,
      });
    }
  };

  // -- health -------------------------------------------------------------
  app.get('/healthz', async () => ({ status: 'ok', time: container.clock.now().toISOString() }));

  app.get('/readyz', async (_req, reply) => {
    const [db, redis] = await Promise.all([container.db.healthy(), container.redis.healthy()]);
    const ready = db && redis;
    return reply.status(ready ? 200 : 503).send({
      ready,
      checks: { database: db, redis: redis },
      paymentAggregator: container.cashfree.metrics.circuitState,
    });
  });

  app.get('/metrics', async () => ({
    paymentAggregator: container.cashfree.metrics,
    databasePool: container.db.poolStats,
    outboxDeadLetters: await services.outbox.deadLetterCount(),
  }));

  // -- auth ---------------------------------------------------------------
  app.post('/v1/auth/register', async (req, reply) => {
    await limit(req, 'auth');
    const body = RegisterSchema.parse(req.body);
    const result = await services.auth.register(body);
    return reply.status(201).send(result);
  });

  app.post('/v1/auth/login', async (req, reply) => {
    await limit(req, 'auth');
    const body = LoginSchema.parse(req.body);
    return reply.send(await services.auth.login(body));
  });

  app.get('/v1/me', async (req) => {
    const claims = await auth(req);
    const creator = await services.creators.byUserId(claims.sub);
    const wallet = await services.credits.walletBalance(claims.sub);
    return {
      userId: claims.sub,
      role: claims.role,
      wallet,
      creator: creator
        ? {
            id: creator.id,
            penName: creator.penName,
            kycStatus: creator.kycStatus,
            payoutsEnabled: creator.payoutsEnabled,
            gstRegistered: !!creator.gstin,
          }
        : null,
    };
  });

  // -- creator onboarding -------------------------------------------------
  app.post('/v1/creators/onboard', async (req, reply) => {
    const claims = await auth(req);
    await limit(req, 'onboard');
    const body = OnboardCreatorSchema.parse(req.body);

    const userRes = await container.db.transaction(
      async (uow) => {
        const res = await uow.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [claims.sub]);
        return res.rows[0];
      },
      { readOnly: true },
    );
    if (!userRes) throw err.notFound('creator.user_missing', 'user does not exist');

    const creator = await services.creators.onboard({
      userId: claims.sub,
      legalName: body.legalName,
      penName: body.penName,
      pan: body.pan,
      gstin: body.gstin ?? null,
      stateCode: body.stateCode ?? null,
      phone: body.phone,
      email: userRes.email,
      ...(body.bank ? { bank: body.bank } : {}),
      ...(body.upiVpa ? { upiVpa: body.upiVpa } : {}),
    });

    return reply.status(201).send({
      creatorId: creator.id,
      kycStatus: creator.kycStatus,
      payoutsEnabled: creator.payoutsEnabled,
      vendorRef: creator.vendorRef,
    });
  });

  app.post('/v1/creators/me/retry-kyc', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'creator', 'admin');
    const creator = await services.creators.byUserId(claims.sub);
    if (!creator) throw err.notFound('creator.not_found', 'no creator profile for this user');
    const updated = await services.creators.retryVendorRegistration(creator.id);
    return { kycStatus: updated.kycStatus, payoutsEnabled: updated.payoutsEnabled };
  });

  app.put('/v1/creators/me/gstin', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'creator', 'admin');
    const body = GstinSchema.parse(req.body);
    const creator = await services.creators.byUserId(claims.sub);
    if (!creator) throw err.notFound('creator.not_found', 'no creator profile for this user');
    const updated = await services.creators.updateGstin(creator.id, body.gstin);
    return { gstin: updated.gstin, stateCode: updated.stateCode };
  });

  // -- catalogue ----------------------------------------------------------
  app.post('/v1/works', async (req, reply) => {
    const claims = await auth(req);
    requireRole(claims, 'creator', 'admin');
    const body = CreateWorkSchema.parse(req.body);
    const creator = await services.creators.byUserId(claims.sub);
    if (!creator) throw err.forbidden('catalog.not_a_creator', 'complete creator onboarding first');
    const work = await services.catalog.createWork({ creatorId: creator.id, ...body });
    return reply.status(201).send(work);
  });

  app.post('/v1/works/:workId/chapters', async (req, reply) => {
    const claims = await auth(req);
    requireRole(claims, 'creator', 'admin');
    const { workId } = req.params as { workId: string };
    const body = AddChapterSchema.parse(req.body);
    const creator = await services.creators.byUserId(claims.sub);
    if (!creator) throw err.forbidden('catalog.not_a_creator', 'complete creator onboarding first');
    const chapter = await services.catalog.addChapter({ creatorId: creator.id, workId, ...body });
    return reply.status(201).send(chapter);
  });

  app.post('/v1/chapters/:chapterId/publish', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'creator', 'admin');
    const { chapterId } = req.params as { chapterId: string };
    const creator = await services.creators.byUserId(claims.sub);
    if (!creator) throw err.forbidden('catalog.not_a_creator', 'complete creator onboarding first');
    return services.catalog.publishChapter(creator.id, chapterId);
  });

  app.get('/v1/works/:workId/chapters', async (req) => {
    const { workId } = req.params as { workId: string };
    const chapters = await services.catalog.listPublishedChapters(workId);
    return { chapters };
  });

  // -- credits and payments ----------------------------------------------
  app.get('/v1/credits/bundles', async () => ({
    bundles: config.feeSchedule.creditBundles.map((b) => ({
      sku: b.sku,
      label: b.label,
      pricePaise: b.pricePaise,
      credits: b.credits + b.bonusCredits,
    })),
    creditValuePaise: config.feeSchedule.creditValuePaise,
  }));

  app.post('/v1/credits/orders', async (req, reply) => {
    const claims = await auth(req);
    await limit(req, 'payment');
    const body = TopUpSchema.parse(req.body);
    const key = idempotencyKeyOf(req);

    const user = await container.db.transaction(
      async (uow) => {
        const res = await uow.query<{ email: string; phone: string | null; display_name: string }>(
          'SELECT email, phone, display_name FROM users WHERE id = $1',
          [claims.sub],
        );
        return res.rows[0]!;
      },
      { readOnly: true },
    );

    const outcome = await services.idempotency.run({
      scope: 'credits.order',
      key,
      userId: claims.sub,
      request: body,
      work: async (uow) => {
        const result = await services.credits.createTopUpOrder(
          {
            userId: claims.sub,
            sku: body.sku,
            idempotencyKey: key,
            customer: {
              email: user.email,
              phone: user.phone ?? '9999999999',
              name: user.display_name,
            },
          },
          uow,
        );
        return { status: 201, body: result };
      },
    });

    return reply.status(outcome.status).header('idempotent-replay', String(outcome.replayed)).send(outcome.body);
  });

  app.post('/v1/tips', async (req, reply) => {
    const claims = await auth(req);
    await limit(req, 'payment');
    const body = TipSchema.parse(req.body);
    const key = idempotencyKeyOf(req);

    const user = await container.db.transaction(
      async (uow) => {
        const res = await uow.query<{ email: string; phone: string | null; display_name: string }>(
          'SELECT email, phone, display_name FROM users WHERE id = $1',
          [claims.sub],
        );
        return res.rows[0]!;
      },
      { readOnly: true },
    );

    const outcome = await services.idempotency.run({
      scope: 'tips.create',
      key,
      userId: claims.sub,
      request: body,
      work: async (uow) => {
        const result = await services.credits.createTipOrder(
          {
            userId: claims.sub,
            creatorId: body.creatorId,
            amountPaise: body.amountPaise,
            idempotencyKey: key,
            customer: { email: user.email, phone: user.phone ?? '9999999999', name: user.display_name },
            ...(body.message ? { message: body.message } : {}),
          },
          uow,
        );
        return { status: 201, body: result };
      },
    });

    return reply.status(outcome.status).header('idempotent-replay', String(outcome.replayed)).send(outcome.body);
  });

  app.get('/v1/credits/wallet', async (req) => {
    const claims = await auth(req);
    return services.credits.walletBalance(claims.sub);
  });

  // -- redemption ---------------------------------------------------------
  app.post('/v1/chapters/:chapterId/unlock', async (req, reply) => {
    const claims = await auth(req);
    await limit(req, 'unlock');
    const { chapterId } = req.params as { chapterId: string };

    const result = await container.db.transaction(async (uow) =>
      services.redemption.unlockChapter(uow, { userId: claims.sub, chapterId }),
    );
    return reply.status(result.alreadyOwned ? 200 : 201).send(result);
  });

  app.get('/v1/me/entitlements', async (req) => {
    const claims = await auth(req);
    const query = req.query as { limit?: string; offset?: string };
    return {
      entitlements: await services.redemption.listEntitlements(
        claims.sub,
        Number(query.limit ?? 50),
        Number(query.offset ?? 0),
      ),
    };
  });

  // -- refunds ------------------------------------------------------------
  app.post('/v1/redemptions/:redemptionId/refund', async (req, reply) => {
    const claims = await auth(req);
    const { redemptionId } = req.params as { redemptionId: string };
    const body = RefundSchema.parse(req.body ?? {});
    const key = idempotencyKeyOf(req);

    const outcome = await services.idempotency.run({
      scope: 'refund.create',
      key,
      userId: claims.sub,
      request: { redemptionId, ...body },
      work: async (uow) => {
        // A reader may only refund their own purchase; an admin may refund any.
        const owner = await uow.query<{ user_id: string }>('SELECT user_id FROM redemptions WHERE id = $1', [
          redemptionId,
        ]);
        if (owner.rowCount === 0) throw err.notFound('refund.redemption_not_found', 'redemption does not exist');
        if (claims.role !== 'admin' && owner.rows[0]!.user_id !== claims.sub) {
          throw err.forbidden('refund.not_owner', 'this purchase belongs to another reader');
        }

        const result = await services.refunds.refundRedemption(uow, {
          redemptionId,
          mode: body.mode,
          reason: body.reason,
          requestedBy: claims.sub,
          idempotencyKey: key,
        });
        return { status: 201, body: result };
      },
    });

    return reply.status(outcome.status).send(outcome.body);
  });

  // -- creator earnings ---------------------------------------------------
  app.get('/v1/creators/me/statements', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'creator', 'admin');
    const creator = await services.creators.byUserId(claims.sub);
    if (!creator) throw err.notFound('creator.not_found', 'no creator profile for this user');
    return { statements: await services.settlement.statementsFor(creator.id) };
  });

  app.get('/v1/creators/me/balance', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'creator', 'admin');
    const creator = await services.creators.byUserId(claims.sub);
    if (!creator) throw err.notFound('creator.not_found', 'no creator profile for this user');

    return container.db.transaction(
      async (uow) => ({
        creatorId: creator.id,
        payablePaise: await container.ledger.accountBalance(uow, 'CREATOR_PAYABLE', creator.id),
        reservePaise: await container.ledger.accountBalance(uow, 'RESERVE_HOLDBACK', creator.id),
        inFlightPayoutPaise: await container.ledger.accountBalance(uow, 'PAYOUT_CLEARING', creator.id),
        minimumPayoutPaise: config.feeSchedule.minimumPayoutPaise,
      }),
      { readOnly: true },
    );
  });

  // -- webhooks -----------------------------------------------------------
  app.post('/v1/webhooks/cashfree', async (req, reply) => {
    const raw = req.rawBodyText;
    if (raw === undefined) {
      throw err.validation('webhook.no_body', 'webhook body was not captured');
    }
    try {
      const result = await services.webhooks.ingest(raw, req.headers as Record<string, string | string[] | undefined>);
      // Always 200 on a verified delivery so the aggregator stops retrying;
      // processing happens asynchronously and has its own retry budget.
      return reply.status(200).send({ received: true, duplicate: result.duplicate });
    } catch (e) {
      if (isAppError(e) && e.category === 'unauthorized') {
        logger.warn({ reqId: req.id, code: e.code }, 'rejected webhook delivery');
        return reply.status(401).send({ error: e.toJSON() });
      }
      throw e;
    }
  });

  // -- admin --------------------------------------------------------------
  app.post('/v1/admin/settlements/close', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'admin');
    const body = (req.body ?? {}) as { periodId?: string };
    if (body.periodId) return { results: [await services.settlement.closePeriod(body.periodId)] };
    return { results: await services.settlement.closeDuePeriods() };
  });

  app.post('/v1/admin/payouts/dispatch', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'admin');
    const queued = await services.payouts.listQueued(200);
    const results: { payoutId: string; status: string; error?: string }[] = [];
    for (const p of queued) {
      try {
        const r = await services.payouts.dispatch(p.id);
        results.push({ payoutId: p.id, status: r.status });
      } catch (e) {
        results.push({ payoutId: p.id, status: 'error', error: (e as Error).message });
      }
    }
    return { dispatched: results.length, results };
  });

  app.post('/v1/admin/webhooks/process', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'admin');
    return services.webhooks.processPending(100);
  });

  app.post('/v1/admin/outbox/drain', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'admin');
    return services.outbox.drain(100);
  });

  app.get('/v1/admin/reports/trial-balance', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'admin');
    return services.reporting.trialBalance();
  });

  app.get('/v1/admin/reports/reconcile', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'admin');
    return services.reporting.reconcile();
  });

  app.get('/v1/admin/reports/gstr8/:periodId', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'admin');
    const { periodId } = req.params as { periodId: string };
    return services.reporting.gstr8(periodId);
  });

  app.get('/v1/admin/reports/26q/:periodId', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'admin');
    const { periodId } = req.params as { periodId: string };
    return services.reporting.tds26Q(periodId);
  });

  app.get('/v1/admin/reports/gst-turnover', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'admin');
    const q = req.query as { period?: string };
    return { periods: await services.reporting.platformGstTurnover(q.period) };
  });

  app.get('/v1/admin/summary', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'admin');
    return services.reporting.platformSummary();
  });

  app.post('/v1/admin/maintenance/run', async (req) => {
    const claims = await auth(req);
    requireRole(claims, 'admin');
    return {
      creditsExpired: await services.maintenance.expireCredits(),
      staleOrdersExpired: await services.maintenance.expireStaleOrders(),
      idempotencyKeysPurged: await services.maintenance.purgeExpiredIdempotencyKeys(),
      gstThresholdFlags: await services.maintenance.flagCreatorsNearingGstThreshold(),
    };
  });
}

export type { FastifyInstance, FastifyReply };
export { AppError };
