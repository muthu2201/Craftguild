import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildEntry, credit, debit, compact } from '../../src/domain/ledger/journal.js';
import { ACCOUNTS, normalBalance, signedEffect } from '../../src/domain/ledger/accounts.js';
import { computeSplit } from '../../src/domain/pricing/split.js';
import { DEFAULT_FEE_SCHEDULE, payoutFeeFor } from '../../src/domain/pricing/fee-schedule.js';
import { AppError } from '../../src/domain/errors.js';
import { percentToPpm } from '../../src/domain/money/money.js';

const now = new Date('2026-09-12T10:00:00Z');

describe('journal entries', () => {
  test('a balanced entry is accepted', () => {
    const entry = buildEntry({
      entryType: 'credit_topup_captured',
      occurredAt: now,
      referenceType: 'order',
      referenceId: 'ord_1',
      idempotencyKey: 'k1',
      postings: [debit('PA_ESCROW_RECEIVABLE', 9764), debit('PG_FEE_EXPENSE', 236), credit('CREDIT_LIABILITY', 10000)],
    });
    assert.equal(entry.totalDebit, 10000);
    assert.equal(entry.totalCredit, 10000);
  });

  test('an unbalanced entry is refused before it can reach the database', () => {
    assert.throws(
      () =>
        buildEntry({
          entryType: 'credit_topup_captured',
          occurredAt: now,
          referenceType: 'order',
          referenceId: 'ord_1',
          idempotencyKey: 'k2',
          postings: [debit('PA_ESCROW_RECEIVABLE', 9999), credit('CREDIT_LIABILITY', 10000)],
        }),
      (e: unknown) => e instanceof AppError && e.code === 'ledger.unbalanced_entry',
    );
  });

  test('a creator-scoped account requires a creator id', () => {
    assert.throws(
      () =>
        buildEntry({
          entryType: 'chapter_redemption',
          occurredAt: now,
          referenceType: 'redemption',
          referenceId: 'rdm_1',
          idempotencyKey: 'k3',
          postings: [debit('CREDIT_LIABILITY', 100), credit('CREATOR_PAYABLE', 100)],
        }),
      (e: unknown) => e instanceof AppError && e.code === 'ledger.missing_creator_scope',
    );
  });

  test('a non-scoped account refuses a creator id', () => {
    assert.throws(
      () =>
        buildEntry({
          entryType: 'chapter_redemption',
          occurredAt: now,
          referenceType: 'redemption',
          referenceId: 'rdm_1',
          idempotencyKey: 'k4',
          postings: [debit('CREDIT_LIABILITY', 100, 'crt_x'), credit('CREATOR_PAYABLE', 100, 'crt_x')],
        }),
      (e: unknown) => e instanceof AppError && e.code === 'ledger.unexpected_creator_scope',
    );
  });

  test('zero-amount postings are dropped, never posted', () => {
    const postings = compact([debit('CREDIT_LIABILITY', 100), credit('CREATOR_PAYABLE', 100, 'crt_x'), credit('TCS_PAYABLE', 0)]);
    assert.equal(postings.length, 2);
  });

  test('account normal balances follow accounting convention', () => {
    assert.equal(normalBalance(ACCOUNTS.PA_ESCROW_RECEIVABLE.type), 'debit');
    assert.equal(normalBalance(ACCOUNTS.CREATOR_PAYABLE.type), 'credit');
    assert.equal(normalBalance(ACCOUNTS.PLATFORM_FEE_REVENUE.type), 'credit');
    assert.equal(normalBalance(ACCOUNTS.PG_FEE_EXPENSE.type), 'debit');
    assert.equal(signedEffect('liability', 'credit'), 1);
    assert.equal(signedEffect('liability', 'debit'), -1);
  });

  test('every account code is unique', () => {
    const codes = Object.values(ACCOUNTS).map((a) => a.code);
    assert.equal(new Set(codes).size, codes.length);
  });
});

describe('split computation', () => {
  const schedule = DEFAULT_FEE_SCHEDULE;

  test('a Rs 10 chapter splits exactly, with no paise lost', () => {
    const split = computeSplit({ grossPaise: 1000, kind: 'chapter', schedule, pgFeeAlreadyBorneAtTopUp: true });
    assert.equal(split.gross, 1000);
    assert.equal(split.platformFee, 100, '10% of Rs 10');
    assert.equal(split.gstOnPlatformFee, 18, '18% of Re 1');
    assert.equal(split.pgFee, 20, '2% of Rs 10');
    assert.equal(split.gstOnPgFee, 4);
    assert.equal(split.splitFee, 3, '0.25% of Rs 10 rounded half-up');
    assert.equal(split.gstOnSplitFee, 1);
    assert.equal(
      split.pgFee + split.gstOnPgFee + split.platformFee + split.gstOnPlatformFee + split.splitFee + split.gstOnSplitFee + split.creatorGross,
      1000,
    );
  });

  test('the split invariant holds across a wide range of prices', () => {
    for (let gross = 1; gross <= 5000; gross++) {
      const s = computeSplit({ grossPaise: gross, kind: 'chapter', schedule, pgFeeAlreadyBorneAtTopUp: true });
      const recomposed =
        s.pgFee + s.gstOnPgFee + s.platformFee + s.gstOnPlatformFee + s.splitFee + s.gstOnSplitFee + s.creatorGross;
      assert.equal(recomposed, gross, `split of ${gross} paise must reconstitute exactly`);
      assert.ok(s.creatorGross >= 0);
      assert.equal(s.reserveHeld + s.creatorPayableNow, s.creatorGross);
    }
  });

  test('tips carry no platform fee by default', () => {
    const s = computeSplit({ grossPaise: 20_000, kind: 'tip', schedule, pgFeeAlreadyBorneAtTopUp: false });
    assert.equal(s.platformFee, 0);
    assert.equal(s.gstOnPlatformFee, 0);
    assert.ok(s.creatorGross > 19_000, 'the creator keeps almost all of a tip');
  });

  test('the reserve is 10% of the creator share by default', () => {
    const s = computeSplit({ grossPaise: 100_000, kind: 'chapter', schedule, pgFeeAlreadyBorneAtTopUp: true });
    assert.equal(s.reserveHeld, Math.round(s.creatorGross * 0.1));
  });

  test('a price below the total fee floor is rejected rather than paying a negative creator share', () => {
    const brutal = { ...schedule, platformFeePpm: percentToPpm(95), pgFeePpm: percentToPpm(10) };
    assert.throws(
      () => computeSplit({ grossPaise: 100, kind: 'chapter', schedule: brutal, pgFeeAlreadyBorneAtTopUp: true }),
      (e: unknown) => e instanceof AppError && e.code === 'pricing.gross_below_fee_floor',
    );
  });

  test('payout fee slabs match the published aggregator table', () => {
    assert.equal(payoutFeeFor(schedule, 500_00), 6_00);
    assert.equal(payoutFeeFor(schedule, 1_000_00), 6_00);
    assert.equal(payoutFeeFor(schedule, 1_000_01), 8_00);
    assert.equal(payoutFeeFor(schedule, 25_000_00), 8_00);
    assert.equal(payoutFeeFor(schedule, 25_000_01), 15_00);
  });

  test('a Rs 500 purchase deducts every statement line, GST included', () => {
    const s = computeSplit({ grossPaise: 500_00, kind: 'chapter', schedule, pgFeeAlreadyBorneAtTopUp: true });
    assert.equal(s.platformFee, 50_00, 'Rs 50 commission on a Rs 500 sale');
    assert.equal(s.gstOnPlatformFee, 9_00, 'Rs 9 GST on the commission');
    assert.equal(s.pgFee, 10_00);
    assert.equal(s.gstOnPgFee, 1_80);
    assert.equal(s.splitFee, 1_25);
    assert.equal(s.gstOnSplitFee, 23);

    // Rs 427.72, not the "approximately Rs 440" quoted in Part 9 of the
    // blueprint: that figure nets only the headline fees, while the statement
    // line order the same document mandates (Gross -> PG fee -> GST on PG fee
    // -> Platform fee -> GST on platform fee -> ... -> Creator net) also puts
    // the GST on those fees on the creator, which is what Part 5 says happens
    // for an unregistered creator who cannot claim input credit.
    assert.equal(s.creatorGross, 427_72);
    assert.equal(s.creatorGross + 72_28, 500_00);
  });
});
