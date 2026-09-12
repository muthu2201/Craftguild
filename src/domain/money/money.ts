/**
 * Exact monetary arithmetic in integer paise (1 INR = 100 paise).
 *
 * Every amount that enters the ledger, a tax computation or a payment
 * instruction is a `Paise` — a non-negative-or-negative safe integer. Floating
 * point is never used for money; rate application goes through
 * `applyRateHalfUp` which performs the multiplication in integer space.
 */

export type Paise = number;

/** Parts-per-million representation of a rate. 10% => 100_000 ppm. */
export type RatePpm = number;

export const PAISE_PER_RUPEE = 100;
export const PPM = 1_000_000;

/** Largest value we allow in a single amount field: ₹100 crore. */
export const MAX_PAISE: Paise = 100_00_00_00_000;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function assertPaise(value: unknown, label = 'amount'): asserts value is Paise {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MoneyError(`${label} must be an integer number of paise, got ${String(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} exceeds safe integer range`);
  }
  if (Math.abs(value) > MAX_PAISE) {
    throw new MoneyError(`${label} exceeds maximum permitted amount (${MAX_PAISE} paise)`);
  }
}

export function assertNonNegative(value: Paise, label = 'amount'): Paise {
  assertPaise(value, label);
  if (value < 0) throw new MoneyError(`${label} must not be negative, got ${value}`);
  return value;
}

export function assertPositive(value: Paise, label = 'amount'): Paise {
  assertNonNegative(value, label);
  if (value === 0) throw new MoneyError(`${label} must be greater than zero`);
  return value;
}

export function rupeesToPaise(rupees: number): Paise {
  if (typeof rupees !== 'number' || !Number.isFinite(rupees)) {
    throw new MoneyError(`invalid rupee amount: ${String(rupees)}`);
  }
  // Scale through string to dodge binary-fraction drift (e.g. 10.07 * 100 = 1006.9999…).
  const scaled = Math.round(Number((rupees * PAISE_PER_RUPEE).toFixed(4)));
  assertPaise(scaled, 'rupees');
  return scaled;
}

export function paiseToRupeeString(value: Paise): string {
  assertPaise(value);
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const whole = Math.floor(abs / PAISE_PER_RUPEE);
  const frac = abs % PAISE_PER_RUPEE;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

export function formatInr(value: Paise): string {
  const raw = paiseToRupeeString(value);
  const negative = raw.startsWith('-');
  const [whole = '0', frac = '00'] = (negative ? raw.slice(1) : raw).split('.');
  // Indian digit grouping: last three digits, then pairs.
  let grouped: string;
  if (whole.length <= 3) {
    grouped = whole;
  } else {
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3);
    grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  }
  return `${negative ? '-' : ''}₹${grouped}.${frac}`;
}

/** Convert a percentage (e.g. 2.5) to parts-per-million (25_000). */
export function percentToPpm(percent: number): RatePpm {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    throw new MoneyError(`invalid percentage: ${String(percent)}`);
  }
  const ppm = Math.round(Number((percent * 10_000).toFixed(6)));
  if (!Number.isSafeInteger(ppm)) throw new MoneyError('percentage out of range');
  return ppm;
}

export function ppmToPercentString(ppm: RatePpm): string {
  const pct = ppm / 10_000;
  return `${Number(pct.toFixed(6))}%`;
}

/**
 * Apply a ppm rate to an amount, rounding half away from zero (the convention
 * used by Indian tax computation and by every PSP invoice we reconcile
 * against).
 */
export function applyRateHalfUp(amount: Paise, rate: RatePpm): Paise {
  assertPaise(amount);
  if (!Number.isInteger(rate)) throw new MoneyError(`rate must be integer ppm, got ${rate}`);
  const product = amount * rate;
  if (!Number.isSafeInteger(product)) {
    // Fall back to BigInt for very large products; still exact.
    const big = (BigInt(amount) * BigInt(rate));
    const half = BigInt(PPM) / 2n;
    const adjusted = big >= 0n ? big + half : big - half;
    const quotient = adjusted / BigInt(PPM);
    const out = Number(quotient);
    assertPaise(out, 'rate result');
    return out;
  }
  const sign = product < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(product) + PPM / 2) / PPM);
}

/** Sum with overflow / type checking. */
export function sum(...values: Paise[]): Paise {
  let total = 0;
  for (const v of values) {
    assertPaise(v);
    total += v;
  }
  assertPaise(total, 'sum');
  return total;
}

export function subtract(a: Paise, b: Paise): Paise {
  assertPaise(a);
  assertPaise(b);
  const out = a - b;
  assertPaise(out, 'difference');
  return out;
}

export function min(a: Paise, b: Paise): Paise {
  assertPaise(a);
  assertPaise(b);
  return a < b ? a : b;
}

export function max(a: Paise, b: Paise): Paise {
  assertPaise(a);
  assertPaise(b);
  return a > b ? a : b;
}

export function clampNonNegative(value: Paise): Paise {
  assertPaise(value);
  return value < 0 ? 0 : value;
}

/**
 * Split `total` across `weights` so that the parts sum EXACTLY to `total`.
 * Uses the largest-remainder method: floor each share, then hand the leftover
 * paise one at a time to the largest fractional remainders (ties broken by
 * index, so the result is deterministic and reproducible in reconciliation).
 */
export function allocateByWeight(total: Paise, weights: readonly number[]): Paise[] {
  assertPaise(total);
  if (weights.length === 0) throw new MoneyError('cannot allocate across zero weights');
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) throw new MoneyError(`invalid weight ${String(w)}`);
  }
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  if (weightTotal <= 0) throw new MoneyError('weights must sum to a positive value');

  const shares: Paise[] = [];
  const remainders: { index: number; remainder: number }[] = [];
  let allocated = 0;

  for (let i = 0; i < weights.length; i++) {
    const exact = (total * (weights[i] as number)) / weightTotal;
    const floored = Math.trunc(exact);
    shares.push(floored);
    allocated += floored;
    remainders.push({ index: i, remainder: Math.abs(exact - floored) });
  }

  let leftover = total - allocated;
  const direction = leftover >= 0 ? 1 : -1;
  remainders.sort((a, b) => (b.remainder - a.remainder) || (a.index - b.index));

  let cursor = 0;
  while (leftover !== 0) {
    const target = remainders[cursor % remainders.length] as { index: number };
    shares[target.index] = (shares[target.index] as number) + direction;
    leftover -= direction;
    cursor++;
    if (cursor > remainders.length * (Math.abs(total) + 2)) {
      throw new MoneyError('allocation failed to converge');
    }
  }

  const check = shares.reduce((a, b) => a + b, 0);
  if (check !== total) throw new MoneyError(`allocation invariant violated: ${check} != ${total}`);
  return shares;
}

/**
 * Extract a tax component from a tax-INCLUSIVE amount.
 * e.g. gross 1000 paise inclusive of 18% GST -> tax = round(1000 * 18/118).
 */
export function taxFromInclusive(inclusiveAmount: Paise, rate: RatePpm): Paise {
  assertPaise(inclusiveAmount);
  const denominator = PPM + rate;
  if (denominator <= 0) throw new MoneyError('invalid inclusive tax rate');
  const big = BigInt(inclusiveAmount) * BigInt(rate);
  const half = BigInt(denominator) / 2n;
  const adjusted = big >= 0n ? big + half : big - half;
  const out = Number(adjusted / BigInt(denominator));
  assertPaise(out, 'inclusive tax');
  return out;
}
