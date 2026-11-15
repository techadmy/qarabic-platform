import { addDays, isoWeekday, localDate, toUtc } from '../schedule/time.js';

/*
| C1 (docs/42 §3.2): weekly wall-clock rules → concrete UTC intervals inside [from, to). Each rule
| is applied in its own zone, one local day at a time, so a DST change moves the UTC time exactly
| as the teacher's clock does. Intervals are clipped to the range.
*/

export interface Span {
  start: number;
  end: number;
}

const clip = (s: Span, from: number, to: number): Span | null => {
  const start = Math.max(s.start, from);
  const end = Math.min(s.end, to);
  return start < end ? { start, end } : null;
};

/** Every local date in `zone` that can touch [from, to), one day of margin on each side. */
function localDays(from: number, to: number, zone: string): string[] {
  const days: string[] = [];
  const last = addDays(localDate(to, zone), 1);
  for (let d = addDays(localDate(from, zone), -1); d <= last; d = addDays(d, 1)) days.push(d);
  return days;
}

/** A work-hours row: weekday + start/end wall time; an end at or before the start crosses midnight. */
export function expandWorkHours(
  rows: Array<{ weekday: number; localStartTime: string; localEndTime: string; timezone: string }>,
  from: number,
  to: number,
): Span[] {
  const out: Span[] = [];
  for (const r of rows) {
    for (const day of localDays(from, to, r.timezone)) {
      if (isoWeekday(day) !== r.weekday) continue;
      const endDay = r.localEndTime <= r.localStartTime ? addDays(day, 1) : day;
      const span = clip(
        {
          start: toUtc(day, r.localStartTime, r.timezone),
          end:
            r.localEndTime === '24:00'
              ? toUtc(addDays(day, 1), '00:00', r.timezone)
              : toUtc(endDay, r.localEndTime, r.timezone),
        },
        from,
        to,
      );
      if (span) out.push(span);
    }
  }
  return merge(out);
}

/** A recurring block: weekday + start + minutes, valid between two local dates. */
export function expandRecurring(
  rule: {
    weekday: number;
    localStartTime: string;
    durationMinutes: number;
    timezone: string;
    validFrom: string | null;
    validTo: string | null;
  },
  from: number,
  to: number,
): Span[] {
  const out: Span[] = [];
  for (const day of localDays(from, to, rule.timezone)) {
    if (isoWeekday(day) !== rule.weekday) continue;
    if ((rule.validFrom && day < rule.validFrom) || (rule.validTo && day > rule.validTo)) continue;
    const start = toUtc(day, rule.localStartTime, rule.timezone);
    const span = clip({ start, end: start + rule.durationMinutes * 60_000 }, from, to);
    if (span) out.push(span);
  }
  return out;
}

/** Academy-local holiday dates (inclusive) → the UTC span of those whole days. */
export function holidaySpan(
  date: string,
  endsOn: string | null,
  zone: string,
  from: number,
  to: number,
): Span | null {
  return clip(
    { start: toUtc(date, '00:00', zone), end: toUtc(addDays(endsOn ?? date, 1), '00:00', zone) },
    from,
    to,
  );
}

/** Sorted, with touching or overlapping spans joined. */
export function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

export const iso = (ms: number) => new Date(ms).toISOString();

/** `spans` minus `cut` (both any order; the result is merged and sorted). */
export function subtract(spans: Span[], cut: Span[]): Span[] {
  const cuts = merge(cut);
  const out: Span[] = [];
  for (const s of merge(spans)) {
    let start = s.start;
    for (const c of cuts) {
      if (c.end <= start || c.start >= s.end) continue;
      if (c.start > start) out.push({ start, end: c.start });
      start = Math.max(start, c.end);
      if (start >= s.end) break;
    }
    if (start < s.end) out.push({ start, end: s.end });
  }
  return out;
}

/** Total length in hours, two decimals. */
export const hoursOf = (spans: Span[]): number =>
  Math.round((spans.reduce((t, s) => t + (s.end - s.start), 0) / 3_600_000) * 100) / 100;
