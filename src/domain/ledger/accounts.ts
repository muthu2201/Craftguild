/**
 * Chart of accounts (blueprint Part 13).
 *
 * The platform never takes custody of reader money: gross funds sit in the
 * payment aggregator's escrow. `PA_ESCROW_RECEIVABLE` therefore models our
 * *claim* on the PA's escrow, not a platform bank balance. Creator money is a
 * liability from the instant a redemption is recorded.
 */

export type AccountType = 'asset' | 'liability' | 'income' | 'expense' | 'equity';
export type Direction = 'debit' | 'credit';

export interface AccountDef {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  /** Balances are tracked per creator for accounts that are creator-scoped. */
  readonly creatorScoped: boolean;
  readonly description: string;
}

export const ACCOUNTS = {
  READER_PAYMENT_CLEARING: {
    code: '1000',
    name: 'Reader Payment Clearing',
    type: 'asset',
    creatorScoped: false,
    description: 'Memo/contra account for reader payments in flight before capture confirmation.',
  },
  PA_ESCROW_RECEIVABLE: {
    code: '1100',
    name: 'PA Escrow Receivable',
    type: 'asset',
    creatorScoped: false,
    description: "Funds held in the payment aggregator's escrow account with a scheduled commercial bank.",
  },
  PLATFORM_BANK: {
    code: '1200',
    name: 'Platform Settlement Bank Account',
    type: 'asset',
    creatorScoped: false,
    description: 'Platform current account receiving only settled commission.',
  },
  CREDIT_LIABILITY: {
    code: '2000',
    name: 'Credit Liability (Unearned)',
    type: 'liability',
    creatorScoped: false,
    description: 'Closed-loop coins sold and not yet redeemed. No GST at sale (CBIC Circular 243/37/2024).',
  },
  CREATOR_PAYABLE: {
    code: '2100',
    name: 'Creator Payable',
    type: 'liability',
    creatorScoped: true,
    description: "Creator's earned share, net of fees, awaiting settlement.",
  },
  RESERVE_HOLDBACK: {
    code: '2200',
    name: 'Reserve / Holdback',
    type: 'liability',
    creatorScoped: true,
    description: "Creator's own money retained inside the split during the dispute grace window.",
  },
  GST_OUTPUT_PAYABLE: {
    code: '2300',
    name: 'GST Output Payable (Commission)',
    type: 'liability',
    creatorScoped: false,
    description: 'GST at 18% on the platform commission, which is the platform’s own outward supply.',
  },
  GST_ON_REDEMPTION_PAYABLE: {
    code: '2310',
    name: 'GST on Redemption Payable',
    type: 'liability',
    creatorScoped: false,
    description:
      'GST on the underlying content supply, used only where the platform is liable under a Section 9(5) notification.',
  },
  TCS_PAYABLE: {
    code: '2400',
    name: 'TCS Payable (CGST s.52)',
    type: 'liability',
    creatorScoped: false,
    description: 'TCS at 0.5% collected from registered creators, deposited with GSTR-8.',
  },
  TDS_PAYABLE: {
    code: '2500',
    name: 'TDS Payable (IT s.194-O)',
    type: 'liability',
    creatorScoped: false,
    description: 'TDS at 0.1% (5% without PAN) on gross creator earnings.',
  },
  REFUND_LIABILITY: {
    code: '2600',
    name: 'Refund Liability',
    type: 'liability',
    creatorScoped: false,
    description: 'Refunds approved and owed back to the original payment instrument.',
  },
  PAYOUT_CLEARING: {
    code: '2700',
    name: 'Payout Clearing',
    type: 'liability',
    creatorScoped: true,
    description: 'Payout instructed to the PA and not yet confirmed settled to the creator.',
  },
  PLATFORM_FEE_REVENUE: {
    code: '4000',
    name: 'Platform Fee Revenue',
    type: 'income',
    creatorScoped: false,
    description: 'The platform commission. This, not GMV, is the platform’s aggregate turnover.',
  },
  BREAKAGE_REVENUE: {
    code: '4100',
    name: 'Breakage Revenue',
    type: 'income',
    creatorScoped: false,
    description: 'Expired unredeemed credits. Not a supply per CBIC Circular 243/37/2024.',
  },
  PG_FEE_EXPENSE: {
    code: '5000',
    name: 'Payment Gateway Fee Expense',
    type: 'expense',
    creatorScoped: false,
    description: 'PA platform/technology fee incurred at capture; recovered from creators as a pass-through.',
  },
  SPLIT_FEE_EXPENSE: {
    code: '5100',
    name: 'Split Settlement Fee Expense',
    type: 'expense',
    creatorScoped: false,
    description: 'Per-split fee charged by the PA on each vendor leg.',
  },
  CHARGEBACK_EXPENSE: {
    code: '5200',
    name: 'Chargeback Expense',
    type: 'expense',
    creatorScoped: false,
    description: 'Unrecovered chargebacks landing after the creator share was settled out.',
  },
  PAYOUT_FEE_EXPENSE: {
    code: '5300',
    name: 'Payout Fee Expense',
    type: 'expense',
    creatorScoped: false,
    description: 'Per-payout IMPS/UPI charge, amortised across a monthly batch.',
  },
  PROMOTIONAL_CREDIT_EXPENSE: {
    code: '5400',
    name: 'Promotional Credit Expense',
    type: 'expense',
    creatorScoped: false,
    description:
      'Bonus coins granted above the cash received. The creator is still paid full face value when a bonus coin is ' +
      'redeemed, so the bonus is a real liability funded by marketing spend, never a discount on the creator’s share.',
  },
} as const satisfies Record<string, AccountDef>;

export type AccountName = keyof typeof ACCOUNTS;
export const ACCOUNT_NAMES = Object.keys(ACCOUNTS) as AccountName[];

export const ACCOUNT_BY_CODE: ReadonlyMap<string, AccountDef & { key: AccountName }> = new Map(
  ACCOUNT_NAMES.map((key) => [ACCOUNTS[key].code, { ...ACCOUNTS[key], key }]),
);

/** The side on which an account type increases. */
export function normalBalance(type: AccountType): Direction {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

/** Signed effect of a posting on the account's own balance. */
export function signedEffect(type: AccountType, direction: Direction): 1 | -1 {
  return direction === normalBalance(type) ? 1 : -1;
}

export function accountDef(name: AccountName): AccountDef {
  return ACCOUNTS[name];
}
