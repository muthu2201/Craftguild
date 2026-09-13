/**
 * The fee schedule, mirrored from the backend.
 *
 * These are the numbers a creator is shown before they sign up, so they must be
 * the numbers the settlement engine actually applies. `test/unit/fee-parity.test.ts`
 * in the backend asserts this file against `DEFAULT_FEE_SCHEDULE` and fails the
 * build if the two ever drift — a marketing page quoting a stale rate is a
 * promise the ledger would not keep.
 */

export const PPM = 1_000_000;

export const RATES = {
  /** CraftGuild's commission. The only line on this page that is our revenue. */
  platformFeePpm: 100_000, // 10%
  /** Zero on tips: a tip is between a reader and a creator. */
  tipFeePpm: 0,
  /** The payment aggregator's fee, passed through at cost. */
  pgFeePpm: 20_000, // 2%
  /** The aggregator's per-split charge for routing money to a creator's own account. */
  splitFeePpm: 2_500, // 0.25%
  /** GST, charged on each of the service fees above. */
  gstPpm: 180_000, // 18%
  /** Held back through the dispute window, then released. Still the creator's money. */
  reservePpm: 100_000, // 10%
} as const;

export const SETTLEMENT = {
  accrualDays: 30,
  graceDays: 5,
  minimumPayoutPaise: 100_00,
} as const;

/** Half away from zero, in integer space — the same rounding the ledger uses. */
export function applyRate(amountPaise: number, ratePpm: number): number {
  const product = amountPaise * ratePpm;
  const sign = product < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(product) + PPM / 2) / PPM);
}

export interface Split {
  gross: number;
  /** The creator's share, after every deduction below. */
  creator: number;
  /** CraftGuild's commission. */
  platform: number;
  /** The payment aggregator: processing plus the per-split routing charge. */
  network: number;
  /** GST on all three service fees, remitted to the government. */
  government: number;
}

/**
 * Split a gross amount exactly. The four destinations always sum back to the
 * gross — there is no residue, and no line that quietly belongs to nobody.
 */
export function splitGross(grossPaise: number, kind: 'chapter' | 'tip' = 'chapter'): Split {
  const platformFee = applyRate(grossPaise, kind === 'tip' ? RATES.tipFeePpm : RATES.platformFeePpm);
  const pgFee = applyRate(grossPaise, RATES.pgFeePpm);
  const splitFee = applyRate(grossPaise, RATES.splitFeePpm);

  const gstOnPlatform = applyRate(platformFee, RATES.gstPpm);
  const gstOnPg = applyRate(pgFee, RATES.gstPpm);
  const gstOnSplit = applyRate(splitFee, RATES.gstPpm);

  const government = gstOnPlatform + gstOnPg + gstOnSplit;
  const network = pgFee + splitFee;
  const creator = grossPaise - platformFee - network - government;

  return { gross: grossPaise, creator, platform: platformFee, network, government };
}

/** Indian digit grouping: last three digits, then pairs. 10000000 -> 1,00,000.00 */
export function formatInr(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const whole = String(Math.floor(abs / 100));
  const frac = String(abs % 100).padStart(2, '0');

  let grouped: string;
  if (whole.length <= 3) {
    grouped = whole;
  } else {
    const last3 = whole.slice(-3);
    const rest = whole.slice(0, -3);
    grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  }
  return `${negative ? '-' : ''}${grouped}.${frac}`;
}

export function percent(part: number, whole: number): string {
  if (whole === 0) return '0.0';
  return ((part / whole) * 100).toFixed(1);
}

/** The statement line order the settlement engine issues, for the specimen. */
export interface StatementLine {
  label: string;
  amountPaise: number;
  note: string;
  kind: 'gross' | 'deduction' | 'net';
}

export function statementLines(grossPaise: number): StatementLine[] {
  const platformFee = applyRate(grossPaise, RATES.platformFeePpm);
  const pgFee = applyRate(grossPaise, RATES.pgFeePpm);
  const splitFee = applyRate(grossPaise, RATES.splitFeePpm);
  const gstOnPlatform = applyRate(platformFee, RATES.gstPpm);
  const gstOnPg = applyRate(pgFee, RATES.gstPpm);
  const gstOnSplit = applyRate(splitFee, RATES.gstPpm);
  const net = grossPaise - platformFee - pgFee - splitFee - gstOnPlatform - gstOnPg - gstOnSplit;

  return [
    { label: 'Gross earnings', amountPaise: grossPaise, note: 'What readers paid for your work', kind: 'gross' },
    { label: 'Processing fee', amountPaise: -pgFee, note: 'Payment aggregator, 2%, at cost', kind: 'deduction' },
    { label: 'GST on processing fee', amountPaise: -gstOnPg, note: '18%', kind: 'deduction' },
    { label: 'CraftGuild fee', amountPaise: -platformFee, note: '10% — our only line', kind: 'deduction' },
    { label: 'GST on CraftGuild fee', amountPaise: -gstOnPlatform, note: '18%, remitted to government', kind: 'deduction' },
    { label: 'Split routing fee', amountPaise: -splitFee, note: '0.25%, paying into your own account', kind: 'deduction' },
    { label: 'GST on routing fee', amountPaise: -gstOnSplit, note: '18%', kind: 'deduction' },
    { label: 'TCS (CGST s.52)', amountPaise: 0, note: '0.5% — only if you are GST-registered', kind: 'deduction' },
    { label: 'TDS (s.194-O)', amountPaise: 0, note: '0.1% — only above ₹5 lakh a year', kind: 'deduction' },
    { label: 'Net to your bank', amountPaise: net, note: 'Paid by the aggregator, directly to you', kind: 'net' },
  ];
}
