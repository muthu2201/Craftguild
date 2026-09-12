import { newId } from '../domain/ids.js';
import { addDays } from '../domain/clock.js';
import type { Clock } from '../domain/clock.js';
import type { Database, SettlementPeriodRecord, UnitOfWork } from '../ports/repository.port.js';
import { LOCK_NS } from '../adapters/postgres/database.js';
import { err } from '../domain/errors.js';
import type { PeriodStatus } from '../domain/settlement/cycle.js';

/**
 * Owns the settlement calendar: exactly one open accrual period at a time,
 * rolled forward automatically so a redemption always has a period to land in.
 */
export class SettlementPeriodService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly accrualDays: number,
    private readonly graceDays: number,
  ) {}

  /**
   * Return the period a transaction occurring now belongs to, creating and
   * rolling periods forward as needed. Serialised on an advisory lock so
   * concurrent first-requests cannot create two open periods (the partial
   * unique index would reject the second anyway; the lock avoids the error).
   */
  async currentPeriod(uow: UnitOfWork): Promise<SettlementPeriodRecord> {
    const now = this.clock.now();
    const open = await this.findOpen(uow);
    if (open && now < open.periodEnd) return open;

    await uow.advisoryLock(LOCK_NS.PERIOD, 'settlement-roll');

    const recheck = await this.findOpen(uow);
    if (recheck && now < recheck.periodEnd) return recheck;

    let cursor = recheck;
    // Roll forward until the open period contains `now`. Contiguous windows
    // mean a quiet platform still produces an unbroken statement history.
    for (let guard = 0; guard < 512; guard++) {
      if (cursor) {
        if (now < cursor.periodEnd) return cursor;
        await uow.query(`UPDATE settlement_periods SET status = 'grace' WHERE id = $1 AND status = 'open'`, [
          cursor.id,
        ]);
      }
      const start = cursor ? cursor.periodEnd : this.alignedStart(now);
      cursor = await this.create(uow, start);
      if (now < cursor.periodEnd) return cursor;
    }
    throw err.internal('settlement.roll_forward_exhausted', 'could not roll the settlement calendar forward');
  }

  private alignedStart(now: Date): Date {
    // Anchor the first period at IST midnight of the current day.
    const istMs = now.getTime() + 330 * 60_000;
    const dayStartIst = Math.floor(istMs / 86_400_000) * 86_400_000;
    return new Date(dayStartIst - 330 * 60_000);
  }

  private async create(uow: UnitOfWork, start: Date): Promise<SettlementPeriodRecord> {
    const periodEnd = addDays(start, this.accrualDays);
    const graceEnd = addDays(periodEnd, this.graceDays);
    const seqRes = await uow.query<{ next: number }>(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM settlement_periods',
    );
    const sequence = seqRes.rows[0]?.next ?? 1;
    const id = newId('period');

    await uow.query(
      `INSERT INTO settlement_periods (id, sequence, period_start, period_end, grace_end, status)
       VALUES ($1, $2, $3, $4, $5, 'open')`,
      [id, sequence, start, periodEnd, graceEnd],
    );

    return { id, sequence, periodStart: start, periodEnd, graceEnd, status: 'open', finalisedAt: null };
  }

  async findOpen(uow: UnitOfWork): Promise<SettlementPeriodRecord | null> {
    const res = await uow.query<PeriodRow>(
      `SELECT * FROM settlement_periods WHERE status = 'open' ORDER BY sequence DESC LIMIT 1`,
    );
    return res.rowCount > 0 ? mapPeriod(res.rows[0]!) : null;
  }

  async byId(uow: UnitOfWork, id: string): Promise<SettlementPeriodRecord | null> {
    const res = await uow.query<PeriodRow>('SELECT * FROM settlement_periods WHERE id = $1', [id]);
    return res.rowCount > 0 ? mapPeriod(res.rows[0]!) : null;
  }

  /** Periods whose grace window has closed and which still need finalising. */
  async findFinalisable(uow: UnitOfWork): Promise<SettlementPeriodRecord[]> {
    const res = await uow.query<PeriodRow>(
      `SELECT * FROM settlement_periods
        WHERE status <> 'finalised' AND grace_end <= $1
        ORDER BY sequence ASC`,
      [this.clock.now()],
    );
    return res.rows.map(mapPeriod);
  }

  /** Advance statuses that have aged out, without finalising anything. */
  async refreshStatuses(): Promise<void> {
    const now = this.clock.now();
    await this.db.transaction(async (uow) => {
      await uow.query(
        `UPDATE settlement_periods SET status = 'grace'
          WHERE status = 'open' AND period_end <= $1`,
        [now],
      );
    });
  }

  async setStatus(uow: UnitOfWork, periodId: string, status: PeriodStatus): Promise<void> {
    await uow.query(
      `UPDATE settlement_periods
          SET status = $2, finalised_at = CASE WHEN $2 = 'finalised' THEN now() ELSE finalised_at END
        WHERE id = $1`,
      [periodId, status],
    );
  }
}

interface PeriodRow {
  id: string;
  sequence: number;
  period_start: Date;
  period_end: Date;
  grace_end: Date;
  status: PeriodStatus;
  finalised_at: Date | null;
}

export function mapPeriod(r: PeriodRow): SettlementPeriodRecord {
  return {
    id: r.id,
    sequence: r.sequence,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    graceEnd: r.grace_end,
    status: r.status,
    finalisedAt: r.finalised_at,
  };
}
