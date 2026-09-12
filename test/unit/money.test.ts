import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateByWeight,
  applyRateHalfUp,
  formatInr,
  MoneyError,
  paiseToRupeeString,
  percentToPpm,
  rupeesToPaise,
  taxFromInclusive,
  sum,
} from '../../src/domain/money/money.js';

describe('money', () => {
  test('rupee conversion is exact for amounts that trip binary floating point', () => {
    assert.equal(rupeesToPaise(10.07), 1007);
    assert.equal(rupeesToPaise(0.1), 10);
    assert.equal(rupeesToPaise(1.005), 101); // half-up, not the float 1.00499...
    assert.equal(rupeesToPaise(29.99), 2999);
    assert.equal(rupeesToPaise(1234567.89), 123456789);
  });

  test('paise render back to two decimals', () => {
    assert.equal(paiseToRupeeString(1007), '10.07');
    assert.equal(paiseToRupeeString(5), '0.05');
    assert.equal(paiseToRupeeString(-250), '-2.50');
    assert.equal(paiseToRupeeString(0), '0.00');
  });

  test('Indian digit grouping', () => {
    assert.equal(formatInr(10_00_00_000), '₹10,00,000.00');
    assert.equal(formatInr(100_00), '₹100.00');
    assert.equal(formatInr(1_23_45_678_90), '₹1,23,45,678.90');
  });

  test('rate application rounds half away from zero', () => {
    assert.equal(applyRateHalfUp(1000, percentToPpm(10)), 100);
    assert.equal(applyRateHalfUp(1000, percentToPpm(2)), 20);
    assert.equal(applyRateHalfUp(1000, percentToPpm(0.25)), 3); // 2.5 -> 3
    assert.equal(applyRateHalfUp(100, percentToPpm(0.5)), 1); // 0.5 -> 1
    assert.equal(applyRateHalfUp(1, percentToPpm(0.1)), 0);
    assert.equal(applyRateHalfUp(-1000, percentToPpm(10)), -100);
  });

  test('rate application stays exact for very large amounts', () => {
    const tenCrore = 100_00_00_000 * 100;
    assert.equal(applyRateHalfUp(tenCrore, percentToPpm(18)), tenCrore * 0.18);
  });

  test('allocation always sums exactly to the total', () => {
    for (const total of [1, 7, 100, 1001, 99_999, 1_23_456]) {
      for (const weights of [[1, 1, 1], [90, 10], [1, 2, 3, 4, 5, 6, 7], [999, 1]]) {
        const parts = allocateByWeight(total, weights);
        assert.equal(
          parts.reduce((a, b) => a + b, 0),
          total,
          `allocation of ${total} across ${weights} must be exact`,
        );
        assert.equal(parts.length, weights.length);
      }
    }
  });

  test('allocation is deterministic', () => {
    const a = allocateByWeight(100, [1, 1, 1]);
    const b = allocateByWeight(100, [1, 1, 1]);
    assert.deepEqual(a, b);
    assert.deepEqual(a, [34, 33, 33]);
  });

  test('tax extraction from an inclusive amount round-trips', () => {
    const gst = percentToPpm(18);
    const inclusive = 11_800;
    const tax = taxFromInclusive(inclusive, gst);
    assert.equal(tax, 1800);
    assert.equal(inclusive - tax, 10_000);
  });

  test('non-integer paise are rejected outright', () => {
    assert.throws(() => sum(1.5 as number), MoneyError);
    assert.throws(() => applyRateHalfUp(10.5, 100), MoneyError);
  });

  test('amounts beyond the platform ceiling are rejected', () => {
    assert.throws(() => sum(200_00_00_00_000), MoneyError);
  });
});
