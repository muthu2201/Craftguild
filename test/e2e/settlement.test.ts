import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  startHarness,
  createReader,
  createCreator,
  makeAdmin,
  buyCredits,
  mintToken,
  type Harness,
  type TestCreator,
  type TestReader,
} from '../helpers/harness.js';
import { FixedClock } from '../../src/domain/clock.js';

/**
 * Settlement close: the 30-day accrual window, the 5-day grace window, reserve
 * release, statutory withholding, statements and payout — driven end to end
 * with a controllable clock.
 */

let h: Harness;
let adminReader: TestReader;
let clock: FixedClock;

/**
 * These tests advance the clock by weeks, which outlives a real access token.
 * Tokens are therefore minted at the moment of use rather than held.
 */
const adminToken = () => mintToken(h, adminReader, 'admin');
const asCreator = (c: TestCreator) => mintToken(h, c, 'creator', c.creatorId);
const asReader = (r: TestReader) => mintToken(h, r, 'reader');

before(async () => {
  clock = new FixedClock(new Date('2026-04-10T06:30:00.000Z'));
  h = await startHarness({ clock });
  adminReader = await createReader(h, 'settle-admin');
  await makeAdmin(h, adminReader);
});

after(async () => {
  await h.close();
});

async function closeDuePeriods() {
  const res = await h.request<{ results: unknown[] }>('POST', '/v1/admin/settlements/close', {
    token: adminToken(),
    body: {},
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.results as {
    periodId: string;
    creatorsProcessed: number;
    statementsIssued: number;
    payoutsQueued: number;
    totalTcs: number;
    totalTds: number;
    totalReserveReleased: number;
    carriedForward: number;
  }[];
}

async function reconcile() {
  const res = await h.request<{ checks: { name: string; ok: boolean }[]; allOk: boolean }>(
    'GET',
    '/v1/admin/reports/reconcile',
    { token: adminToken() },
  );
  const failures = res.body.checks.filter((c) => !c.ok);
  assert.deepEqual(failures, [], `reconciliation breached: ${JSON.stringify(failures)}`);
}

describe('settlement close', () => {
  test('the grace window must elapse before a period can be finalised', async () => {
    const creator = await createCreator(h, { label: 'grace', chapters: [500] });
    const reader = await createReader(h, 'grace-reader');
    await buyCredits(h, reader, 'coins_1000');
    await h.request('POST', `/v1/chapters/${creator.chapterIds[0]}/unlock`, { token: asReader(reader) });

    // Day 31: accrual closed but the dispute window is still open.
    clock.advanceDays(31);
    assert.deepEqual(await closeDuePeriods(), [], 'nothing may finalise inside the grace window');

    const balance = await h.request<{ reservePaise: number }>('GET', '/v1/creators/me/balance', {
      token: asCreator(creator),
    });
    assert.ok(balance.body.reservePaise > 0, 'the reserve is still held during grace');
  });

  test('after the grace window: reserve released, withholding applied, payout dispatched', async () => {
    const creator = await createCreator(h, { label: 'close', chapters: [500] });
    const reader = await createReader(h, 'close-reader');
    await buyCredits(h, reader, 'coins_1000');
    await h.request('POST', `/v1/chapters/${creator.chapterIds[0]}/unlock`, { token: asReader(reader) });

    // Day 36 of this period: grace has closed.
    clock.advanceDays(36);
    const results = await closeDuePeriods();
    assert.ok(results.length >= 1);

    const balance = await h.request<{ payablePaise: number; reservePaise: number; inFlightPayoutPaise: number }>(
      'GET',
      '/v1/creators/me/balance',
      { token: asCreator(creator) },
    );
    assert.equal(balance.body.reservePaise, 0, 'the reserve is released at finalisation');

    const statements = await h.request<{ statements: { status: string; net_payable_paise: number; tcs_paise: number; tds_paise: number }[] }>(
      'GET',
      '/v1/creators/me/statements',
      { token: asCreator(creator) },
    );
    const issued = statements.body.statements.find((s) => s.net_payable_paise > 0);
    assert.ok(issued, 'a statement was issued');
    assert.ok(['issued', 'paid'].includes(issued!.status));

    // Rs 500 chapter: creator gross 427.72, no TCS (unregistered), no TDS (under Rs 5 lakh).
    assert.equal(issued!.tcs_paise, 0);
    assert.equal(issued!.tds_paise, 0);
    assert.equal(issued!.net_payable_paise, 427_72);

    await h.settle();
    const afterPayout = await h.request<{ payablePaise: number; inFlightPayoutPaise: number }>(
      'GET',
      '/v1/creators/me/balance',
      { token: asCreator(creator) },
    );
    assert.equal(afterPayout.body.payablePaise, 0, 'the money left the payable');
    assert.equal(afterPayout.body.inFlightPayoutPaise, 0, 'and was confirmed settled to the creator');

    const payout = await h.container.db.transaction(
      async (uow) => {
        const res = await uow.query<{ status: string; utr: string | null; amount_paise: number }>(
          'SELECT status, utr, amount_paise FROM payouts WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 1',
          [creator.creatorId],
        );
        return res.rows[0]!;
      },
      { readOnly: true },
    );
    assert.equal(payout.status, 'succeeded');
    assert.ok(payout.utr, 'a UTR is recorded for the bank transfer');
    assert.equal(payout.amount_paise, 427_72);

    await reconcile();
  });

  test('a balance below the minimum payout threshold carries forward instead of paying out', async () => {
    const creator = await createCreator(h, { label: 'tinycarry', chapters: [20] });
    const reader = await createReader(h, 'tiny-reader');
    await buyCredits(h, reader, 'coins_100');
    await h.request('POST', `/v1/chapters/${creator.chapterIds[0]}/unlock`, { token: asReader(reader) });

    clock.advanceDays(36);
    await closeDuePeriods();

    const statements = await h.request<{ statements: { status: string; carried_forward_paise: number }[] }>(
      'GET',
      '/v1/creators/me/statements',
      { token: asCreator(creator) },
    );
    const latest = statements.body.statements[0]!;
    assert.equal(latest.status, 'carried_forward');
    assert.ok(latest.carried_forward_paise > 0);

    const balance = await h.request<{ payablePaise: number }>('GET', '/v1/creators/me/balance', {
      token: asCreator(creator),
    });
    assert.ok(balance.body.payablePaise > 0, 'the money stays the creator’s, it is simply not yet dispatched');
    await reconcile();
  });

  test('a GST-registered creator has TCS withheld and appears in GSTR-8', async () => {
    const creator = await createCreator(h, { label: 'registered', gstRegistered: true, chapters: [2000] });
    const reader = await createReader(h, 'gst-reader');
    await buyCredits(h, reader, 'coins_1000');
    await buyCredits(h, reader, 'coins_1000');
    await h.request('POST', `/v1/chapters/${creator.chapterIds[0]}/unlock`, { token: asReader(reader) });

    clock.advanceDays(36);
    const results = await closeDuePeriods();
    const periodId = results[results.length - 1]!.periodId;

    const statements = await h.request<{ statements: { tcs_paise: number; tcs_rate_ppm: number; gross_paise: number }[] }>(
      'GET',
      '/v1/creators/me/statements',
      { token: asCreator(creator) },
    );
    const latest = statements.body.statements[0]!;
    assert.equal(latest.gross_paise, 2000_00);
    assert.equal(latest.tcs_rate_ppm, 5_000, 'TCS at 0.5%');
    assert.equal(latest.tcs_paise, 10_00, '0.5% of Rs 2,000');

    const gstr8 = await h.request<{
      returnPeriod: string;
      dueDate: string;
      supplierLines: { gstin: string; tcs: string }[];
      totals: { tcs: string; supplierCount: number };
    }>('GET', `/v1/admin/reports/gstr8/${periodId}`, { token: adminToken() });

    assert.equal(gstr8.status, 200);
    assert.ok(gstr8.body.supplierLines.some((l) => l.gstin === creator.gstin));
    assert.ok(Number(gstr8.body.totals.tcs) >= 10);
    assert.match(gstr8.body.returnPeriod, /^\d{6}$/);
    await reconcile();
  });

  test('an unregistered creator has no TCS: there is no GSTIN to deposit it against', async () => {
    const creator = await createCreator(h, { label: 'unregistered', chapters: [2000] });
    const reader = await createReader(h, 'unreg-reader');
    await buyCredits(h, reader, 'coins_1000');
    await buyCredits(h, reader, 'coins_1000');
    await h.request('POST', `/v1/chapters/${creator.chapterIds[0]}/unlock`, { token: asReader(reader) });

    clock.advanceDays(36);
    await closeDuePeriods();

    const statements = await h.request<{ statements: { tcs_paise: number }[] }>('GET', '/v1/creators/me/statements', {
      token: asCreator(creator),
    });
    assert.equal(statements.body.statements[0]!.tcs_paise, 0);
  });

  test('crossing the Rs 5 lakh ceiling triggers TDS and a 26Q line', async () => {
    // A single chapter is capped at 100,000 credits, so the year's Rs 6 lakh of
    // earnings is reached across six chapters, as it would be in practice.
    const creator = await createCreator(h, {
      label: 'bigearner',
      chapters: [100_000, 100_000, 100_000, 100_000, 100_000, 100_000],
    });
    const readers = await Promise.all(
      Array.from({ length: 1 }, (_, i) => createReader(h, `whale-${i}`)),
    );
    const reader = readers[0]!;

    // Rs 6,00,000 of coins, bought in Rs 1,000 bundles.
    for (let i = 0; i < 546; i++) {
      const order = await h.request<{ orderId: string }>('POST', '/v1/credits/orders', {
        token: asReader(reader),
        headers: { 'idempotency-key': randomUUID() },
        body: { sku: 'coins_1000' },
      });
      h.sim.payOrder(order.body.orderId);
    }
    await h.settle(30);

    let unlockedGross = 0;
    for (const chapterId of creator.chapterIds) {
      const unlock = await h.request<{ grossPaise: number }>('POST', `/v1/chapters/${chapterId}/unlock`, {
        token: asReader(reader),
      });
      assert.equal(unlock.status, 201, JSON.stringify(unlock.body));
      unlockedGross += unlock.body.grossPaise;
    }
    assert.equal(unlockedGross, 6_00_000_00);

    clock.advanceDays(36);
    const results = await closeDuePeriods();
    const periodId = results[results.length - 1]!.periodId;

    const statements = await h.request<{ statements: { tds_paise: number; tds_rate_ppm: number }[] }>(
      'GET',
      '/v1/creators/me/statements',
      { token: asCreator(creator) },
    );
    const latest = statements.body.statements[0]!;
    assert.equal(latest.tds_rate_ppm, 1_000, 'TDS at 0.1%');
    assert.equal(latest.tds_paise, 600_00, '0.1% of the full Rs 6,00,000 once the ceiling is crossed');

    const form26q = await h.request<{ deductees: { pan: string; tdsAmount: string }[]; totals: { tdsAmount: string } }>(
      'GET',
      `/v1/admin/reports/26q/${periodId}`,
      { token: adminToken() },
    );
    assert.equal(form26q.status, 200);
    assert.ok(form26q.body.deductees.some((d) => d.pan === creator.pan));
    assert.equal(form26q.body.totals.tdsAmount, '600.00');

    await reconcile();
  });

  test('the platform’s own GST turnover is the commission, not GMV', async () => {
    const res = await h.request<{
      periods: { taxableCommission: string; gmv: string; commissionShareOfGmvPercent: number }[];
    }>('GET', '/v1/admin/reports/gst-turnover', { token: adminToken() });

    assert.equal(res.status, 200);
    assert.ok(res.body.periods.length > 0);
    for (const p of res.body.periods) {
      assert.ok(
        Number(p.taxableCommission) < Number(p.gmv),
        'the platform’s taxable turnover must be a fraction of GMV',
      );
      assert.ok(
        p.commissionShareOfGmvPercent <= 10.01,
        `commission share was ${p.commissionShareOfGmvPercent}%, above the 10% take rate`,
      );
    }
  });

  test('finalising a period twice is a no-op, not a double payment', async () => {
    const creator = await createCreator(h, { label: 'doubleclose', chapters: [500] });
    const reader = await createReader(h, 'doubleclose-reader');
    await buyCredits(h, reader, 'coins_1000');
    await h.request('POST', `/v1/chapters/${creator.chapterIds[0]}/unlock`, { token: asReader(reader) });

    clock.advanceDays(36);
    const first = await closeDuePeriods();
    const periodId = first[first.length - 1]!.periodId;

    const repeat = await h.request<{ error: { code: string } }>('POST', '/v1/admin/settlements/close', {
      token: adminToken(),
      body: { periodId },
    });
    assert.equal(repeat.status, 409);
    assert.equal(repeat.body.error.code, 'settlement.already_finalised');

    await reconcile();
  });

  test('a chargeback after settlement is recovered from the reserve where one remains', async () => {
    const creator = await createCreator(h, { label: 'chargeback', chapters: [300, 300] });
    const reader = await createReader(h, 'cb-reader');

    const order = await h.request<{ orderId: string }>('POST', '/v1/credits/orders', {
      token: asReader(reader),
      headers: { 'idempotency-key': randomUUID() },
      body: { sku: 'coins_1000' },
    });
    h.sim.payOrder(order.body.orderId);
    await h.settle();

    await h.request('POST', `/v1/chapters/${creator.chapterIds[0]}/unlock`, { token: asReader(reader) });

    const beforeReserve = await h.request<{ reservePaise: number }>('GET', '/v1/creators/me/balance', {
      token: asCreator(creator),
    });
    assert.ok(beforeReserve.body.reservePaise > 0);

    h.sim.raiseDispute(order.body.orderId, 1000, `${h.baseUrl}/v1/webhooks/cashfree`);
    await h.settle();

    const cb = await h.container.db.transaction(
      async (uow) => {
        const res = await uow.query<{ recovered_from_reserve_paise: number; absorbed_paise: number; status: string }>(
          'SELECT recovered_from_reserve_paise, absorbed_paise, status FROM chargebacks ORDER BY created_at DESC LIMIT 1',
        );
        return res.rows[0]!;
      },
      { readOnly: true },
    );
    assert.equal(cb.status, 'accepted');
    assert.ok(
      cb.recovered_from_reserve_paise + cb.absorbed_paise === 1_000_00,
      'the whole disputed amount is accounted for, split between reserve recovery and platform loss',
    );
    assert.ok(cb.recovered_from_reserve_paise > 0, 'the reserve absorbed part of the loss, which is why it exists');

    await reconcile();
  });

  test('a failed payout reinstates the creator payable rather than losing the money', async () => {
    // A dedicated harness whose aggregator always bounces the bank transfer.
    const failing = await startHarness({
      sim: { payoutFailureRate: 1 },
      clock: new FixedClock(new Date('2026-04-10T06:30:00.000Z')),
    });
    try {
      const failAdminReader = await createReader(failing, 'fail-admin');
      await makeAdmin(failing, failAdminReader);
      const failAdmin = () => mintToken(failing, failAdminReader, 'admin');

      const creator = await createCreator(failing, { label: 'bounce', chapters: [500] });
      const reader = await createReader(failing, 'bounce-reader');
      await buyCredits(failing, reader, 'coins_1000');
      await failing.request('POST', `/v1/chapters/${creator.chapterIds[0]}/unlock`, {
        token: mintToken(failing, reader, 'reader'),
      });

      failing.clock.advanceDays(36);
      await failing.request('POST', '/v1/admin/settlements/close', { token: failAdmin(), body: {} });
      await failing.settle();

      const balance = await failing.request<{ payablePaise: number; inFlightPayoutPaise: number }>(
        'GET',
        '/v1/creators/me/balance',
        { token: mintToken(failing, creator, 'creator', creator.creatorId) },
      );
      assert.equal(balance.body.inFlightPayoutPaise, 0, 'nothing is stranded in payout clearing');
      assert.equal(balance.body.payablePaise, 427_72, 'the creator keeps every paisa after a bounced transfer');

      const recon = await failing.request<{ allOk: boolean; checks: { name: string; ok: boolean }[] }>(
        'GET',
        '/v1/admin/reports/reconcile',
        { token: failAdmin() },
      );
      assert.equal(recon.body.allOk, true, JSON.stringify(recon.body.checks.filter((c) => !c.ok)));
    } finally {
      await failing.close();
    }
  });
});
