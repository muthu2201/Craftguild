import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { StatutoryTaxPolicy, TDS_194O_EXEMPTION_LIMIT, type CreatorTaxProfile } from '../../src/domain/tax/policy.js';
import { gstinCheckDigit, isValidGstin, isValidPan, parseGstin, parsePan } from '../../src/domain/tax/identifiers.js';
import { makeGstin } from '../helpers/harness.js';

const policy = new StatutoryTaxPolicy();
const ON = new Date('2026-09-12T00:00:00Z');

function profile(over: Partial<CreatorTaxProfile> = {}): CreatorTaxProfile {
  return {
    creatorId: 'crt_test',
    pan: 'ABCPK1234M',
    panVerified: true,
    gstin: null,
    entityType: 'individual',
    stateCode: '33',
    ...over,
  };
}

describe('statutory identifiers', () => {
  test('PAN format and holder status', () => {
    assert.equal(isValidPan('ABCPK1234M'), true);
    assert.equal(isValidPan('ABCPK1234'), false);
    assert.equal(isValidPan('ABC0K1234M'), false);
    assert.equal(parsePan('ABCPK1234M')?.entityType, 'individual');
    assert.equal(parsePan('ABCCK1234M')?.entityType, 'company');
    assert.equal(parsePan('ABCHK1234M')?.isIndividualOrHuf, true);
    assert.equal(parsePan('ABCCK1234M')?.isIndividualOrHuf, false);
    assert.equal(parsePan('ABCXK1234M'), null, 'unknown status character is rejected');
  });

  test('GSTIN check digit is verified, not just the shape', () => {
    const valid = makeGstin('ABCPK1234M', '33');
    assert.equal(isValidGstin(valid), true);
    assert.equal(parseGstin(valid)?.stateCode, '33');
    assert.equal(parseGstin(valid)?.stateName, 'Tamil Nadu');
    assert.equal(parseGstin(valid)?.pan, 'ABCPK1234M');

    // Corrupt the check digit: same shape, wrong number.
    const broken = `${valid.slice(0, 14)}${valid[14] === 'A' ? 'B' : 'A'}`;
    assert.equal(isValidGstin(broken), false);
  });

  test('check digit computation matches the published algorithm', () => {
    const gstin = makeGstin('ABCPK1234M', '27');
    assert.equal(gstinCheckDigit(gstin.slice(0, 14)), gstin[14]);
  });

  test('special-category states get the lower registration threshold', () => {
    const sikkim = makeGstin('ABCPK1234M', '11');
    assert.equal(parseGstin(sikkim)?.isSpecialCategoryState, true);
    assert.equal(policy.gstRegistrationThreshold(profile({ gstin: sikkim })), 10_00_000_00);
    assert.equal(policy.gstRegistrationThreshold(profile()), 20_00_000_00);
  });
});

describe('GST on commission', () => {
  test('18% on the platform fee, which is the platform’s own supply', () => {
    const line = policy.gstOnCommission(100_00, ON);
    assert.equal(line.amount, 18_00);
    assert.equal(line.ratePpm, 180_000);
  });
});

describe('TCS (CGST s.52)', () => {
  test('0.5% is collected from registered suppliers', () => {
    const gstin = makeGstin('ABCPK1234M', '33');
    const line = policy.tcs(10_000_00, profile({ gstin }), ON);
    assert.equal(line.amount, 50_00);
    assert.equal(line.ratePpm, 5_000);
  });

  test('nothing is collected from an unregistered supplier: there is no ledger to credit', () => {
    const line = policy.tcs(10_000_00, profile({ gstin: null }), ON);
    assert.equal(line.amount, 0);
    assert.match(line.note, /not GST-registered/);
  });

  test('the pre-July-2024 rate still applies to a historic date', () => {
    const gstin = makeGstin('ABCPK1234M', '33');
    const line = policy.tcs(10_000_00, profile({ gstin }), new Date('2024-06-01T00:00:00Z'));
    assert.equal(line.ratePpm, 10_000, 'TCS was 1% before Notification 15/2024');
    assert.equal(line.amount, 100_00);
  });
});

describe('TDS (s.194-O)', () => {
  test('individual with PAN below the Rs 5 lakh ceiling is exempt', () => {
    const line = policy.tds194O({
      periodGross: 1_00_000_00,
      priorFyGross: 0,
      priorFyTdsDeducted: 0,
      profile: profile(),
      on: ON,
    });
    assert.equal(line.amount, 0);
  });

  test('crossing the ceiling triggers a catch-up on the whole year', () => {
    const priorFyGross = 4_90_000_00;
    const periodGross = 50_000_00; // takes the year to Rs 5,40,000
    const line = policy.tds194O({
      periodGross,
      priorFyGross,
      priorFyTdsDeducted: 0,
      profile: profile(),
      on: ON,
    });
    // 0.1% of the full cumulative Rs 5,40,000 = Rs 540
    assert.equal(line.amount, 540_00);
    assert.equal(line.ratePpm, 1_000);
    assert.match(line.note, /Exemption ceiling crossed/);
  });

  test('subsequent periods deduct only the incremental liability', () => {
    const line = policy.tds194O({
      periodGross: 1_00_000_00,
      priorFyGross: 5_40_000_00,
      priorFyTdsDeducted: 540_00,
      profile: profile(),
      on: ON,
    });
    // cumulative 6,40,000 -> liability 640; already deducted 540 -> 100
    assert.equal(line.amount, 100_00);
  });

  test('no PAN means the penal 5% rate on the full gross, with no exemption', () => {
    const line = policy.tds194O({
      periodGross: 10_000_00,
      priorFyGross: 0,
      priorFyTdsDeducted: 0,
      profile: profile({ pan: null, panVerified: false }),
      on: ON,
    });
    assert.equal(line.amount, 500_00);
    assert.equal(line.ratePpm, 50_000);
  });

  test('an unverified PAN is treated as no PAN', () => {
    const line = policy.tds194O({
      periodGross: 10_000_00,
      priorFyGross: 0,
      priorFyTdsDeducted: 0,
      profile: profile({ panVerified: false }),
      on: ON,
    });
    assert.equal(line.ratePpm, 50_000);
  });

  test('a company gets no exemption at any level', () => {
    const line = policy.tds194O({
      periodGross: 10_000_00,
      priorFyGross: 0,
      priorFyTdsDeducted: 0,
      profile: profile({ pan: 'ABCCK1234M', entityType: 'company' }),
      on: ON,
    });
    assert.equal(line.amount, 10_00, '0.1% of Rs 10,000');
  });

  test('the exemption boundary is inclusive of exactly Rs 5 lakh', () => {
    const exact = policy.tds194O({
      periodGross: TDS_194O_EXEMPTION_LIMIT,
      priorFyGross: 0,
      priorFyTdsDeducted: 0,
      profile: profile(),
      on: ON,
    });
    assert.equal(exact.amount, 0);

    const overByOnePaisa = policy.tds194O({
      periodGross: TDS_194O_EXEMPTION_LIMIT + 1,
      priorFyGross: 0,
      priorFyTdsDeducted: 0,
      profile: profile(),
      on: ON,
    });
    assert.ok(overByOnePaisa.amount > 0);
  });

  test('the pre-October-2024 1% rate still applies to a historic date', () => {
    const line = policy.tds194O({
      periodGross: 10_00_000_00,
      priorFyGross: 0,
      priorFyTdsDeducted: 0,
      profile: profile({ pan: 'ABCCK1234M', entityType: 'company' }),
      on: new Date('2024-05-01T00:00:00Z'),
    });
    assert.equal(line.ratePpm, 10_000);
  });
});
