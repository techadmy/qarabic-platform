import { WEEKDAY_LABELS } from '@qarabic/shared';
import { intlLocale, type UiLocale } from './time';

/**
 * Class and schedule times (D30, D38, docs/15 §5.12): instants are UTC ISO strings shown in a
 * named zone; weekly times are a wall time `HH:MM` in the slot's zone; dates are `YYYY-MM-DD`
 * keys in a zone. Display only, through Intl (Arabic gets ص/م and Latin digits).
 */

/** `YYYY-MM-DD` of `at` in `tz`. */
export function dateKeyIn(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

export function isDateKey(value: string | null | undefined): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** `2026-11-11` + 1 → `2026-11-12` (calendar arithmetic, no zone). */
export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** ISO weekday of a date key: 1 = Monday … 7 = Sunday. */
export function isoWeekday(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  const day = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The Saturday that starts the week of `key` (the academy's week, docs/15 §5.12). */
export function weekStart(key: string): string {
  const wd = isoWeekday(key); // Saturday = 6
  return addDays(key, -((wd + 1) % 7));
}

/** Weekdays in the academy's order: Saturday first. */
export const STAFF_WEEK = [6, 7, 1, 2, 3, 4, 5] as const;

export function weekdayName(weekday: number, locale: UiLocale): string {
  return WEEKDAY_LABELS[weekday]?.[locale] ?? String(weekday);
}

/** "5:00 م" of an instant in `tz`. */
export function clock(iso: string, tz: string, locale: UiLocale): string {
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

/** A wall time `17:30` → "5:30 م". */
export function wallTime(time: string | null | undefined, locale: UiLocale): string {
  if (!time) return '—';
  const [h, m] = time.split(':').map(Number);
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2000, 0, 1, h ?? 0, m ?? 0)));
}

/** `2026-11-11` → "الأربعاء، 11 نوفمبر" (with the year when `year`). */
export function dayLabel(key: string, locale: UiLocale, year = false): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(year ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** "الأربعاء، 11 نوفمبر، 5:00 م" of an instant in `tz`. */
export function dayAndClock(iso: string, tz: string, locale: UiLocale): string {
  return `${dayLabel(dateKeyIn(tz, new Date(iso)), locale)}، ${clock(iso, tz, locale)}`;
}

/** Calendar-day difference of the same instant seen in two zones (+1: `other` is a day ahead). */
export function instantDayShift(iso: string, viewerTz: string, otherTz: string): number {
  const at = new Date(iso);
  const a = dateKeyIn(viewerTz, at);
  const b = dateKeyIn(otherTz, at);
  if (a === b) return 0;
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function offsetMs(tz: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant of a wall time on a date in `tz` → UTC ISO (`…Z`, no milliseconds). */
export function zonedInstant(key: string, time: string, tz: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, h ?? 0, min ?? 0);
  let at = guess - offsetMs(tz, guess);
  at = guess - offsetMs(tz, at);
  return new Date(at).toISOString().replace('.000Z', 'Z');
}

/** `HH:MM` of an instant in `tz` (24 h, for the time inputs). */
export function hhmmIn(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: tz,
  }).format(new Date(iso));
}

/** "منذ 5 دقائق" / "بعد ساعتين" from `now`. */
export function relativeTime(iso: string, now: Date, locale: UiLocale): string {
  const diff = (Date.parse(iso) - now.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 45) return rtf.format(Math.round(diff), 'second');
  if (abs < 45 * 60) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 22 * 3600) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86_400), 'day');
}

/** Minutes between two instants (b − a). */
export function minutesBetween(a: string | Date, b: string | Date): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60_000;
}

/** Wall times every 15 minutes for the time pickers: `00:00` … `23:45`. */
export const QUARTER_TIMES: string[] = Array.from(
  { length: 96 },
  (_, i) =>
    `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`,
);

/** The first date on or after `from` that falls on `weekday`. */
export function nextOnWeekday(from: string, weekday: number): string {
  let key = from;
  for (let i = 0; i < 7 && isoWeekday(key) !== weekday; i++) key = addDays(key, 1);
  return key;
}

/**
 * A weekly time seen from the other party's zone (D38): its next occurrence from `from`, and
 * whether that local time changes during the year (one side has DST, the other not).
 */
export function otherSideOf(
  slot: { weekday: number; localStartTime: string; timezone: string },
  otherTz: string,
  from: string,
): { weekday: number; time: string; variesWithDst: boolean } {
  const at = zonedInstant(nextOnWeekday(from, slot.weekday), slot.localStartTime, slot.timezone);
  const year = Number(from.slice(0, 4));
  const local = (ref: string) =>
    hhmmIn(
      zonedInstant(nextOnWeekday(ref, slot.weekday), slot.localStartTime, slot.timezone),
      otherTz,
    );
  return {
    weekday: isoWeekday(dateKeyIn(otherTz, new Date(at))),
    time: hhmmIn(at, otherTz),
    variesWithDst: local(`${year}-01-10`) !== local(`${year}-07-10`),
  };
}
