/**
 * Statutory identifier validation: PAN, GSTIN, IFSC, bank account, UPI VPA.
 *
 * These are real format + checksum implementations, not regex theatre. A bad
 * PAN means TDS at 5% instead of 0.1% and a bad GSTIN means a rejected GSTR-8,
 * so we reject them at onboarding rather than at filing time.
 */

/** State codes as published in the GST state-code master. */
export const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};

/**
 * Special-category states get the lower GST registration threshold
 * (Rs 10 lakh for services instead of Rs 20 lakh).
 */
export const SPECIAL_CATEGORY_STATE_CODES = new Set([
  '11', // Sikkim
  '12', // Arunachal Pradesh
  '13', // Nagaland
  '14', // Manipur
  '15', // Mizoram
  '16', // Tripura
  '17', // Meghalaya
  '05', // Uttarakhand
]);

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** The 4th character of a PAN encodes the holder's status. */
export const PAN_ENTITY_TYPES: Record<string, string> = {
  P: 'individual',
  C: 'company',
  H: 'huf',
  F: 'firm',
  A: 'association_of_persons',
  T: 'trust',
  B: 'body_of_individuals',
  L: 'local_authority',
  J: 'artificial_juridical_person',
  G: 'government',
};

export type PanEntityType = (typeof PAN_ENTITY_TYPES)[string];

export interface PanInfo {
  pan: string;
  entityType: PanEntityType;
  /** Section 194-O's reduced-rate exemption is available only to individuals and HUFs. */
  isIndividualOrHuf: boolean;
}

export function parsePan(raw: string): PanInfo | null {
  const pan = String(raw ?? '').trim().toUpperCase();
  if (!PAN_RE.test(pan)) return null;
  const statusChar = pan[3] as string;
  const entityType = PAN_ENTITY_TYPES[statusChar];
  if (!entityType) return null;
  return {
    pan,
    entityType,
    isIndividualOrHuf: entityType === 'individual' || entityType === 'huf',
  };
}

export function isValidPan(raw: string): boolean {
  return parsePan(raw) !== null;
}

const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/;

/**
 * GSTIN check digit: modulus-36 with alternating weights 1 and 2, the classic
 * scheme published by GSTN. Position 0 carries weight 1, and weights alternate.
 */
export function gstinCheckDigit(first14: string): string | null {
  if (first14.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARSET.indexOf(first14[i] as string);
    if (value < 0) return null;
    const factor = i % 2 === 0 ? 1 : 2;
    const product = value * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  const checkValue = (36 - (sum % 36)) % 36;
  return GSTIN_CHARSET[checkValue] as string;
}

export interface GstinInfo {
  gstin: string;
  stateCode: string;
  stateName: string;
  pan: string;
  isSpecialCategoryState: boolean;
}

export function parseGstin(raw: string): GstinInfo | null {
  const gstin = String(raw ?? '').trim().toUpperCase();
  if (gstin.length !== 15 || !GSTIN_RE.test(gstin)) return null;

  const stateCode = gstin.slice(0, 2);
  const stateName = GST_STATE_CODES[stateCode];
  if (!stateName) return null;

  const pan = gstin.slice(2, 12);
  if (!isValidPan(pan)) return null;

  const expected = gstinCheckDigit(gstin.slice(0, 14));
  if (!expected || expected !== gstin[14]) return null;

  return {
    gstin,
    stateCode,
    stateName,
    pan,
    isSpecialCategoryState: SPECIAL_CATEGORY_STATE_CODES.has(stateCode),
  };
}

export function isValidGstin(raw: string): boolean {
  return parseGstin(raw) !== null;
}

/** A GSTIN must be issued against the holder's own PAN. */
export function gstinMatchesPan(gstin: string, pan: string): boolean {
  const g = parseGstin(gstin);
  const p = parsePan(pan);
  return !!g && !!p && g.pan === p.pan;
}

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function isValidIfsc(raw: string): boolean {
  return IFSC_RE.test(String(raw ?? '').trim().toUpperCase());
}

const ACCOUNT_RE = /^[0-9]{6,18}$/;

export function isValidBankAccount(raw: string): boolean {
  return ACCOUNT_RE.test(String(raw ?? '').trim());
}

const VPA_RE = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/;

export function isValidUpiVpa(raw: string): boolean {
  return VPA_RE.test(String(raw ?? '').trim());
}

const PHONE_RE = /^[6-9][0-9]{9}$/;

export function isValidIndianMobile(raw: string): boolean {
  return PHONE_RE.test(String(raw ?? '').trim().replace(/^\+?91/, ''));
}

export function normalizeIndianMobile(raw: string): string | null {
  const digits = String(raw ?? '').replace(/[^0-9]/g, '');
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  return PHONE_RE.test(local) ? local : null;
}
