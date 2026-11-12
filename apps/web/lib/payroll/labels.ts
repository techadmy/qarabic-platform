import type { PayslipLineDto, RunStatus } from '@qarabic/shared';
import { minorOf } from '@/lib/billing/money';
import { dateKeyIn } from '@/lib/schedule-time';
import { intlLocale, type UiLocale } from '@/lib/time';

/**
 * Payroll display helpers (docs/21 §8, docs/15 §5.12–§5.13): months, durations, hours and the
 * grouping of payslip lines. Pure functions, unit tested; money stays a decimal string.
 */

/** The academy's zone: a payroll month is a calendar month there (`academy.timezone`). */
export const ACADEMY_TZ = 'Africa/Cairo';

/** `YYYY-MM` of `at` in `tz`. */
export const periodIn = (tz: string, at: Date = new Date()) => dateKeyIn(tz, at).slice(0, 7);

/** `2026-01` → `2025-12`. */
export function previousPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export const isPeriod = (value: string | null | undefined): value is string =>
  !!value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

/**
 * The month a new run is for: the month that just ended (the usual case), or the current month
 * when that one already has a run. Null when both have one.
 */
export function defaultRunPeriod(existing: readonly string[], current: string): string | null {
  const last = previousPeriod(current);
  if (!existing.includes(last)) return last;
  if (!existing.includes(current)) return current;
  return null;
}

/** 135 → "2:15" (hours:minutes, Latin digits, left-to-right when isolated). */
export function durationLabel(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || minutes < 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** `"12.50"` hours → "12.5" (trailing zeros dropped, no float maths). */
export function hoursLabel(hours: string | null | undefined): string {
  if (!hours) return '0';
  const m = /^(-?\d+)(?:\.(\d+))?$/.exec(hours.trim());
  if (!m) return hours;
  const frac = (m[2] ?? '').replace(/0+$/, '');
  return frac ? `${m[1]}.${frac}` : m[1]!;
}

/** "ص 9:05" style clock of an instant in `tz` (viewer's zone first, D30). */
export function clockIn(iso: string | null | undefined, tz: string, locale: UiLocale): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: tz,
    }).format(new Date(iso));
  } catch {
    return '—';
  }
}

/** "1 أكتوبر" of an instant in `tz` (a class in a payslip; the month is the payslip's). */
export function dayMonthIn(iso: string, tz: string, locale: UiLocale): string {
  try {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      day: 'numeric',
      month: 'long',
      timeZone: tz,
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** "الأحد 9 نوفمبر" of a `YYYY-MM-DD` work date (no zone shift). */
export function workDayLabel(key: string, locale: UiLocale): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** "+02:00": the zone's offset on that day, for a local midnight as an instant. */
export function zoneOffset(tz: string, dateKey: string): string {
  try {
    const at = new Date(`${dateKey}T12:00:00Z`);
    const name =
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    return m ? `${m[1]}${m[2]}:${m[3] ?? '00'}` : '+00:00';
  } catch {
    return '+00:00';
  }
}

/** Payslip lines split for display: additions, then deductions (each keeps the API's order). */
export function splitLines(lines: readonly PayslipLineDto[]) {
  return {
    additions: lines.filter((l) => l.sign === 1 && minorOf(l.amount) !== 0),
    deductions: lines.filter((l) => l.sign === -1 && minorOf(l.amount) !== 0),
  };
}

/** Run statuses in their lifecycle order (docs/21 §7) for the stepper. */
export const RUN_STEPS: readonly RunStatus[] = ['draft', 'reviewed', 'approved', 'paid'];

/** Index of the run's step: steps before it are done. */
export const runStep = (status: RunStatus) => RUN_STEPS.indexOf(status);
