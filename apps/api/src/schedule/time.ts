/**
 * Local wall time + IANA zone <-> UTC instants (D38, docs/14 §4.3, §5.3), on the runtime's time
 * zone database (`Intl`), no dependency. Port of the Laravel `App\Support\Time` helpers:
 * `ZonedTime`, `Interval`, `WeeklyPattern`, `Timezones::transitions` and `OffsetProbe`.
 *
 * Instants are epoch milliseconds (UTC). Local dates are `YYYY-MM-DD`, local times `HH:MM`.
 * A non-existent local time (spring-forward gap) moves forward by the gap; an ambiguous one
 * (fall-back) takes the first occurrence (PHP behaviour, kept for parity).
 */

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

// ------------------------------------------------------------------ zone offsets

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

interface WallParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallParts(ms: number, zone: string): WallParts {
  const out: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    y: out.year!,
    m: out.month!,
    d: out.day!,
    h: out.hour! % 24,
    mi: out.minute!,
    s: out.second!,
  };
}

// Transitions happen at a local hh:00 / hh:30, and offsets are multiples of 15 minutes, so every
// transition instant falls on a 15-minute UTC boundary: caching per 15-minute bucket is exact.
const BUCKET = 15 * MINUTE;
const offsetCache = new Map<string, number>();

/** UTC offset of `zone` at the instant, in minutes (e.g. 120 for Cairo in winter). */
export function offsetMinutes(zone: string, ms: number): number {
  const bucket = Math.floor(ms / BUCKET) * BUCKET;
  const key = `${zone}|${bucket}`;
  const hit = offsetCache.get(key);
  if (hit !== undefined) return hit;
  const p = wallParts(bucket, zone);
  const value = Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - bucket) / MINUTE);
  if (offsetCache.size > 200_000) offsetCache.clear();
  offsetCache.set(key, value);
  return value;
}

export function isValidZone(zone: string): boolean {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ dates

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a UTC midnight timestamp. */
function dateOfUtcMs(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** UTC midnight of a `YYYY-MM-DD` (calendar arithmetic only, no zone). */
export function dateMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

export function addDays(date: string, days: number): string {
  return dateOfUtcMs(dateMs(date) + days * DAY);
}

export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return dateOfUtcMs(Date.UTC(y, m - 1 + months, d));
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const wd = new Date(dateMs(date)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function maxDate(...dates: Array<string | null | undefined>): string {
  return dates.filter((d): d is string => !!d).reduce((a, b) => (b > a ? b : a));
}

export function minDate(...dates: Array<string | null | undefined>): string | null {
  const list = dates.filter((d): d is string => !!d);
  return list.length ? list.reduce((a, b) => (b < a ? b : a)) : null;
}

/** `Date` for a Prisma `@db.Date` column. */
export const toDbDate = (date: string): Date => new Date(dateMs(date));

/** `YYYY-MM-DD` of a Prisma `@db.Date` value. */
export const fromDbDate = (value: Date): string => value.toISOString().slice(0, 10);

/** Minutes since midnight of `HH:MM`. */
export function minuteOf(time: string): number {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export function timeOfMinute(minute: number): string {
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
}

// ------------------------------------------------------------------ zoned time

export interface LocalMoment {
  date: string;
  time: string;
  weekday: number;
}

/** The instant seen in `zone`. */
export function local(ms: number, zone: string): LocalMoment {
  const p = wallParts(ms, zone);
  const date = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  return { date, time: `${pad(p.h)}:${pad(p.mi)}`, weekday: isoWeekday(date) };
}

export const localDate = (ms: number, zone: string): string => local(ms, zone).date;

function candidates(
  date: string,
  time: string,
  zone: string,
): { wall: number; valid: number[]; before: number } {
  const [h, mi, s] = time.split(':').map(Number) as [number, number, number?];
  const wall = dateMs(date) + (h * 60 + mi) * MINUTE + (s ?? 0) * 1000;
  const before = offsetMinutes(zone, wall - DAY);
  const after = offsetMinutes(zone, wall + DAY);
  const valid = [...new Set([before, after])]
    .map((o) => wall - o * MINUTE)
    .filter((t) => offsetMinutes(zone, t) === (wall - t) / MINUTE)
    .sort((a, b) => a - b);
  return { wall, valid, before };
}

/** UTC instant of a local date + wall time (`HH:MM[:SS]`) in `zone`. */
export function toUtc(date: string, time: string, zone: string): number {
  const { wall, valid, before } = candidates(date, time, zone);
  // Ambiguous: the first occurrence. Gap: shift forward by the gap (pre-transition offset).
  return valid.length ? valid[0]! : wall - before * MINUTE;
}

/** True when the wall time does not exist or happens twice on that date (DST change). */
export function isDstAdjusted(date: string, time: string, zone: string): boolean {
  return candidates(date, time, zone).valid.length !== 1;
}

/** UTC instant of local midnight (or the first instant of the day when midnight is skipped). */
export const startOfLocalDay = (date: string, zone: string): number => toUtc(date, '00:00', zone);

/**
 * DST transition instants of the zones strictly inside (from, to), sorted (Laravel
 * `Timezones::transitions`). Scans day by day, then narrows each change to the minute.
 */
export function transitions(zones: string[], from: number, to: number): number[] {
  const out = new Set<number>();
  for (const zone of new Set(zones)) {
    let prev = offsetMinutes(zone, from);
    for (let t = from; t < to; t += DAY) {
      const end = Math.min(t + DAY, to);
      const next = offsetMinutes(zone, end);
      if (next !== prev) {
        // Offsets are constant within a bucket: search bucket starts, lo keeps `prev`, hi `next`.
        let lo = Math.floor(t / BUCKET) * BUCKET;
        let hi = Math.floor(end / BUCKET) * BUCKET;
        while (hi - lo > BUCKET) {
          const mid = lo + Math.max(1, Math.floor((hi - lo) / BUCKET / 2)) * BUCKET;
          if (offsetMinutes(zone, mid) === prev) lo = mid;
          else hi = mid;
        }
        if (hi > from && hi < to) out.add(hi);
        prev = next;
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ------------------------------------------------------------------ intervals + weekly patterns

/** Half-open UTC interval [start, end): back-to-back intervals do not overlap. */
export class Interval {
  constructor(
    readonly start: number,
    readonly end: number,
  ) {}

  static of(start: number | Date, minutes: number): Interval {
    const s = typeof start === 'number' ? start : start.getTime();
    return new Interval(s, s + minutes * MINUTE);
  }

  /** Overlap, with an optional gap (minutes) required between the two. */
  overlaps(other: Interval, bufferMinutes = 0): boolean {
    const b = bufferMinutes * MINUTE;
    return this.start < other.end + b && other.start < this.end + b;
  }

  contains(other: Interval): boolean {
    return this.start <= other.start && this.end >= other.end;
  }
}

/**
 * A weekly recurring wall-clock interval (a schedule slot, a recurring block, a work-hours row):
 * ISO weekday + local start time + duration in an IANA zone, valid between two local dates.
 */
export class WeeklyPattern {
  constructor(
    readonly weekday: number,
    readonly localStartTime: string,
    readonly minutes: number,
    readonly zone: string,
    readonly validFrom: string | null = null,
    readonly validTo: string | null = null,
  ) {}

  isValidOn(date: string): boolean {
    return (!this.validFrom || date >= this.validFrom) && (!this.validTo || date <= this.validTo);
  }

  occurrenceOn(date: string): Interval | null {
    if (isoWeekday(date) !== this.weekday || !this.isValidOn(date)) return null;
    return Interval.of(toUtc(date, this.localStartTime, this.zone), this.minutes);
  }

  /** Occurrences whose start lies in [from, to), keyed by local date, in date order. */
  occurrencesBetween(from: number, to: number): Map<string, Interval> {
    const out = new Map<string, Interval>();
    const last = addDays(localDate(to, this.zone), 1);
    for (let day = addDays(localDate(from, this.zone), -1); day <= last; day = addDays(day, 1)) {
      if (isoWeekday(day) !== this.weekday) continue;
      const occ = this.occurrenceOn(day);
      if (occ && occ.start >= from && occ.start < to) out.set(day, occ);
    }
    return out;
  }

  /** First local date on or after `from` (within a week) with an occurrence. */
  firstDateFrom(from: string): string | null {
    for (let i = 0, day = from; i < 7; i++, day = addDays(day, 1)) {
      if (isoWeekday(day) === this.weekday) return this.isValidOn(day) ? day : null;
    }
    return null;
  }
}

// ------------------------------------------------------------------ offset probing

/**
 * Offset-interval probing (docs/14 §5.3). Between two DST transitions of the zones involved, every
 * UTC offset is constant, so the relative position of two weekly patterns repeats each week.
 * Checking the first 9 days after the range start and after every transition (capped at 12
 * months) is therefore exact without materialising a year of dates.
 */
export const OffsetProbe = {
  HORIZON_MONTHS: 12,

  /** Probe windows [from, to) in UTC for a local date range. */
  windows(zones: string[], fromDate: string, toDate: string | null): Array<[number, number]> {
    const startDate = addDays(fromDate, -1);
    const start = dateMs(startDate);
    const cap = dateMs(addMonths(startDate, this.HORIZON_MONTHS));
    const end = Math.min(toDate ? dateMs(toDate) + 2 * DAY : cap, cap);
    if (end <= start) return [];
    const windows: Array<[number, number]> = [[start, Math.min(start + 9 * DAY, end)]];
    for (const t of transitions(zones, start, end)) {
      windows.push([Math.max(t - DAY, start), Math.min(t + 9 * DAY, end)]);
    }
    return windows;
  },

  /** First local date (in A's zone) where an occurrence of A overlaps one of B. */
  firstOverlap(
    a: WeeklyPattern,
    b: WeeklyPattern,
    bufferMinutes = 0,
    notBefore: string | null = null,
  ): string | null {
    const from = maxDate(a.validFrom, b.validFrom, notBefore, '0000-01-01');
    const to = minDate(a.validTo, b.validTo);
    if (to !== null && from > to) return null;
    for (const [wFrom, wTo] of this.windows([a.zone, b.zone], from, to)) {
      const others = [...b.occurrencesBetween(wFrom - 2 * DAY, wTo + 2 * DAY).values()];
      for (const [date, occ] of a.occurrencesBetween(wFrom, wTo)) {
        if (date < from || (to !== null && date > to)) continue;
        if (others.some((o) => occ.overlaps(o, bufferMinutes))) return date;
      }
    }
    return null;
  },

  /** Does a weekly pattern overlap one interval? Returns A's local date. */
  overlapsInterval(a: WeeklyPattern, interval: Interval, bufferMinutes = 0): string | null {
    for (const [date, occ] of a.occurrencesBetween(interval.start - DAY, interval.end + DAY)) {
      if (occ.overlaps(interval, bufferMinutes)) return date;
    }
    return null;
  },

  /** Distinct `"weekday HH:MM"` start times of A seen from another zone over the year. */
  localTimesIn(a: WeeklyPattern, zone: string, fromDate: string): string[] {
    const seen = new Set<string>();
    for (const [wFrom, wTo] of this.windows([a.zone, zone], fromDate, a.validTo)) {
      for (const occ of a.occurrencesBetween(wFrom, wTo).values()) {
        const l = local(occ.start, zone);
        seen.add(`${l.weekday} ${l.time}`);
      }
    }
    return [...seen];
  },
};

/** `2026-11-10T15:00:00Z` (no milliseconds), like Carbon's `toIso8601ZuluString()`. */
export function isoZ(value: Date | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === 'number' ? value : value.getTime();
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
