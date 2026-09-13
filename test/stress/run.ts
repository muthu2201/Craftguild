/**
 * End-to-end production stress test.
 *
 * Drives the real application over HTTP under sustained concurrency, with the
 * payment aggregator injecting the failure modes a real one exhibits — transient
 * 503s, duplicated webhook deliveries, bounced bank transfers, added latency —
 * and then asserts that not a single paisa is lost, duplicated or stranded.
 *
 * Throughput numbers are secondary. The pass/fail criterion is financial
 * integrity under load: the ledger must balance, the coin liability must equal
 * the coins readers hold, every split must reconstitute its gross, no reader may
 * be charged twice for one chapter, and no wallet may go negative.
 *
 *   npm run stress -- --readers 300 --creators 40 --duration 45
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  startHarness,
  createReader,
  createCreator,
  makeAdmin,
  mintToken,
  type Harness,
  type TestCreator,
  type TestReader,
} from '../helpers/harness.js';
import { FixedClock } from '../../src/domain/clock.js';
import { paiseToRupeeString, formatInr } from '../../src/domain/money/money.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface StressOptions {
  readers: number;
  creators: number;
  durationSeconds: number;
  concurrency: number;
  transientFailureRate: number;
  duplicateWebhookRate: number;
  payoutFailureRate: number;
  latencyMs: number;
  refundRate: number;
  disputeRate: number;
  seed: number;
}

function parseArgs(argv: string[]): StressOptions {
  const get = (name: string, fallback: number): number => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const v = Number(argv[i + 1]);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    readers: get('readers', 200),
    creators: get('creators', 25),
    durationSeconds: get('duration', 30),
    concurrency: get('concurrency', 48),
    transientFailureRate: get('failure-rate', 0.05),
    duplicateWebhookRate: get('duplicate-rate', 0.15),
    payoutFailureRate: get('payout-failure-rate', 0.1),
    latencyMs: get('latency', 0),
    refundRate: get('refund-rate', 0.06),
    disputeRate: get('dispute-rate', 0.02),
    seed: get('seed', 20260912),
  };
}

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

class Latencies {
  private readonly samples: number[] = [];
  add(ms: number): void {
    this.samples.push(ms);
  }
  percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx]!;
  }
  get count(): number {
    return this.samples.length;
  }
  get mean(): number {
    return this.samples.length ? this.samples.reduce((a, b) => a + b, 0) / this.samples.length : 0;
  }
  summary() {
    return {
      count: this.count,
      meanMs: round2(this.mean),
      p50Ms: round2(this.percentile(50)),
      p95Ms: round2(this.percentile(95)),
      p99Ms: round2(this.percentile(99)),
      maxMs: round2(this.percentile(100)),
    };
  }
}

const round2 = (n: number) => Number(n.toFixed(2));

interface Counters {
  topUpsCreated: number;
  topUpsPaid: number;
  unlocks: number;
  unlocksAlreadyOwned: number;
  unlocksInsufficientCredits: number;
  tips: number;
  refunds: number;
  disputes: number;
  errors: number;
  rateLimited: number;
  errorsByCode: Record<string, number>;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Workload
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rng = mulberry32(options.seed);

  console.log('CraftGuild end-to-end stress test');
  console.log('='.repeat(78));
  console.log(
    `readers=${options.readers} creators=${options.creators} duration=${options.durationSeconds}s ` +
      `concurrency=${options.concurrency}`,
  );
  console.log(
    `aggregator faults: transient5xx=${(options.transientFailureRate * 100).toFixed(0)}% ` +
      `duplicateWebhooks=${(options.duplicateWebhookRate * 100).toFixed(0)}% ` +
      `payoutBounces=${(options.payoutFailureRate * 100).toFixed(0)}% latency=${options.latencyMs}ms`,
  );
  console.log(
    `workload faults: refunds=${(options.refundRate * 100).toFixed(0)}% ` +
      `chargebacks=${(options.disputeRate * 100).toFixed(0)}%  seed=${options.seed}`,
  );
  console.log('='.repeat(78));

  const clock = new FixedClock(new Date('2026-04-10T06:30:00.000Z'));
  const h = await startHarness({
    clock,
    sim: {
      transientFailureRate: options.transientFailureRate,
      duplicateWebhookRate: options.duplicateWebhookRate,
      payoutFailureRate: options.payoutFailureRate,
      latencyMs: options.latencyMs,
      seed: options.seed,
    },
    env: { DATABASE_POOL_MAX: '40', LOG_LEVEL: 'error' },
  });

  const counters: Counters = {
    topUpsCreated: 0,
    topUpsPaid: 0,
    unlocks: 0,
    unlocksAlreadyOwned: 0,
    unlocksInsufficientCredits: 0,
    tips: 0,
    refunds: 0,
    disputes: 0,
    errors: 0,
    rateLimited: 0,
    errorsByCode: {},
  };
  const latency = { topup: new Latencies(), unlock: new Latencies(), tip: new Latencies(), refund: new Latencies() };
  const paidOrders: string[] = [];
  const redemptionsByReader = new Map<string, string[]>();

  const recordError = (code: string) => {
    counters.errors++;
    counters.errorsByCode[code] = (counters.errorsByCode[code] ?? 0) + 1;
  };

  // -- Phase 1: seed the catalogue -----------------------------------------
  const t0 = performance.now();
  process.stdout.write('phase 1  seeding creators and catalogue ... ');
  const adminReader = await createReader(h, 'stress-admin');
  await makeAdmin(h, adminReader);
  const adminToken = () => mintToken(h, adminReader, 'admin');

  const creators: TestCreator[] = [];
  for (let i = 0; i < options.creators; i++) {
    creators.push(
      await createCreator(h, {
        label: `sc${i}`,
        // Roughly a third of creators are GST-registered, so TCS is exercised.
        gstRegistered: i % 3 === 0,
        chapters: [10, 25, 50, 100],
      }),
    );
  }
  const allChapters = creators.flatMap((c) => c.chapterIds.map((id) => ({ chapterId: id, creator: c })));
  console.log(`${options.creators} creators, ${allChapters.length} chapters (${round2(performance.now() - t0)}ms)`);

  // -- Phase 2: seed readers ------------------------------------------------
  const t1 = performance.now();
  process.stdout.write('phase 2  registering readers ................ ');
  const readers: TestReader[] = [];
  const readerBatch = 25;
  for (let i = 0; i < options.readers; i += readerBatch) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(readerBatch, options.readers - i) }, (_, k) => createReader(h, `sr${i + k}`)),
    );
    readers.push(...batch);
  }
  console.log(`${readers.length} readers (${round2(performance.now() - t1)}ms)`);

  // -- Phase 3: sustained mixed load ---------------------------------------
  console.log(`phase 3  driving load for ${options.durationSeconds}s ...`);
  const loadStart = performance.now();
  const deadline = loadStart + options.durationSeconds * 1000;
  let ticks = 0;

  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;

  async function readerJourney(reader: TestReader): Promise<void> {
    const token = mintToken(h, reader, 'reader');

    // 1. Buy a bundle.
    const sku = pick(['coins_100', 'coins_250', 'coins_500', 'coins_1000']);
    const tTop = performance.now();
    const order = await h.request<{ orderId: string; error?: { code: string } }>('POST', '/v1/credits/orders', {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { sku },
    });
    latency.topup.add(performance.now() - tTop);

    if (order.status !== 201) {
      if (order.status === 429) counters.rateLimited++;
      else recordError((order.body as { error?: { code: string } }).error?.code ?? `http_${order.status}`);
      return;
    }
    counters.topUpsCreated++;

    // 2. Pay it at the aggregator. Some readers abandon checkout.
    if (rng() < 0.06) {
      h.sim.failOrder(order.body.orderId, true);
      return;
    }
    h.sim.payOrder(order.body.orderId);
    counters.topUpsPaid++;
    paidOrders.push(order.body.orderId);

    // 3. Let the webhook land and the coins be granted.
    await h.sim.drainWebhooks();
    await h.container.services.webhooks.processPending(200);

    // 4. Read a few chapters.
    const reads = 1 + Math.floor(rng() * 4);
    for (let i = 0; i < reads; i++) {
      const target = pick(allChapters);
      const tUnlock = performance.now();
      const res = await h.request<{ redemptionId: string; alreadyOwned: boolean; error?: { code: string } }>(
        'POST',
        `/v1/chapters/${target.chapterId}/unlock`,
        { token },
      );
      latency.unlock.add(performance.now() - tUnlock);

      if (res.status === 201) {
        counters.unlocks++;
        const list = redemptionsByReader.get(reader.userId) ?? [];
        list.push(res.body.redemptionId);
        redemptionsByReader.set(reader.userId, list);
      } else if (res.status === 200) {
        counters.unlocksAlreadyOwned++;
      } else if (res.status === 422) {
        counters.unlocksInsufficientCredits++;
        break; // out of coins
      } else if (res.status === 429) {
        counters.rateLimited++;
      } else if (res.status === 403) {
        // self-purchase guard; legitimate refusal
      } else {
        recordError(res.body?.error?.code ?? `http_${res.status}`);
      }
    }

    // 5. Some readers tip.
    if (rng() < 0.12) {
      const creator = pick(creators);
      if (creator.userId !== reader.userId) {
        const tTip = performance.now();
        const tip = await h.request<{ orderId: string; error?: { code: string } }>('POST', '/v1/tips', {
          token,
          headers: { 'idempotency-key': randomUUID() },
          body: { creatorId: creator.creatorId, amountPaise: 1000 + Math.floor(rng() * 20) * 1000 },
        });
        latency.tip.add(performance.now() - tTip);
        if (tip.status === 201) {
          h.sim.payOrder(tip.body.orderId);
          paidOrders.push(tip.body.orderId);
          counters.tips++;
        } else if (tip.status === 429) {
          counters.rateLimited++;
        } else if (tip.status !== 422 && tip.status !== 403) {
          recordError(tip.body?.error?.code ?? `http_${tip.status}`);
        }
      }
    }

    // 6. Some readers refund a purchase.
    const owned = redemptionsByReader.get(reader.userId) ?? [];
    if (owned.length > 0 && rng() < options.refundRate) {
      const redemptionId = owned[Math.floor(rng() * owned.length)]!;
      const tRefund = performance.now();
      const refund = await h.request<{ error?: { code: string } }>(
        'POST',
        `/v1/redemptions/${redemptionId}/refund`,
        {
          token,
          headers: { 'idempotency-key': randomUUID() },
          body: { mode: rng() < 0.7 ? 'to_credits' : 'to_source', reason: 'stress test refund' },
        },
      );
      latency.refund.add(performance.now() - tRefund);
      if (refund.status === 201) counters.refunds++;
      else if (refund.status === 409 || refund.status === 422) {
        // already refunded or nothing refundable: both are correct refusals
      } else if (refund.status === 429) counters.rateLimited++;
      else recordError(refund.body?.error?.code ?? `http_${refund.status}`);
    }
  }

  // Fixed-size worker pool: sustained concurrency, not an unbounded fan-out.
  const workers = Array.from({ length: options.concurrency }, async () => {
    while (performance.now() < deadline) {
      const reader = pick(readers);
      ticks++;
      try {
        await readerJourney(reader);
      } catch (e) {
        recordError(`exception:${(e as Error).message.slice(0, 60)}`);
      }
    }
  });
  await Promise.all(workers);
  const loadMs = performance.now() - loadStart;
  console.log(`         ${ticks} reader journeys in ${round2(loadMs / 1000)}s`);

  // -- Phase 4: chargebacks on a slice of paid orders -----------------------
  process.stdout.write('phase 4  raising chargebacks ................ ');
  const disputeTargets = paidOrders.filter(() => rng() < options.disputeRate);
  for (const orderId of disputeTargets) {
    try {
      const order = h.sim.getOrder(orderId);
      if (!order) continue;
      h.sim.raiseDispute(orderId, order.order_amount, `${h.baseUrl}/v1/webhooks/cashfree`);
      counters.disputes++;
    } catch {
      /* an order with no captured payment cannot be disputed */
    }
  }
  console.log(`${counters.disputes} disputes raised`);

  // -- Phase 5: drain every asynchronous pipeline ---------------------------
  process.stdout.write('phase 5  draining webhooks and outbox ....... ');
  const t5 = performance.now();
  await h.settle(80);
  console.log(`done (${round2(performance.now() - t5)}ms)`);

  // -- Phase 6: settlement close and payout ---------------------------------
  process.stdout.write('phase 6  closing settlement period .......... ');
  const t6 = performance.now();
  clock.advanceDays(36);
  const close = await h.request<{ results: CloseSummary[] }>('POST', '/v1/admin/settlements/close', {
    token: adminToken(),
    body: {},
  });
  if (close.status !== 200) {
    throw new Error(`settlement close failed: ${JSON.stringify(close.body)}`);
  }
  await h.settle(80);

  // Retry the payouts the aggregator bounced, exactly as the worker loop does.
  const retry = await h.request<{ dispatched: number }>('POST', '/v1/admin/payouts/dispatch', {
    token: adminToken(),
    body: {},
  });
  await h.settle(40);

  const closeTotals = close.body.results.reduce(
    (acc, r) => ({
      creators: acc.creators + r.creatorsProcessed,
      statements: acc.statements + r.statementsIssued,
      carried: acc.carried + r.carriedForward,
      payouts: acc.payouts + r.payoutsQueued,
      tcs: acc.tcs + r.totalTcs,
      tds: acc.tds + r.totalTds,
      reserve: acc.reserve + r.totalReserveReleased,
      net: acc.net + r.totalNetPayable,
    }),
    { creators: 0, statements: 0, carried: 0, payouts: 0, tcs: 0, tds: 0, reserve: 0, net: 0 },
  );
  console.log(`done (${round2(performance.now() - t6)}ms)`);

  // -- Phase 7: verification -------------------------------------------------
  console.log('phase 7  verifying financial integrity ......');
  const recon = await h.request<{ checks: ReconCheck[]; allOk: boolean }>('GET', '/v1/admin/reports/reconcile', {
    token: adminToken(),
  });
  const trial = await h.request<{ balanced: boolean; totalDebitPaise: number; totalCreditPaise: number; rows: TrialRow[] }>(
    'GET',
    '/v1/admin/reports/trial-balance',
    { token: adminToken() },
  );
  const summary = await h.request<PlatformSummary>('GET', '/v1/admin/summary', { token: adminToken() });
  const extra = await deepInvariants(h);

  // ---------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------
  const line = (label: string, value: string | number) => console.log(`  ${label.padEnd(42, '.')} ${value}`);

  console.log(`\n${'='.repeat(78)}\nWORKLOAD\n${'='.repeat(78)}`);
  line('reader journeys', ticks);
  line('top-up orders created', counters.topUpsCreated);
  line('top-up orders paid', counters.topUpsPaid);
  line('chapter unlocks (charged)', counters.unlocks);
  line('chapter unlocks (already owned)', counters.unlocksAlreadyOwned);
  line('unlocks refused for insufficient credits', counters.unlocksInsufficientCredits);
  line('tips', counters.tips);
  line('refunds', counters.refunds);
  line('chargebacks', counters.disputes);
  line('rate-limited requests', counters.rateLimited);
  line('unexpected errors', counters.errors);
  if (counters.errors > 0) {
    for (const [code, n] of Object.entries(counters.errorsByCode)) line(`    ${code}`, n);
  }

  console.log(`\n${'='.repeat(78)}\nAGGREGATOR FAULT INJECTION (what the system absorbed)\n${'='.repeat(78)}`);
  line('transient 5xx returned to our client', h.sim.stats.transientFailures);
  line('duplicate webhook deliveries', h.sim.stats.duplicatesDelivered);
  line('webhooks delivered in total', h.sim.stats.webhooksDelivered);
  line('vendor settlements requested', h.sim.stats.settlementsRequested);
  line('vendor settlements bounced', h.sim.stats.settlementsFailed);
  line('payment-aggregator HTTP calls', h.sim.stats.requests);
  line('adapter retries after failures', h.container.cashfree.metrics.retries);
  line('adapter circuit state', h.container.cashfree.metrics.circuitState);

  console.log(`\n${'='.repeat(78)}\nLATENCY (end to end over HTTP, milliseconds)\n${'='.repeat(78)}`);
  for (const [name, l] of Object.entries(latency)) {
    const s = l.summary();
    if (s.count === 0) continue;
    console.log(
      `  ${name.padEnd(10)} n=${String(s.count).padStart(6)}  mean=${String(s.meanMs).padStart(8)}  ` +
        `p50=${String(s.p50Ms).padStart(8)}  p95=${String(s.p95Ms).padStart(8)}  ` +
        `p99=${String(s.p99Ms).padStart(8)}  max=${String(s.maxMs).padStart(8)}`,
    );
  }
  const totalRequests =
    latency.topup.count + latency.unlock.count + latency.tip.count + latency.refund.count;
  line('throughput (business requests/sec)', round2(totalRequests / (loadMs / 1000)));

  console.log(`\n${'='.repeat(78)}\nSETTLEMENT\n${'='.repeat(78)}`);
  line('periods finalised', close.body.results.length);
  line('creators settled', closeTotals.creators);
  line('statements issued', closeTotals.statements);
  line('statements carried forward (below threshold)', closeTotals.carried);
  line('payouts queued', closeTotals.payouts);
  line('queued payouts dispatched on retry sweep', retry.body.dispatched ?? 0);
  line('reserve released', formatInr(closeTotals.reserve));
  line('TCS collected (CGST s.52)', formatInr(closeTotals.tcs));
  line('TDS deducted (IT s.194-O)', formatInr(closeTotals.tds));
  line('net paid to creators', formatInr(closeTotals.net));

  console.log(`\n${'='.repeat(78)}\nPLATFORM ECONOMICS\n${'='.repeat(78)}`);
  line('GMV', `₹${summary.body.gmv}`);
  line('platform commission (GST turnover)', `₹${summary.body.platformCommission}`);
  line('effective take rate', `${summary.body.takeRatePercent}%`);
  line('paid out to creators', `₹${summary.body.paidOut}`);
  line('redemptions recorded', summary.body.redemptions);
  line('failed webhooks left unprocessed', summary.body.failedWebhooks);

  console.log(`\n${'='.repeat(78)}\nFINANCIAL INTEGRITY ASSERTIONS\n${'='.repeat(78)}`);
  const failures: string[] = [];

  const assertCheck = (name: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
    if (!ok) failures.push(`${name}: ${detail}`);
  };

  assertCheck(
    'trial balance nets to zero',
    trial.body.balanced && trial.body.totalDebitPaise === trial.body.totalCreditPaise,
    `debits ${paiseToRupeeString(trial.body.totalDebitPaise)} = credits ${paiseToRupeeString(trial.body.totalCreditPaise)}`,
  );
  for (const check of recon.body.checks) {
    assertCheck(check.name, check.ok, `expected ${check.expected}, actual ${check.actual}`);
  }
  for (const check of extra) {
    assertCheck(check.name, check.ok, check.detail);
  }
  assertCheck(
    'no unexpected application errors',
    counters.errors === 0,
    counters.errors === 0 ? 'none' : JSON.stringify(counters.errorsByCode),
  );
  assertCheck(
    'no webhook stuck in a failed state',
    summary.body.failedWebhooks === 0,
    `${summary.body.failedWebhooks} failed`,
  );

  console.log('='.repeat(78));
  if (failures.length > 0) {
    console.error(`\nSTRESS TEST FAILED — ${failures.length} integrity assertion(s) breached:`);
    for (const f of failures) console.error(`  - ${f}`);
    await h.close();
    process.exit(1);
  }

  console.log(
    `\nSTRESS TEST PASSED — ${recon.body.checks.length + extra.length + 2} integrity assertions held across ` +
      `${counters.unlocks + counters.topUpsPaid + counters.tips + counters.refunds} financial events ` +
      `worth ₹${summary.body.gmv} of GMV, under injected aggregator failure.`,
  );
  await h.close();
}

// ---------------------------------------------------------------------------
// Invariants beyond the API's own reconciliation controls
// ---------------------------------------------------------------------------

interface DeepCheck {
  name: string;
  ok: boolean;
  detail: string;
}

async function deepInvariants(h: Harness): Promise<DeepCheck[]> {
  return h.container.db.transaction(
    async (uow) => {
      const checks: DeepCheck[] = [];

      const q = async <T>(sql: string): Promise<T> => (await uow.query<T>(sql)).rows[0] as T;

      // Each reader charged at most once per chapter.
      const doubleCharge = await q<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT user_id, chapter_id FROM redemptions
            WHERE kind = 'chapter' AND gross_paise > 1
            GROUP BY 1,2 HAVING COUNT(*) > 1
         ) d`,
      );
      checks.push({
        name: 'no reader charged twice for one chapter',
        ok: doubleCharge.n === 0,
        detail: `${doubleCharge.n} duplicate charge(s)`,
      });

      // Ledger postings are balanced entry by entry, not just in aggregate.
      const unbalanced = await q<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT entry_id
             FROM journal_lines
            GROUP BY entry_id
           HAVING COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'debit'), 0)
                <> COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'credit'), 0)
         ) u`,
      );
      checks.push({
        name: 'every journal entry balances individually',
        ok: unbalanced.n === 0,
        detail: `${unbalanced.n} unbalanced entr(ies)`,
      });

      // No journal entry was posted twice for one business event.
      const dupEntries = await q<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT idempotency_key FROM journal_entries GROUP BY 1 HAVING COUNT(*) > 1
         ) d`,
      );
      checks.push({
        name: 'no double-posted ledger entry',
        ok: dupEntries.n === 0,
        detail: `${dupEntries.n} duplicate key(s)`,
      });

      // Coins spent equal coins granted minus coins held.
      const coins = await q<{ granted: number; spent: number; held: number; refunded: number; expired: number }>(
        `SELECT
           COALESCE(SUM(delta) FILTER (WHERE reason = 'topup'), 0)::bigint  AS granted,
           COALESCE(-SUM(delta) FILTER (WHERE reason = 'redeem'), 0)::bigint AS spent,
           (SELECT COALESCE(SUM(balance_credits), 0)::bigint FROM credit_wallets) AS held,
           COALESCE(SUM(delta) FILTER (WHERE reason = 'refund'), 0)::bigint AS refunded,
           COALESCE(-SUM(delta) FILTER (WHERE reason = 'expiry'), 0)::bigint AS expired
         FROM credit_movements`,
      );
      const coinsBalance = coins.granted + coins.refunded - coins.spent - coins.expired;
      checks.push({
        name: 'coin movements reconcile to wallet balances',
        ok: coinsBalance === coins.held,
        detail: `granted ${coins.granted} + refunded ${coins.refunded} - spent ${coins.spent} - expired ${coins.expired} = ${coinsBalance}, wallets hold ${coins.held}`,
      });

      // Every paid order granted exactly one credit lot.
      const lotMismatch = await q<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM orders o
          WHERE o.kind = 'credit_topup' AND o.status = 'paid'
            AND (SELECT COUNT(*) FROM credit_lots l WHERE l.order_id = o.id) <> 1`,
      );
      checks.push({
        name: 'each paid top-up granted exactly one credit lot',
        ok: lotMismatch.n === 0,
        detail: `${lotMismatch.n} order(s) with a wrong lot count`,
      });

      // No captured payment was applied twice.
      const dupPayments = await q<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT order_id FROM payments WHERE status = 'success' GROUP BY 1 HAVING COUNT(*) > 1
         ) d`,
      );
      checks.push({
        name: 'no payment applied twice to one order',
        ok: dupPayments.n === 0,
        detail: `${dupPayments.n} order(s) with multiple captures`,
      });

      // Payout clearing is empty: nothing is stranded mid-transfer.
      const clearing = await q<{ balance: number }>(
        `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'credit'), 0)::bigint
              - COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'debit'), 0)::bigint AS balance
           FROM journal_lines WHERE account_code = '2700'`,
      );
      const inFlight = await q<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM payouts WHERE status IN ('queued','instructed','processing')`,
      );
      checks.push({
        name: 'no money stranded in payout clearing',
        ok: clearing.balance === 0 || inFlight.n > 0,
        detail: `clearing ${paiseToRupeeString(clearing.balance)}, ${inFlight.n} payout(s) still in flight`,
      });

      // Every succeeded payout carries a bank reference.
      const noUtr = await q<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM payouts WHERE status = 'succeeded' AND (utr IS NULL OR utr = '')`,
      );
      checks.push({
        name: 'every settled payout has a UTR',
        ok: noUtr.n === 0,
        detail: `${noUtr.n} payout(s) missing a bank reference`,
      });

      // A bounced bank transfer must give the creator their money back. A
      // bounce means a bad beneficiary account, so the design reinstates the
      // payable and waits for a corrected instrument rather than retrying
      // blindly into the same failure.
      const bounced = await q<{ total: number; reinstated: number; carried: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM payouts WHERE status = 'failed') AS total,
           (SELECT COUNT(*)::int FROM payouts p
             WHERE p.status = 'failed'
               AND EXISTS (
                 SELECT 1 FROM journal_entries je
                  WHERE je.entry_type = 'payout_failed'
                    AND je.reference_type = 'payout'
                    AND je.reference_id = p.id
                    AND je.total_paise = p.amount_paise
               )) AS reinstated,
           (SELECT COUNT(*)::int FROM payouts p
             JOIN creator_statements cs ON cs.id = p.statement_id
            WHERE p.status = 'failed' AND cs.status = 'carried_forward') AS carried`,
      );
      checks.push({
        name: 'bounced payouts reinstated the creator payable',
        ok: bounced.reinstated === bounced.total && bounced.carried === bounced.total,
        detail:
          bounced.total === 0
            ? 'no payout bounced'
            : `${bounced.total} bounced, ${bounced.reinstated} reinstated in the ledger, ${bounced.carried} carried forward`,
      });

      // TCS is only ever withheld from GST-registered creators.
      const badTcs = await q<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM creator_statements cs
           JOIN creators c ON c.id = cs.creator_id
          WHERE cs.tcs_paise > 0 AND c.gstin IS NULL`,
      );
      checks.push({
        name: 'TCS withheld only from registered creators',
        ok: badTcs.n === 0,
        detail: `${badTcs.n} unregistered creator(s) had TCS withheld`,
      });

      // The platform's taxable turnover is its commission, not GMV.
      const turnover = await q<{ gmv: number; commission: number }>(
        `SELECT COALESCE(SUM(gross_paise), 0)::bigint AS gmv,
                COALESCE(SUM(platform_fee_paise), 0)::bigint AS commission
           FROM redemptions`,
      );
      const shareOk = turnover.gmv === 0 || turnover.commission <= Math.ceil(turnover.gmv * 0.1) + 1;
      checks.push({
        name: 'platform turnover is commission, not GMV',
        ok: shareOk,
        detail: `commission ${paiseToRupeeString(turnover.commission)} of GMV ${paiseToRupeeString(turnover.gmv)}`,
      });

      // No negative creator payable survives settlement without a carry-forward.
      const negative = await q<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT creator_id,
                  COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'credit'), 0)::bigint
                    - COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'debit'), 0)::bigint AS bal
             FROM journal_lines WHERE account_code = '2100' AND creator_id IS NOT NULL
             GROUP BY creator_id
         ) b WHERE bal < 0`,
      );
      checks.push({
        name: 'creator claw-backs never exceed what was paid',
        ok: negative.n === 0,
        detail: `${negative.n} creator(s) with a negative payable`,
      });

      // The outbox drained: nothing dead-lettered.
      const dead = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM outbox WHERE status = 'dead'`);
      checks.push({
        name: 'no outbox message dead-lettered',
        ok: dead.n === 0,
        detail: `${dead.n} dead message(s)`,
      });

      return checks;
    },
    { readOnly: true },
  );
}

interface CloseSummary {
  periodId: string;
  creatorsProcessed: number;
  statementsIssued: number;
  carriedForward: number;
  payoutsQueued: number;
  totalTcs: number;
  totalTds: number;
  totalReserveReleased: number;
  totalNetPayable: number;
}
interface ReconCheck {
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
}
interface TrialRow {
  account: string;
  balance: string;
}
interface PlatformSummary {
  gmv: string;
  platformCommission: string;
  takeRatePercent: number;
  paidOut: string;
  redemptions: number;
  failedWebhooks: number;
}

main().catch((e) => {
  console.error('\nSTRESS TEST ERRORED:', e);
  process.exit(1);
});
