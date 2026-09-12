import { percentToPpm, type Paise, type RatePpm } from '../money/money.js';

/**
 * Commercial fee schedule (blueprint Part 9).
 *
 * Conservative standard rates are the default, not the festive-offer rates:
 * PG 2.0%, Easy Split 0.25%. Rates live in configuration so a renegotiated
 * merchant agreement is a config change with an effective date, never a code
 * change.
 */
export interface FeeSchedule {
  /** Platform commission on paid content. */
  readonly platformFeePpm: RatePpm;
  /** Platform commission on tips. Zero by default: tips carry high goodwill value. */
  readonly tipFeePpm: RatePpm;
  /** PA platform/technology fee charged at capture, passed through to creators transparently. */
  readonly pgFeePpm: RatePpm;
  /** Per-split fee charged by the PA on each vendor leg. */
  readonly splitFeePpm: RatePpm;
  /** GST charged by the PA on its own fees, which the platform bears as input cost. */
  readonly gstOnPgFeePpm: RatePpm;
  /** Fraction of each creator credit held back through the dispute grace window. */
  readonly reservePpm: RatePpm;
  /** Minimum net payable before a payout is dispatched. */
  readonly minimumPayoutPaise: Paise;
  /** Payout charges by slab (inclusive upper bounds), before GST. */
  readonly payoutFeeSlabs: readonly { readonly upToPaise: Paise | null; readonly feePaise: Paise }[];
  /** Credit bundles offered to readers. */
  readonly creditBundles: readonly CreditBundle[];
  /** Value of one credit in paise. */
  readonly creditValuePaise: Paise;
  /** Days after which unredeemed credits expire into breakage. */
  readonly creditExpiryDays: number;
}

export interface CreditBundle {
  readonly sku: string;
  readonly pricePaise: Paise;
  readonly credits: number;
  readonly bonusCredits: number;
  readonly label: string;
}

export const DEFAULT_FEE_SCHEDULE: FeeSchedule = {
  platformFeePpm: percentToPpm(10),
  tipFeePpm: percentToPpm(0),
  pgFeePpm: percentToPpm(2.0),
  splitFeePpm: percentToPpm(0.25),
  gstOnPgFeePpm: percentToPpm(18),
  reservePpm: percentToPpm(10),
  minimumPayoutPaise: 100_00, // Rs 100
  payoutFeeSlabs: [
    { upToPaise: 1_000_00, feePaise: 6_00 },
    { upToPaise: 25_000_00, feePaise: 8_00 },
    { upToPaise: null, feePaise: 15_00 },
  ],
  creditValuePaise: 100, // 1 credit = Rs 1
  creditExpiryDays: 1095, // 3 years
  creditBundles: [
    { sku: 'coins_100', pricePaise: 100_00, credits: 100, bonusCredits: 0, label: '100 coins' },
    { sku: 'coins_250', pricePaise: 250_00, credits: 250, bonusCredits: 10, label: '250 coins + 10 bonus' },
    { sku: 'coins_500', pricePaise: 500_00, credits: 500, bonusCredits: 35, label: '500 coins + 35 bonus' },
    { sku: 'coins_1000', pricePaise: 1000_00, credits: 1000, bonusCredits: 100, label: '1000 coins + 100 bonus' },
  ],
};

export function bundleBySku(schedule: FeeSchedule, sku: string): CreditBundle | undefined {
  return schedule.creditBundles.find((b) => b.sku === sku);
}

export function payoutFeeFor(schedule: FeeSchedule, amount: Paise): Paise {
  for (const slab of schedule.payoutFeeSlabs) {
    if (slab.upToPaise === null || amount <= slab.upToPaise) return slab.feePaise;
  }
  const last = schedule.payoutFeeSlabs[schedule.payoutFeeSlabs.length - 1];
  return last ? last.feePaise : 0;
}
