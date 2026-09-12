import { ACCOUNTS, type AccountName, type Direction, accountDef, signedEffect } from './accounts.js';
import { assertPositive, type Paise } from '../money/money.js';
import { err } from '../errors.js';

/**
 * A journal entry is an immutable, self-balancing set of postings. It is the
 * only way value is ever recorded. Nothing in this module touches IO.
 */

export type EntryType =
  | 'credit_topup_captured'
  | 'pg_fee_incurred'
  | 'chapter_redemption'
  | 'tip'
  | 'reserve_held'
  | 'reserve_released'
  | 'refund_to_credits'
  | 'refund_to_source'
  | 'refund_settled'
  | 'chargeback_absorbed'
  | 'chargeback_recovered_from_reserve'
  | 'tcs_withheld'
  | 'tds_withheld'
  | 'payout_instructed'
  | 'payout_settled'
  | 'payout_failed'
  | 'commission_settled_to_bank'
  | 'split_fee_incurred'
  | 'payout_fee_incurred'
  | 'credit_breakage';

export interface PostingInput {
  readonly account: AccountName;
  readonly direction: Direction;
  readonly amount: Paise;
  readonly creatorId?: string | null;
  readonly memo?: string;
}

export interface JournalEntryInput {
  readonly entryType: EntryType;
  readonly occurredAt: Date;
  readonly referenceType: string;
  readonly referenceId: string;
  /** Uniqueness key: replaying the same business event never double-posts. */
  readonly idempotencyKey: string;
  readonly postings: readonly PostingInput[];
  readonly metadata?: Record<string, unknown>;
}

export interface Posting extends PostingInput {
  readonly creatorId: string | null;
  readonly accountCode: string;
  readonly signedAmount: Paise;
}

export interface JournalEntry {
  readonly entryType: EntryType;
  readonly occurredAt: Date;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly idempotencyKey: string;
  readonly postings: readonly Posting[];
  readonly totalDebit: Paise;
  readonly totalCredit: Paise;
  readonly metadata: Record<string, unknown>;
}

/**
 * Build and validate a journal entry.
 *
 * Invariants enforced here (and again by a database constraint):
 *  - at least two postings
 *  - every posting amount is strictly positive (direction carries the sign)
 *  - total debits === total credits
 *  - creator-scoped accounts carry a creator id; non-scoped ones do not
 */
export function buildEntry(input: JournalEntryInput): JournalEntry {
  if (input.postings.length < 2) {
    throw err.validation('ledger.entry_too_small', 'a journal entry needs at least two postings', {
      entryType: input.entryType,
    });
  }

  let totalDebit = 0;
  let totalCredit = 0;
  const postings: Posting[] = [];

  for (const p of input.postings) {
    const def = accountDef(p.account);
    assertPositive(p.amount, `posting amount for ${p.account}`);

    const creatorId = p.creatorId ?? null;
    if (def.creatorScoped && !creatorId) {
      throw err.validation('ledger.missing_creator_scope', `account ${p.account} requires a creatorId`, {
        account: p.account,
      });
    }
    if (!def.creatorScoped && creatorId) {
      throw err.validation('ledger.unexpected_creator_scope', `account ${p.account} is not creator-scoped`, {
        account: p.account,
      });
    }

    if (p.direction === 'debit') totalDebit += p.amount;
    else totalCredit += p.amount;

    postings.push({
      ...p,
      creatorId,
      accountCode: def.code,
      signedAmount: signedEffect(def.type, p.direction) * p.amount,
    });
  }

  if (totalDebit !== totalCredit) {
    throw err.validation('ledger.unbalanced_entry', 'journal entry does not balance', {
      entryType: input.entryType,
      totalDebit,
      totalCredit,
      difference: totalDebit - totalCredit,
    });
  }

  return {
    entryType: input.entryType,
    occurredAt: input.occurredAt,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    idempotencyKey: input.idempotencyKey,
    postings,
    totalDebit,
    totalCredit,
    metadata: input.metadata ?? {},
  };
}

/** Convenience constructors so call sites read like the blueprint's T-accounts. */
export function debit(account: AccountName, amount: Paise, creatorId?: string | null, memo?: string): PostingInput {
  return { account, direction: 'debit', amount, creatorId: creatorId ?? null, memo };
}

export function credit(account: AccountName, amount: Paise, creatorId?: string | null, memo?: string): PostingInput {
  return { account, direction: 'credit', amount, creatorId: creatorId ?? null, memo };
}

/** Drop zero-amount postings before building (tax lines are frequently zero). */
export function compact(postings: (PostingInput | null | undefined)[]): PostingInput[] {
  return postings.filter((p): p is PostingInput => !!p && p.amount > 0);
}

export interface TrialBalanceRow {
  accountCode: string;
  account: AccountName;
  debit: Paise;
  credit: Paise;
  balance: Paise;
}

/** Verify a set of trial-balance rows sums to zero across debits and credits. */
export function assertTrialBalanced(rows: readonly TrialBalanceRow[]): void {
  const totalDebit = rows.reduce((a, r) => a + r.debit, 0);
  const totalCredit = rows.reduce((a, r) => a + r.credit, 0);
  if (totalDebit !== totalCredit) {
    throw err.internal('ledger.trial_balance_broken', 'trial balance does not net to zero', {
      totalDebit,
      totalCredit,
      difference: totalDebit - totalCredit,
    });
  }
}

export const ALL_ENTRY_TYPES: EntryType[] = [
  'credit_topup_captured',
  'pg_fee_incurred',
  'chapter_redemption',
  'tip',
  'reserve_held',
  'reserve_released',
  'refund_to_credits',
  'refund_to_source',
  'refund_settled',
  'chargeback_absorbed',
  'chargeback_recovered_from_reserve',
  'tcs_withheld',
  'tds_withheld',
  'payout_instructed',
  'payout_settled',
  'payout_failed',
  'commission_settled_to_bank',
  'split_fee_incurred',
  'payout_fee_incurred',
  'credit_breakage',
];

export { ACCOUNTS };
