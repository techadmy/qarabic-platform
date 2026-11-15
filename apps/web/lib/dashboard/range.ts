import { DASHBOARD_MAX_DAYS } from '@qarabic/shared';
import { addDays, isDateKey, weekStart } from '@/lib/schedule-time';

/**
 * The dashboard's time range (docs/40 §2.4, D144): presets like Looker Studio / Zoho Analytics, a
 * custom range, and «compare with the previous period». All of it lives in the URL (`range`,
 * `from`, `to`, `compare`) so a view can be shared and bookmarked. Dates are academy days
 * (`YYYY-MM-DD`, inclusive at both ends); the academy's week starts on Saturday.
 */
export const RANGE_PRESETS = [
  'today',
  'this_week',
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
  'last_12_months',
  'custom',
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

/** B122 default (D144): the current month. */
export const DEFAULT_PRESET: Exclude<RangePreset, 'custom'> = 'this_month';

export type Bucket = 'day' | 'week' | 'month';

export interface DashboardRange {
  preset: RangePreset;
  from: string;
  to: string;
  compare: boolean;
  bucket: Bucket;
  /**
   * Why a custom range cannot be asked for (start after end, end after today, longer than the
   * API's limit): the bar says so and nothing is fetched, instead of quietly showing another range.
   */
  invalid: 'order' | 'future' | 'too_long' | null;
}

/** The longest range the API takes (`DASHBOARD_MAX_DAYS` in `@qarabic/shared`). */
export const MAX_RANGE_DAYS = DASHBOARD_MAX_DAYS;

const monthStart = (key: string) => `${key.slice(0, 7)}-01`;
const addMonths = (key: string, n: number) => {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7)) - 1 + n;
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
};
const monthEnd = (key: string) => addDays(addMonths(monthStart(key), 1), -1);
/** Whole days from `a` to `b`, both included. */
export const daysIn = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

/** The span of a preset on `today`. */
export function presetSpan(preset: Exclude<RangePreset, 'custom'>, today: string) {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'this_week':
      return { from: weekStart(today), to: today };
    case 'this_month':
      return { from: monthStart(today), to: today };
    case 'last_month': {
      const start = addMonths(monthStart(today), -1);
      return { from: start, to: monthEnd(start) };
    }
    case 'this_quarter': {
      const m = Number(today.slice(5, 7)) - 1;
      const start = `${today.slice(0, 4)}-${String(m - (m % 3) + 1).padStart(2, '0')}-01`;
      return { from: start, to: today };
    }
    case 'this_year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'last_12_months':
      return { from: addMonths(monthStart(today), -11), to: today };
  }
}

/** Bars per day up to a month, per week up to ~4 months, else per month. */
export function bucketFor(from: string, to: string): Bucket {
  const days = daysIn(from, to);
  return days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
}

/**
 * The range the URL asks for. A preset is resolved on `today`; a custom range keeps the dates
 * asked for even when they cannot be used (`invalid` says why). The period it is compared with
 * comes from the API's answer (`range.previous`), never computed here (one rule, in the API).
 */
export function rangeFromParams(
  get: (key: string) => string,
  today: string,
  /** Another report's limits (R1 utilization: at most 92 days, fewer presets). */
  opts: { presets?: readonly RangePreset[]; maxDays?: number } = {},
): DashboardRange {
  const presets = opts.presets ?? RANGE_PRESETS;
  const maxDays = opts.maxDays ?? MAX_RANGE_DAYS;
  const asked = get('range') as RangePreset;
  const compare = get('compare') === '1';
  let preset: RangePreset = presets.includes(asked) ? asked : DEFAULT_PRESET;
  let span: { from: string; to: string };
  let invalid: DashboardRange['invalid'] = null;
  if (preset === 'custom') {
    const from = get('from');
    const to = get('to');
    if (isDateKey(from) && isDateKey(to)) {
      span = { from, to };
      invalid =
        from > to
          ? 'order'
          : to > today
            ? 'future'
            : daysIn(from, to) > maxDays
              ? 'too_long'
              : null;
    } else {
      preset = DEFAULT_PRESET;
      span = presetSpan(DEFAULT_PRESET, today);
    }
  } else {
    span = presetSpan(preset as Exclude<RangePreset, 'custom'>, today);
  }
  return {
    preset,
    ...span,
    compare,
    bucket: bucketFor(span.from, span.to),
    invalid,
  };
}

/** The URL params for a range (the default month leaves the URL clean). */
export function paramsOf(r: {
  preset: RangePreset;
  from?: string;
  to?: string;
  compare: boolean;
}): Record<string, string | null> {
  return {
    range: r.preset === DEFAULT_PRESET ? null : r.preset,
    from: r.preset === 'custom' ? (r.from ?? null) : null,
    to: r.preset === 'custom' ? (r.to ?? null) : null,
    compare: r.compare ? '1' : null,
  };
}

/** A ratio's change (0–1) in percentage points, one decimal; null when there is nothing before. */
export function changePoints(value: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined) return null;
  return Math.round((value - previous) * 1000) / 10;
}

/** Change from `previous` to `value` in %, one decimal; null when there is nothing to compare. */
export function changePct(value: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  return Math.round(((value - previous) / Math.abs(previous)) * 1000) / 10;
}
