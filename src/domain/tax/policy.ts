import { applyRateHalfUp, clampNonNegative, percentToPpm, subtract, type Paise, type RatePpm } from '../money/money.js';
import { err } from '../errors.js';
import { parseGstin, parsePan, type GstinInfo } from './identifiers.js';

/**
 * Statutory rate book. Every rate is dated and cited so a change in law is a
 * data change with an audit trail, never a scattered edit.
 */
export interface RateRule {
  readonly ratePpm: RatePpm;
  readonly effectiveFrom: string; // ISO date
  readonly effectiveTo: string | null;
  readonly authority: string;
}

export interface RateBook {
  /** GST on the platform's own commission (outward supply of intermediary service). */
  readonly gstOnCommission: RateRule[];
  /** GST on the underlying digital-content supply (OIDAR / digital publication). */
  readonly gstOnDigitalContent: RateRule[];
  /** TCS under CGST s.52 on net taxable value of supplies by registered suppliers. */
  readonly tcs: RateRule[];
  /** TDS under Income-tax s.194-O on gross amount paid/credited to resident e-commerce participants. */
  readonly tds194O: RateRule[];
  /** Penal TDS rate where PAN is not furnished (s.206AA). */
  readonly tdsNoPan: RateRule[];
}

export const DEFAULT_RATE_BOOK: RateBook = {
  gstOnCommission: [
    {
      ratePpm: percentToPpm(18),
      effectiveFrom: '2017-07-01',
      effectiveTo: null,
      authority: 'CGST Notification 11/2017-CT(R); slab retained at 18% by the 56th GST Council (3 Sep 2025)',
    },
  ],
  gstOnDigitalContent: [
    {
      ratePpm: percentToPpm(18),
      effectiveFrom: '2017-07-01',
      effectiveTo: null,
      authority: 'OIDAR / digital publications taxed at 18%; printed books exempt but not digital works',
    },
  ],
  tcs: [
    {
      ratePpm: percentToPpm(1),
      effectiveFrom: '2018-10-01',
      effectiveTo: '2024-07-09',
      authority: 'CGST s.52 read with Notification 52/2018-CT',
    },
    {
      ratePpm: percentToPpm(0.5),
      effectiveFrom: '2024-07-10',
      effectiveTo: null,
      authority: 'CBIC Notification 15/2024-Central Tax dated 10 July 2024 (53rd GST Council)',
    },
  ],
  tds194O: [
    {
      ratePpm: percentToPpm(1),
      effectiveFrom: '2020-10-01',
      effectiveTo: '2024-09-30',
      authority: 'Finance Act 2020, s.194-O',
    },
    {
      ratePpm: percentToPpm(0.1),
      effectiveFrom: '2024-10-01',
      effectiveTo: null,
      authority: 'Finance (No. 2) Act 2024 effective 1 Oct 2024; retained by Income-tax Act 2025 s.393(1) Sl.8(v)',
    },
  ],
  tdsNoPan: [
    {
      ratePpm: percentToPpm(5),
      effectiveFrom: '2020-10-01',
      effectiveTo: null,
      authority: 'Income-tax s.206AA proviso to s.194-O',
    },
  ],
};

export function resolveRate(rules: readonly RateRule[], on: Date): RateRule {
  const day = on.toISOString().slice(0, 10);
  for (const rule of rules) {
    if (day >= rule.effectiveFrom && (rule.effectiveTo === null || day <= rule.effectiveTo)) {
      return rule;
    }
  }
  throw err.internal('tax.no_effective_rate', 'no statutory rate is effective on this date', { day });
}

/** Rs 5,00,000 per creator per financial year: the s.194-O exemption ceiling. */
export const TDS_194O_EXEMPTION_LIMIT: Paise = 5_00_000_00;

/** Rs 20,00,000 services threshold for a creator's own GST registration (s.22). */
export const GST_REGISTRATION_THRESHOLD_SERVICES: Paise = 20_00_000_00;
export const GST_REGISTRATION_THRESHOLD_SPECIAL_CATEGORY: Paise = 10_00_000_00;

export type EntityType =
  | 'individual'
  | 'huf'
  | 'company'
  | 'firm'
  | 'association_of_persons'
  | 'trust'
  | 'body_of_individuals'
  | 'local_authority'
  | 'artificial_juridical_person'
  | 'government';

export interface CreatorTaxProfile {
  readonly creatorId: string;
  readonly pan: string | null;
  readonly panVerified: boolean;
  readonly gstin: string | null;
  readonly entityType: EntityType;
  /** Place of supply state code (from GSTIN, or declared address). */
  readonly stateCode: string | null;
}

export interface TaxLine {
  readonly kind: 'gst_commission' | 'gst_content' | 'tcs' | 'tds';
  readonly amount: Paise;
  readonly base: Paise;
  readonly ratePpm: RatePpm;
  readonly authority: string;
  readonly note: string;
}

export interface TaxPolicy {
  gstOnCommission(commission: Paise, on: Date): TaxLine;
  gstOnContentSupply(value: Paise, on: Date): TaxLine;
  tcs(netTaxableValue: Paise, profile: CreatorTaxProfile, on: Date): TaxLine;
  tds194O(args: TdsArgs): TaxLine;
  isCreatorGstRegistered(profile: CreatorTaxProfile): boolean;
  gstRegistrationThreshold(profile: CreatorTaxProfile): Paise;
}

export interface TdsArgs {
  /** Gross amount of sales for the current settlement period (includes the platform fee, per Circular 20/2023). */
  readonly periodGross: Paise;
  /** Gross sales already credited to this creator earlier in the same financial year. */
  readonly priorFyGross: Paise;
  /** TDS already deducted earlier in the same financial year. */
  readonly priorFyTdsDeducted: Paise;
  readonly profile: CreatorTaxProfile;
  readonly on: Date;
}

export class StatutoryTaxPolicy implements TaxPolicy {
  constructor(private readonly rates: RateBook = DEFAULT_RATE_BOOK) {}

  isCreatorGstRegistered(profile: CreatorTaxProfile): boolean {
    return !!profile.gstin && parseGstin(profile.gstin) !== null;
  }

  gstinInfo(profile: CreatorTaxProfile): GstinInfo | null {
    return profile.gstin ? parseGstin(profile.gstin) : null;
  }

  gstRegistrationThreshold(profile: CreatorTaxProfile): Paise {
    const info = this.gstinInfo(profile);
    const special = info
      ? info.isSpecialCategoryState
      : profile.stateCode
        ? ['11', '12', '13', '14', '15', '16', '17', '05'].includes(profile.stateCode)
        : false;
    return special ? GST_REGISTRATION_THRESHOLD_SPECIAL_CATEGORY : GST_REGISTRATION_THRESHOLD_SERVICES;
  }

  gstOnCommission(commission: Paise, on: Date): TaxLine {
    const rule = resolveRate(this.rates.gstOnCommission, on);
    return {
      kind: 'gst_commission',
      amount: applyRateHalfUp(commission, rule.ratePpm),
      base: commission,
      ratePpm: rule.ratePpm,
      authority: rule.authority,
      note: 'GST on the platform commission, which is the platform’s own outward supply of service.',
    };
  }

  gstOnContentSupply(value: Paise, on: Date): TaxLine {
    const rule = resolveRate(this.rates.gstOnDigitalContent, on);
    return {
      kind: 'gst_content',
      amount: applyRateHalfUp(value, rule.ratePpm),
      base: value,
      ratePpm: rule.ratePpm,
      authority: rule.authority,
      note: 'GST on the underlying digital content supply. The creator is the supplier and bears this liability.',
    };
  }

  /**
   * TCS under CGST s.52. Collected only from suppliers who hold a GSTIN: an
   * unregistered creator has no electronic cash ledger to credit, so there is
   * nothing to deposit against them in GSTR-8.
   */
  tcs(netTaxableValue: Paise, profile: CreatorTaxProfile, on: Date): TaxLine {
    const rule = resolveRate(this.rates.tcs, on);
    const registered = this.isCreatorGstRegistered(profile);
    const base = clampNonNegative(netTaxableValue);
    return {
      kind: 'tcs',
      amount: registered ? applyRateHalfUp(base, rule.ratePpm) : 0,
      base: registered ? base : 0,
      ratePpm: registered ? rule.ratePpm : 0,
      authority: rule.authority,
      note: registered
        ? 'TCS on net taxable value of supplies made through the ECO by a registered supplier.'
        : 'Creator is not GST-registered; no GSTIN exists to deposit TCS against, so no TCS is collected.',
    };
  }

  /**
   * TDS under s.194-O, computed on a cumulative financial-year basis.
   *
   * The exemption in the proviso is conditional on the creator being an
   * individual or HUF who has furnished a PAN AND whose gross sales through
   * the platform do not exceed Rs 5 lakh in the year. Once the year's gross
   * crosses that ceiling the exemption is lost for the year, so we compute the
   * whole-year liability and deduct the difference already withheld. That
   * produces a catch-up deduction on the crossing period and is the
   * conservative statutory reading.
   */
  tds194O(args: TdsArgs): TaxLine {
    const { periodGross, priorFyGross, priorFyTdsDeducted, profile, on } = args;
    const panInfo = profile.pan ? parsePan(profile.pan) : null;
    const hasValidPan = !!panInfo && profile.panVerified;

    const cumulativeGross = priorFyGross + periodGross;

    const standard = resolveRate(this.rates.tds194O, on);
    const penal = resolveRate(this.rates.tdsNoPan, on);

    if (!hasValidPan) {
      const rule = penal;
      const cumulativeLiability = applyRateHalfUp(cumulativeGross, rule.ratePpm);
      const due = clampNonNegative(subtract(cumulativeLiability, priorFyTdsDeducted));
      return {
        kind: 'tds',
        amount: due,
        base: periodGross,
        ratePpm: rule.ratePpm,
        authority: rule.authority,
        note: 'PAN not furnished or not verified: TDS at the penal s.206AA rate on the full gross amount.',
      };
    }

    const eligibleForExemption =
      (panInfo.isIndividualOrHuf || profile.entityType === 'individual' || profile.entityType === 'huf') &&
      cumulativeGross <= TDS_194O_EXEMPTION_LIMIT;

    if (eligibleForExemption) {
      return {
        kind: 'tds',
        amount: 0,
        base: periodGross,
        ratePpm: 0,
        authority: standard.authority,
        note: `Individual/HUF with PAN and cumulative gross of ${cumulativeGross} paise within the Rs 5 lakh exemption.`,
      };
    }

    const cumulativeLiability = applyRateHalfUp(cumulativeGross, standard.ratePpm);
    const due = clampNonNegative(subtract(cumulativeLiability, priorFyTdsDeducted));
    return {
      kind: 'tds',
      amount: due,
      base: periodGross,
      ratePpm: standard.ratePpm,
      authority: standard.authority,
      note:
        priorFyGross <= TDS_194O_EXEMPTION_LIMIT && cumulativeGross > TDS_194O_EXEMPTION_LIMIT
          ? 'Exemption ceiling crossed this period: cumulative year liability recomputed and the shortfall deducted now.'
          : 'TDS on gross amount credited, computed cumulatively for the financial year.',
    };
  }
}

export const taxPolicy = new StatutoryTaxPolicy();
