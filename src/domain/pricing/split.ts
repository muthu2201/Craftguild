import { applyRateHalfUp, assertPositive, sum, subtract, type Paise } from '../money/money.js';
import { err } from '../errors.js';
import type { FeeSchedule } from './fee-schedule.js';
import type { CreatorTaxProfile, TaxPolicy } from '../tax/policy.js';

/**
 * Per-transaction split computation.
 *
 * Line order mirrors the creator statement required by the blueprint (Part 9):
 *   Gross -> PG fee -> GST on PG fee -> Platform fee -> GST on platform fee
 *         -> TCS -> TDS -> Creator net
 *
 * TCS and TDS are NOT computed here: both are statutorily cumulative
 * (TCS on net taxable value for the return period, TDS on financial-year
 * gross), so they are applied once at settlement close. This function produces
 * the transaction-level lines and the creator's pre-withholding entitlement.
 */

export type SaleKind = 'chapter' | 'tip';

export interface SplitInput {
  readonly grossPaise: Paise;
  readonly kind: SaleKind;
  readonly schedule: FeeSchedule;
  /** True when the gross arrived through a prepaid credit bundle whose PG fee was already borne at top-up. */
  readonly pgFeeAlreadyBorneAtTopUp: boolean;
}

export interface SplitResult {
  readonly gross: Paise;
  readonly pgFee: Paise;
  readonly gstOnPgFee: Paise;
  readonly platformFee: Paise;
  readonly gstOnPlatformFee: Paise;
  readonly splitFee: Paise;
  readonly gstOnSplitFee: Paise;
  /** Creator's entitlement before statutory withholding (TCS/TDS). */
  readonly creatorGross: Paise;
  /** Portion of creatorGross held back through the grace window. */
  readonly reserveHeld: Paise;
  /** Immediately-payable portion of creatorGross. */
  readonly creatorPayableNow: Paise;
  /** Platform's retained revenue net of the fees it bears on this transaction. */
  readonly platformNetRevenue: Paise;
}

/**
 * Split a gross sale. Invariant, checked before returning:
 *   gross === pgFee + gstOnPgFee + platformFee + gstOnPlatformFee
 *          + splitFee + gstOnSplitFee + creatorGross
 */
export function computeSplit(input: SplitInput): SplitResult {
  const { grossPaise, kind, schedule } = input;
  assertPositive(grossPaise, 'gross');

  const feePpm = kind === 'tip' ? schedule.tipFeePpm : schedule.platformFeePpm;

  // The PG fee is a real cost incurred at capture. Under the credits model it
  // is incurred once on the bundle and recovered pro rata at each redemption,
  // so the same rate is applied either way and the recovery nets the expense.
  const pgFee = applyRateHalfUp(grossPaise, schedule.pgFeePpm);
  const gstOnPgFee = applyRateHalfUp(pgFee, schedule.gstOnPgFeePpm);

  const platformFee = applyRateHalfUp(grossPaise, feePpm);
  const gstOnPlatformFee = applyRateHalfUp(platformFee, schedule.gstOnPgFeePpm);

  const splitFee = applyRateHalfUp(grossPaise, schedule.splitFeePpm);
  const gstOnSplitFee = applyRateHalfUp(splitFee, schedule.gstOnPgFeePpm);

  const deductions = sum(pgFee, gstOnPgFee, platformFee, gstOnPlatformFee, splitFee, gstOnSplitFee);
  const creatorGross = subtract(grossPaise, deductions);

  if (creatorGross < 0) {
    throw err.precondition('pricing.gross_below_fee_floor', 'transaction value is below the total fee floor', {
      gross: grossPaise,
      deductions,
    });
  }

  const reserveHeld = applyRateHalfUp(creatorGross, schedule.reservePpm);
  const creatorPayableNow = subtract(creatorGross, reserveHeld);

  const recomposed = sum(
    pgFee,
    gstOnPgFee,
    platformFee,
    gstOnPlatformFee,
    splitFee,
    gstOnSplitFee,
    creatorGross,
  );
  if (recomposed !== grossPaise) {
    throw err.internal('pricing.split_invariant_violated', 'split components do not reconstitute the gross', {
      gross: grossPaise,
      recomposed,
    });
  }

  // The platform keeps its commission but bears the PA's fees and remits GST
  // on its own commission, so its true net on the transaction is:
  const platformNetRevenue = subtract(platformFee, sum(splitFee, gstOnSplitFee));

  return {
    gross: grossPaise,
    pgFee,
    gstOnPgFee,
    platformFee,
    gstOnPlatformFee,
    splitFee,
    gstOnSplitFee,
    creatorGross,
    reserveHeld,
    creatorPayableNow,
    platformNetRevenue,
  };
}

/** Reverse a split exactly, for refunds. Returns the same line amounts to be unwound. */
export function reverseSplit(original: SplitResult, refundGross: Paise): SplitResult {
  assertPositive(refundGross, 'refund gross');
  if (refundGross > original.gross) {
    throw err.validation('pricing.refund_exceeds_original', 'refund exceeds the original gross', {
      refundGross,
      originalGross: original.gross,
    });
  }
  if (refundGross === original.gross) return original;

  // Partial refund: allocate each line pro rata, then force the creator line to
  // absorb the rounding so the components still reconstitute the refund gross.
  const scale = (value: Paise): Paise =>
    Math.round((value * refundGross) / original.gross);

  const pgFee = scale(original.pgFee);
  const gstOnPgFee = scale(original.gstOnPgFee);
  const platformFee = scale(original.platformFee);
  const gstOnPlatformFee = scale(original.gstOnPlatformFee);
  const splitFee = scale(original.splitFee);
  const gstOnSplitFee = scale(original.gstOnSplitFee);
  const creatorGross = subtract(
    refundGross,
    sum(pgFee, gstOnPgFee, platformFee, gstOnPlatformFee, splitFee, gstOnSplitFee),
  );

  if (creatorGross < 0) {
    throw err.precondition('pricing.partial_refund_below_floor', 'partial refund is below the fee floor', {
      refundGross,
    });
  }

  const reserveHeld = Math.min(original.reserveHeld, applyRateHalfUp(creatorGross, 0));
  return {
    gross: refundGross,
    pgFee,
    gstOnPgFee,
    platformFee,
    gstOnPlatformFee,
    splitFee,
    gstOnSplitFee,
    creatorGross,
    reserveHeld,
    creatorPayableNow: subtract(creatorGross, reserveHeld),
    platformNetRevenue: subtract(platformFee, sum(splitFee, gstOnSplitFee)),
  };
}

export interface StatementWithholding {
  readonly tcs: Paise;
  readonly tds: Paise;
}

/** Statutory withholding at settlement close, over the whole period's totals. */
export function computeWithholding(args: {
  readonly periodGross: Paise;
  readonly periodNetTaxableValue: Paise;
  readonly priorFyGross: Paise;
  readonly priorFyTdsDeducted: Paise;
  readonly profile: CreatorTaxProfile;
  readonly policy: TaxPolicy;
  readonly on: Date;
}): StatementWithholding & { tcsLine: ReturnType<TaxPolicy['tcs']>; tdsLine: ReturnType<TaxPolicy['tds194O']> } {
  const tcsLine = args.policy.tcs(args.periodNetTaxableValue, args.profile, args.on);
  const tdsLine = args.policy.tds194O({
    periodGross: args.periodGross,
    priorFyGross: args.priorFyGross,
    priorFyTdsDeducted: args.priorFyTdsDeducted,
    profile: args.profile,
    on: args.on,
  });
  return { tcs: tcsLine.amount, tds: tdsLine.amount, tcsLine, tdsLine };
}
