import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FEE_SCHEDULE } from '../../src/domain/pricing/fee-schedule.js';
import { computeSplit } from '../../src/domain/pricing/split.js';
import { RATES, SETTLEMENT, splitGross, applyRate, formatInr } from '../../web/lib/fees.js';
import { ACCRUAL_DAYS, GRACE_DAYS } from '../../src/domain/settlement/cycle.js';
import { applyRateHalfUp, formatInr as backendFormatInr } from '../../src/domain/money/money.js';

/**
 * The public site quotes fees to creators before they sign up. Those numbers
 * must be the numbers the settlement engine actually applies, so the site's
 * copy of the schedule is asserted against the engine's here. A rate that
 * drifts on the marketing page is a promise the ledger would not keep, and it
 * should fail the build rather than reach a creator.
 */
describe('public site fee parity with the settlement engine', () => {
  test('every quoted rate matches the engine', () => {
    assert.equal(RATES.platformFeePpm, DEFAULT_FEE_SCHEDULE.platformFeePpm, 'platform fee');
    assert.equal(RATES.tipFeePpm, DEFAULT_FEE_SCHEDULE.tipFeePpm, 'tip fee');
    assert.equal(RATES.pgFeePpm, DEFAULT_FEE_SCHEDULE.pgFeePpm, 'payment aggregator fee');
    assert.equal(RATES.splitFeePpm, DEFAULT_FEE_SCHEDULE.splitFeePpm, 'split routing fee');
    assert.equal(RATES.gstPpm, DEFAULT_FEE_SCHEDULE.gstOnPgFeePpm, 'GST rate');
    assert.equal(RATES.reservePpm, DEFAULT_FEE_SCHEDULE.reservePpm, 'reserve holdback');
    assert.equal(SETTLEMENT.minimumPayoutPaise, DEFAULT_FEE_SCHEDULE.minimumPayoutPaise, 'minimum payout');
  });

  test('the quoted settlement cycle matches the engine', () => {
    assert.equal(SETTLEMENT.accrualDays, ACCRUAL_DAYS);
    assert.equal(SETTLEMENT.graceDays, GRACE_DAYS);
  });

  test('the site rounds money exactly as the ledger does', () => {
    for (const [amount, rate] of [
      [1000, RATES.platformFeePpm],
      [1000, RATES.splitFeePpm],
      [100, 5_000],
      [1, 1_000],
      [50_000, RATES.pgFeePpm],
      [333, RATES.gstPpm],
    ] as const) {
      assert.equal(applyRate(amount, rate), applyRateHalfUp(amount, rate), `${amount} @ ${rate}ppm`);
    }
  });

  test("the creator's share on the site equals the engine's, paise for paise", () => {
    for (let gross = 1; gross <= 3000; gross++) {
      const site = splitGross(gross, 'chapter');
      const engine = computeSplit({
        grossPaise: gross,
        kind: 'chapter',
        schedule: DEFAULT_FEE_SCHEDULE,
        pgFeeAlreadyBorneAtTopUp: true,
      });
      assert.equal(site.creator, engine.creatorGross, `creator share at ${gross} paise`);
      assert.equal(site.platform, engine.platformFee, `platform fee at ${gross} paise`);
    }
  });

  test('the four destinations always reconstitute the gross', () => {
    for (const gross of [1, 99, 1000, 2500, 5000, 10_000, 100_000, 1_00_000_00]) {
      const s = splitGross(gross);
      assert.equal(
        s.creator + s.platform + s.network + s.government,
        gross,
        `destinations must sum to gross at ${gross} paise`,
      );
      assert.ok(s.creator >= 0, 'the creator share is never negative');
    }
  });

  test('a tip carries no platform fee, on the site as in the engine', () => {
    const site = splitGross(20_000, 'tip');
    assert.equal(site.platform, 0);
  });

  test('Indian digit grouping matches the backend formatter', () => {
    for (const paise of [0, 5, 100_00, 1_00_000_00, 12_34_56_789_0]) {
      assert.equal(`₹${formatInr(paise)}`, backendFormatInr(paise), `grouping of ${paise} paise`);
    }
  });
});
