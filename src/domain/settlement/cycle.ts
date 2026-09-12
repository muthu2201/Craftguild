import { addDays, istDateString } from '../clock.js';
import { err } from '../errors.js';

/**
 * Settlement cycle (blueprint Part 8).
 *
 *   Day 1..30   accrual window - redemptions land in the period
 *   Day 31..35  grace window   - refunds, disputes and reversals still attach
 *   Day 36      finalisation   - withholding computed, reserve released,
 *                                statements issued, payouts dispatched
 */

export const ACCRUAL_DAYS = 30;
export const GRACE_DAYS = 5;

export type PeriodStatus = 'open' | 'grace' | 'finalising' | 'finalised';

export interface SettlementPeriod {
  readonly id: string;
  readonly sequence: number;
  readonly periodStart: Date;
  /** Exclusive: the instant the accrual window closes. */
  readonly periodEnd: Date;
  /** Exclusive: the instant the grace window closes and finalisation may run. */
  readonly graceEnd: Date;
  readonly status: PeriodStatus;
}

export interface PeriodWindow {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly graceEnd: Date;
}

export function periodWindowFrom(start: Date): PeriodWindow {
  const periodEnd = addDays(start, ACCRUAL_DAYS);
  return { periodStart: start, periodEnd, graceEnd: addDays(periodEnd, GRACE_DAYS) };
}

export function statusAt(window: PeriodWindow, now: Date): PeriodStatus {
  if (now < window.periodEnd) return 'open';
  if (now < window.graceEnd) return 'grace';
  return 'finalising';
}

export function isWithinGrace(window: PeriodWindow, now: Date): boolean {
  return now >= window.periodEnd && now < window.graceEnd;
}

export function canFinalise(period: SettlementPeriod, now: Date): boolean {
  return period.status !== 'finalised' && now >= period.graceEnd;
}

export function assertFinalisable(period: SettlementPeriod, now: Date): void {
  if (period.status === 'finalised') {
    throw err.conflict('settlement.already_finalised', 'settlement period is already finalised', {
      periodId: period.id,
    });
  }
  if (now < period.graceEnd) {
    throw err.precondition('settlement.grace_window_open', 'the dispute grace window has not yet closed', {
      periodId: period.id,
      graceEndsAt: period.graceEnd.toISOString(),
      now: now.toISOString(),
    });
  }
}

export function periodLabel(window: PeriodWindow): string {
  return `${istDateString(window.periodStart)}..${istDateString(addDays(window.periodEnd, -1))}`;
}

/**
 * A refund or dispute may only alter a period that is still open or in grace.
 * Once finalised the correction belongs to the current open period instead.
 */
export function attachesToPeriod(period: SettlementPeriod, eventAt: Date): boolean {
  return period.status !== 'finalised' && eventAt < period.graceEnd;
}
