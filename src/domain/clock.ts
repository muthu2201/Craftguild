/** Time is a dependency, never a global. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(d: Date): void {
    this.current = new Date(d.getTime());
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  advanceDays(days: number): void {
    this.advanceMs(days * 24 * 60 * 60 * 1000);
  }
}

export const IST_OFFSET_MINUTES = 330;

/** Calendar date in Asia/Kolkata (India observes no DST, so a fixed offset is exact). */
export function istDateParts(d: Date): { year: number; month: number; day: number } {
  const shifted = new Date(d.getTime() + IST_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function istDateString(d: Date): string {
  const { year, month, day } = istDateParts(d);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Indian financial year label for an instant, e.g. "2026-27" (Apr 1 - Mar 31). */
export function financialYear(d: Date): string {
  const { year, month } = istDateParts(d);
  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** GST return period label, e.g. "072026" for July 2026 (GSTR-8 convention). */
export function gstPeriod(d: Date): string {
  const { year, month } = istDateParts(d);
  return `${String(month).padStart(2, '0')}${year}`;
}

/** TDS quarter label for Form 26Q, e.g. "Q2-2026-27". */
export function tdsQuarter(d: Date): string {
  const { month } = istDateParts(d);
  const fy = financialYear(d);
  const q =
    month >= 4 && month <= 6 ? 1 : month >= 7 && month <= 9 ? 2 : month >= 10 && month <= 12 ? 3 : 4;
  return `Q${q}-${fy}`;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Statutory GST deposit deadline for a period: the 10th of the following month, IST midnight. */
export function gstr8DueDate(periodEnd: Date): Date {
  const { year, month } = istDateParts(periodEnd);
  const dueYear = month === 12 ? year + 1 : year;
  const dueMonth = month === 12 ? 1 : month + 1;
  return new Date(Date.UTC(dueYear, dueMonth - 1, 10, 0, 0, 0) - IST_OFFSET_MINUTES * 60_000);
}

/** TDS deposit deadline: the 7th of the following month, IST midnight. */
export function tdsDepositDueDate(periodEnd: Date): Date {
  const { year, month } = istDateParts(periodEnd);
  const dueYear = month === 12 ? year + 1 : year;
  const dueMonth = month === 12 ? 1 : month + 1;
  return new Date(Date.UTC(dueYear, dueMonth - 1, 7, 0, 0, 0) - IST_OFFSET_MINUTES * 60_000);
}
