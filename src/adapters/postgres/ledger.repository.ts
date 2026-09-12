import { newId } from '../../domain/ids.js';
import { ACCOUNTS, type AccountName } from '../../domain/ledger/accounts.js';
import type { JournalEntry } from '../../domain/ledger/journal.js';
import type { Paise } from '../../domain/money/money.js';
import type { AccountBalanceRow, LedgerRepository, UnitOfWork } from '../../ports/repository.port.js';
import { isAppError } from '../../domain/errors.js';

/**
 * The only writer to journal_entries / journal_lines.
 *
 * Posting is idempotent on the entry's idempotency key: replaying a webhook or
 * retrying a request re-posts nothing and reports `created: false`.
 */
export class PostgresLedgerRepository implements LedgerRepository {
  async post(uow: UnitOfWork, entry: JournalEntry): Promise<{ entryId: string; created: boolean }> {
    const existing = await uow.query<{ id: string }>(
      'SELECT id FROM journal_entries WHERE idempotency_key = $1',
      [entry.idempotencyKey],
    );
    if (existing.rowCount > 0) {
      return { entryId: existing.rows[0]!.id, created: false };
    }

    const entryId = newId('entry');
    try {
      await uow.query(
        `INSERT INTO journal_entries
           (id, entry_type, occurred_at, reference_type, reference_id, idempotency_key, total_paise, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          entryId,
          entry.entryType,
          entry.occurredAt,
          entry.referenceType,
          entry.referenceId,
          entry.idempotencyKey,
          entry.totalDebit,
          JSON.stringify(entry.metadata),
        ],
      );
    } catch (e) {
      // A concurrent transaction won the race on the same business event.
      if (isAppError(e) && e.code === 'db.unique_violation') {
        const winner = await uow.query<{ id: string }>(
          'SELECT id FROM journal_entries WHERE idempotency_key = $1',
          [entry.idempotencyKey],
        );
        if (winner.rowCount > 0) return { entryId: winner.rows[0]!.id, created: false };
      }
      throw e;
    }

    const values: unknown[] = [];
    const tuples: string[] = [];
    entry.postings.forEach((p, i) => {
      const base = i * 7;
      tuples.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
      values.push(entryId, p.accountCode, p.account, p.direction, p.amount, p.creatorId, entry.occurredAt);
    });

    await uow.query(
      `INSERT INTO journal_lines (entry_id, account_code, account_name, direction, amount_paise, creator_id, occurred_at)
       VALUES ${tuples.join(', ')}`,
      values,
    );

    return { entryId, created: true };
  }

  async trialBalance(uow: UnitOfWork, upTo?: Date): Promise<AccountBalanceRow[]> {
    const res = await uow.query<{
      account_code: string;
      account_name: string;
      debit_paise: number;
      credit_paise: number;
    }>(
      `SELECT account_code,
              MIN(account_name) AS account_name,
              COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'debit'), 0)  AS debit_paise,
              COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'credit'), 0) AS credit_paise
         FROM journal_lines
        WHERE ($1::timestamptz IS NULL OR occurred_at <= $1)
        GROUP BY account_code
        ORDER BY account_code`,
      [upTo ?? null],
    );

    return res.rows.map((r) => ({
      accountCode: r.account_code,
      account: r.account_name as AccountName,
      creatorId: null,
      debitPaise: r.debit_paise,
      creditPaise: r.credit_paise,
      balancePaise: r.debit_paise - r.credit_paise,
    }));
  }

  /** Signed balance in the account's natural direction. */
  async accountBalance(uow: UnitOfWork, account: AccountName, creatorId: string | null = null): Promise<Paise> {
    const def = ACCOUNTS[account];
    const res = await uow.query<{ debit: number; credit: number }>(
      `SELECT COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'debit'), 0)  AS debit,
              COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'credit'), 0) AS credit
         FROM journal_lines
        WHERE account_code = $1
          AND ($2::text IS NULL OR creator_id = $2)`,
      [def.code, creatorId],
    );
    const row = res.rows[0] ?? { debit: 0, credit: 0 };
    const naturalDebit = def.type === 'asset' || def.type === 'expense';
    return naturalDebit ? row.debit - row.credit : row.credit - row.debit;
  }

  async creatorPayable(uow: UnitOfWork, creatorId: string): Promise<Paise> {
    return this.accountBalance(uow, 'CREATOR_PAYABLE', creatorId);
  }

  async reserveBalance(uow: UnitOfWork, creatorId: string): Promise<Paise> {
    return this.accountBalance(uow, 'RESERVE_HOLDBACK', creatorId);
  }

  /** Sum of all creator-scoped balances for an account, for reconciliation. */
  async subledgerTotals(uow: UnitOfWork, account: AccountName): Promise<Map<string, Paise>> {
    const def = ACCOUNTS[account];
    const res = await uow.query<{ creator_id: string; balance: number }>(
      `SELECT creator_id,
              COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'credit'), 0)
                - COALESCE(SUM(amount_paise) FILTER (WHERE direction = 'debit'), 0) AS balance
         FROM journal_lines
        WHERE account_code = $1 AND creator_id IS NOT NULL
        GROUP BY creator_id`,
      [def.code],
    );
    return new Map(res.rows.map((r) => [r.creator_id, r.balance]));
  }
}
