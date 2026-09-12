import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  startHarness,
  createReader,
  createCreator,
  makeAdmin,
  buyCredits,
  type Harness,
  type TestCreator,
  type TestReader,
} from '../helpers/harness.js';

/**
 * Full money lifecycle against the real application: HTTP in, Postgres and
 * Redis behind it, the real Cashfree adapter talking to a server that
 * implements Cashfree's contract, real webhooks, real settlement close.
 */

let h: Harness;
let admin: string;

before(async () => {
  h = await startHarness();
  const adminReader = await createReader(h, 'admin');
  admin = await makeAdmin(h, adminReader);
});

after(async () => {
  await h.close();
});

async function reconcile() {
  const res = await h.request<{ checks: { name: string; ok: boolean; expected: string; actual: string }[]; allOk: boolean }>(
    'GET',
    '/v1/admin/reports/reconcile',
    { token: admin },
  );
  assert.equal(res.status, 200);
  const failures = res.body.checks.filter((c) => !c.ok);
  assert.deepEqual(
    failures,
    [],
    `reconciliation controls breached: ${JSON.stringify(failures, null, 2)}`,
  );
  return res.body;
}

describe('creator onboarding', () => {
  test('an individual creator is registered as a split-settlement vendor', async () => {
    const creator = await createCreator(h, { label: 'onboard' });
    const me = await h.request<{ creator: { kycStatus: string; payoutsEnabled: boolean } }>('GET', '/v1/me', {
      token: creator.token,
    });
    assert.equal(me.body.creator.kycStatus, 'active');
    assert.equal(me.body.creator.payoutsEnabled, true);
  });

  test('an invalid PAN is rejected at the boundary', async () => {
    const reader = await createReader(h, 'badpan');
    const res = await h.request<{ error: { code: string } }>('POST', '/v1/creators/onboard', {
      token: reader.token,
      body: {
        legalName: 'Bad Pan',
        penName: 'Bad',
        pan: 'NOTAPAN123',
        phone: '9876543210',
        bank: { accountNumber: '123456789012', ifsc: 'HDFC0001234', accountHolder: 'Bad Pan' },
      },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'creator.invalid_pan');
  });

  test('a GSTIN that is not issued against the creator’s PAN is rejected', async () => {
    const reader = await createReader(h, 'badgst');
    const res = await h.request<{ error: { code: string } }>('POST', '/v1/creators/onboard', {
      token: reader.token,
      body: {
        legalName: 'Mismatch',
        penName: 'MM',
        pan: 'ABCPQ1234K',
        gstin: '33ABCPZ9999K1Z5',
        phone: '9876543210',
        bank: { accountNumber: '123456789012', ifsc: 'HDFC0001234', accountHolder: 'Mismatch' },
      },
    });
    assert.equal(res.status, 400);
    assert.ok(['creator.invalid_gstin', 'creator.gstin_pan_mismatch'].includes(res.body.error.code));
  });

  test('a creator without a payout instrument cannot onboard', async () => {
    const reader = await createReader(h, 'noinstrument');
    const res = await h.request<{ error: { code: string } }>('POST', '/v1/creators/onboard', {
      token: reader.token,
      body: { legalName: 'No Bank', penName: 'NB', pan: 'ABCPR1234K', phone: '9876543210' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'creator.no_payout_instrument');
  });
});

describe('credit purchase', () => {
  test('coins are granted only after the aggregator confirms capture', async () => {
    const reader = await createReader(h, 'buyer');

    const order = await h.request<{ orderId: string; credits: number; paymentSessionId: string }>(
      'POST',
      '/v1/credits/orders',
      { token: reader.token, headers: { 'idempotency-key': randomUUID() }, body: { sku: 'coins_500' } },
    );
    assert.equal(order.status, 201);
    assert.equal(order.body.credits, 535, '500 coins plus the 35 bonus');
    assert.ok(order.body.paymentSessionId.length > 0);

    // Before payment, no coins exist.
    const before = await h.request<{ credits: number }>('GET', '/v1/credits/wallet', { token: reader.token });
    assert.equal(before.body.credits, 0);

    h.sim.payOrder(order.body.orderId);
    await h.settle();

    const after = await h.request<{ credits: number }>('GET', '/v1/credits/wallet', { token: reader.token });
    assert.equal(after.body.credits, 535);
    await reconcile();
  });

  test('selling coins books a liability, never revenue (CBIC Circular 243/37/2024)', async () => {
    const reader = await createReader(h, 'voucher');
    await buyCredits(h, reader, 'coins_100');

    const tb = await h.request<{ rows: { account: string; balance: string }[] }>(
      'GET',
      '/v1/admin/reports/trial-balance',
      { token: admin },
    );
    const creditLiability = tb.body.rows.find((r) => r.account === 'CREDIT_LIABILITY');
    assert.ok(creditLiability, 'the coin liability account must carry a balance');
    // A credit balance shows as a negative net-debit.
    assert.ok(Number(creditLiability!.balance) < 0);
  });

  test('an Idempotency-Key replay returns the original order, not a second one', async () => {
    const reader = await createReader(h, 'idem');
    const key = randomUUID();

    const first = await h.request<{ orderId: string }>('POST', '/v1/credits/orders', {
      token: reader.token,
      headers: { 'idempotency-key': key },
      body: { sku: 'coins_250' },
    });
    const second = await h.request<{ orderId: string }>('POST', '/v1/credits/orders', {
      token: reader.token,
      headers: { 'idempotency-key': key },
      body: { sku: 'coins_250' },
    });

    assert.equal(first.body.orderId, second.body.orderId);
    assert.equal(second.headers['idempotent-replay'], 'true');
  });

  test('reusing an Idempotency-Key with a different body is refused', async () => {
    const reader = await createReader(h, 'idemclash');
    const key = randomUUID();
    await h.request('POST', '/v1/credits/orders', {
      token: reader.token,
      headers: { 'idempotency-key': key },
      body: { sku: 'coins_250' },
    });
    const clash = await h.request<{ error: { code: string } }>('POST', '/v1/credits/orders', {
      token: reader.token,
      headers: { 'idempotency-key': key },
      body: { sku: 'coins_500' },
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'idempotency.payload_mismatch');
  });

  test('a request without an Idempotency-Key is refused', async () => {
    const reader = await createReader(h, 'nokey');
    const res = await h.request<{ error: { code: string } }>('POST', '/v1/credits/orders', {
      token: reader.token,
      body: { sku: 'coins_100' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'http.missing_idempotency_key');
  });

  test('a dropped checkout grants nothing', async () => {
    const reader = await createReader(h, 'dropped');
    const order = await h.request<{ orderId: string }>('POST', '/v1/credits/orders', {
      token: reader.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { sku: 'coins_100' },
    });
    h.sim.failOrder(order.body.orderId, true);
    await h.settle();

    const wallet = await h.request<{ credits: number }>('GET', '/v1/credits/wallet', { token: reader.token });
    assert.equal(wallet.body.credits, 0);
  });
});

describe('chapter unlock', () => {
  let creator: TestCreator;
  let reader: TestReader;

  before(async () => {
    creator = await createCreator(h, { label: 'unlock', chapters: [10, 25] });
    reader = await createReader(h, 'unlocker');
    await buyCredits(h, reader, 'coins_500');
  });

  test('unlocking spends coins, grants the entitlement and splits 90/10 net of fees', async () => {
    const res = await h.request<{ creditsSpent: number; grossPaise: number; walletBalanceCredits: number }>(
      'POST',
      `/v1/chapters/${creator.chapterIds[0]}/unlock`,
      { token: reader.token },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.creditsSpent, 10);
    assert.equal(res.body.grossPaise, 1000);
    assert.equal(res.body.walletBalanceCredits, 525);

    const entitlements = await h.request<{ entitlements: { chapter_id: string }[] }>('GET', '/v1/me/entitlements', {
      token: reader.token,
    });
    assert.ok(entitlements.body.entitlements.some((e) => e.chapter_id === creator.chapterIds[0]));

    const balance = await h.request<{ payablePaise: number; reservePaise: number }>(
      'GET',
      '/v1/creators/me/balance',
      { token: creator.token },
    );
    // creator gross on Rs 10 = 1000 - 20 - 4 - 100 - 18 - 3 - 1 = 854
    assert.equal(balance.body.payablePaise + balance.body.reservePaise, 854);
    assert.equal(balance.body.reservePaise, 85, '10% reserve held through the grace window');

    await reconcile();
  });

  test('unlocking the same chapter twice charges only once', async () => {
    const walletBefore = await h.request<{ credits: number }>('GET', '/v1/credits/wallet', { token: reader.token });
    const again = await h.request<{ alreadyOwned: boolean; creditsSpent: number }>(
      'POST',
      `/v1/chapters/${creator.chapterIds[0]}/unlock`,
      { token: reader.token },
    );
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyOwned, true);
    assert.equal(again.body.creditsSpent, 0);

    const walletAfter = await h.request<{ credits: number }>('GET', '/v1/credits/wallet', { token: reader.token });
    assert.equal(walletAfter.body.credits, walletBefore.body.credits);
  });

  test('an empty wallet cannot unlock', async () => {
    const broke = await createReader(h, 'broke');
    const res = await h.request<{ error: { code: string } }>('POST', `/v1/chapters/${creator.chapterIds[1]}/unlock`, {
      token: broke.token,
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'redemption.insufficient_credits');
  });

  test('a creator cannot buy their own chapter', async () => {
    await buyCredits(h, { ...creator }, 'coins_100');
    const res = await h.request<{ error: { code: string } }>('POST', `/v1/chapters/${creator.chapterIds[1]}/unlock`, {
      token: creator.token,
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'risk.self_purchase');
  });

  test('concurrent unlocks of the same chapter charge exactly once', async () => {
    const racer = await createReader(h, 'racer');
    await buyCredits(h, racer, 'coins_500');
    const chapter = creator.chapterIds[1]!;

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        h.request<{ creditsSpent: number; alreadyOwned: boolean }>('POST', `/v1/chapters/${chapter}/unlock`, {
          token: racer.token,
        }),
      ),
    );

    const charged = results.filter((r) => r.status < 400 && r.body.creditsSpent > 0);
    assert.equal(charged.length, 1, 'exactly one of the concurrent unlocks may charge');

    const wallet = await h.request<{ credits: number }>('GET', '/v1/credits/wallet', { token: racer.token });
    assert.equal(wallet.body.credits, 535 - 25);
    await reconcile();
  });

  test('concurrent unlocks cannot overdraw a wallet', async () => {
    const tight = await createReader(h, 'tight');
    await buyCredits(h, tight, 'coins_100'); // 100 credits
    const wide = await createCreator(h, { label: 'wide', chapters: [40, 40, 40] });

    const results = await Promise.all(
      wide.chapterIds.map((c) =>
        h.request<{ creditsSpent: number }>('POST', `/v1/chapters/${c}/unlock`, { token: tight.token }),
      ),
    );
    const succeeded = results.filter((r) => r.status < 400);
    assert.equal(succeeded.length, 2, 'only two 40-credit chapters fit in a 100-credit wallet');

    const wallet = await h.request<{ credits: number }>('GET', '/v1/credits/wallet', { token: tight.token });
    assert.equal(wallet.body.credits, 20);
    await reconcile();
  });
});

describe('tips', () => {
  test('a tip splits at capture with the creator keeping the whole amount net of aggregator fees', async () => {
    const creator = await createCreator(h, { label: 'tipped' });
    const fan = await createReader(h, 'fan');

    const before = await h.request<{ payablePaise: number; reservePaise: number }>(
      'GET',
      '/v1/creators/me/balance',
      { token: creator.token },
    );

    const tip = await h.request<{ orderId: string }>('POST', '/v1/tips', {
      token: fan.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { creatorId: creator.creatorId, amountPaise: 20_000, message: 'Loved it' },
    });
    assert.equal(tip.status, 201);

    h.sim.payOrder(tip.body.orderId);
    await h.settle();

    const after = await h.request<{ payablePaise: number; reservePaise: number }>(
      'GET',
      '/v1/creators/me/balance',
      { token: creator.token },
    );
    const delta =
      after.body.payablePaise + after.body.reservePaise - (before.body.payablePaise + before.body.reservePaise);

    // Rs 200 tip: no platform fee, minus PG 2% + GST and split 0.25% + GST.
    assert.equal(delta, 20_000 - 400 - 72 - 50 - 9);
    await reconcile();
  });

  test('a creator cannot tip themselves', async () => {
    const creator = await createCreator(h, { label: 'selftip' });
    const res = await h.request<{ error: { code: string } }>('POST', '/v1/tips', {
      token: creator.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { creatorId: creator.creatorId, amountPaise: 20_000 },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'credits.self_tip');
  });
});

describe('refunds', () => {
  test('a refund inside the grace window unwinds the split exactly and revokes access', async () => {
    const creator = await createCreator(h, { label: 'refundee', chapters: [50] });
    const reader = await createReader(h, 'refunder');
    await buyCredits(h, reader, 'coins_500');

    const unlock = await h.request<{ redemptionId: string }>('POST', `/v1/chapters/${creator.chapterIds[0]}/unlock`, {
      token: reader.token,
    });

    const balanceAfterPurchase = await h.request<{ payablePaise: number; reservePaise: number }>(
      'GET',
      '/v1/creators/me/balance',
      { token: creator.token },
    );
    assert.ok(balanceAfterPurchase.body.payablePaise + balanceAfterPurchase.body.reservePaise > 0);

    const refund = await h.request<{ creditsRestored: number; amountPaise: number }>(
      'POST',
      `/v1/redemptions/${unlock.body.redemptionId}/refund`,
      {
        token: reader.token,
        headers: { 'idempotency-key': randomUUID() },
        body: { mode: 'to_credits', reason: 'changed my mind' },
      },
    );
    assert.equal(refund.status, 201);
    assert.equal(refund.body.amountPaise, 5000);
    assert.equal(refund.body.creditsRestored, 50);

    const balanceAfterRefund = await h.request<{ payablePaise: number; reservePaise: number }>(
      'GET',
      '/v1/creators/me/balance',
      { token: creator.token },
    );
    assert.equal(
      balanceAfterRefund.body.payablePaise + balanceAfterRefund.body.reservePaise,
      0,
      'the creator’s entitlement is fully unwound',
    );

    const wallet = await h.request<{ credits: number }>('GET', '/v1/credits/wallet', { token: reader.token });
    assert.equal(wallet.body.credits, 535, 'coins are restored in full');

    const entitlements = await h.request<{ entitlements: { chapter_id: string }[] }>('GET', '/v1/me/entitlements', {
      token: reader.token,
    });
    assert.ok(
      !entitlements.body.entitlements.some((e) => e.chapter_id === creator.chapterIds[0]),
      'access is revoked with the refund',
    );

    await reconcile();
  });

  test('a reader cannot refund someone else’s purchase', async () => {
    const creator = await createCreator(h, { label: 'notyours', chapters: [10] });
    const owner = await createReader(h, 'owner');
    const stranger = await createReader(h, 'stranger');
    await buyCredits(h, owner, 'coins_100');

    const unlock = await h.request<{ redemptionId: string }>('POST', `/v1/chapters/${creator.chapterIds[0]}/unlock`, {
      token: owner.token,
    });
    const res = await h.request<{ error: { code: string } }>(
      'POST',
      `/v1/redemptions/${unlock.body.redemptionId}/refund`,
      {
        token: stranger.token,
        headers: { 'idempotency-key': randomUUID() },
        body: { mode: 'to_credits', reason: 'not mine' },
      },
    );
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'refund.not_owner');
  });

  test('a refund to the original instrument goes back through the aggregator', async () => {
    const creator = await createCreator(h, { label: 'sourcerefund', chapters: [50] });
    const reader = await createReader(h, 'sourcerefunder');
    await buyCredits(h, reader, 'coins_500');

    const unlock = await h.request<{ redemptionId: string }>('POST', `/v1/chapters/${creator.chapterIds[0]}/unlock`, {
      token: reader.token,
    });
    const refund = await h.request<{ refundId: string; status: string }>(
      'POST',
      `/v1/redemptions/${unlock.body.redemptionId}/refund`,
      {
        token: reader.token,
        headers: { 'idempotency-key': randomUUID() },
        body: { mode: 'to_source', reason: 'accidental purchase' },
      },
    );
    assert.equal(refund.status, 201);
    assert.equal(refund.body.status, 'pending');

    await h.settle();

    const row = await h.container.db.transaction(
      async (uow) => {
        const res = await uow.query<{ status: string; provider_refund_id: string | null }>(
          'SELECT status, provider_refund_id FROM refunds WHERE id = $1',
          [refund.body.refundId],
        );
        return res.rows[0]!;
      },
      { readOnly: true },
    );
    assert.equal(row.status, 'succeeded', 'the aggregator confirmed the refund and the webhook settled it');
    assert.ok(row.provider_refund_id);

    await reconcile();
  });
});

describe('webhook handling', () => {
  test('a forged signature is rejected', async () => {
    const res = await h.request('POST', '/v1/webhooks/cashfree', {
      headers: {
        'x-webhook-signature': Buffer.from('not-a-real-signature').toString('base64'),
        'x-webhook-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      body: { type: 'PAYMENT_SUCCESS_WEBHOOK', data: {} },
    });
    assert.equal(res.status, 401);
  });

  test('a delivery with no signature headers is rejected', async () => {
    const res = await h.request('POST', '/v1/webhooks/cashfree', {
      body: { type: 'PAYMENT_SUCCESS_WEBHOOK', data: {} },
    });
    assert.equal(res.status, 401);
  });

  test('a replayed delivery is recognised as a duplicate and grants nothing twice', async () => {
    const reader = await createReader(h, 'replay');
    const order = await h.request<{ orderId: string }>('POST', '/v1/credits/orders', {
      token: reader.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { sku: 'coins_250' },
    });

    h.sim.payOrder(order.body.orderId);
    await h.settle();
    // Deliver the very same event again.
    h.sim.payOrder(order.body.orderId);
    await h.settle();

    const wallet = await h.request<{ credits: number }>('GET', '/v1/credits/wallet', { token: reader.token });
    assert.equal(wallet.body.credits, 260, 'coins granted once despite a duplicate delivery');
    await reconcile();
  });
});
