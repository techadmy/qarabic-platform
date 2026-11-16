import type { FreeCapacityDto } from '@qarabic/shared';

/**
 * The hiring check (R1, docs/42 §5, D148: «قبل ما أعين معلم جديد»): can the teachers free now take
 * N new students of M minutes a week, on these weekdays within this hour window? Worked out from
 * one week of the free-capacity grid (teachers free for each whole hour, in the grid's zone).
 */
export interface HiringInput {
  /** ISO weekdays 1 = Monday … 7 = Sunday. */
  weekdays: number[];
  /** Hours `fromHour` ≤ h < `toHour` (0–24). */
  fromHour: number;
  toHour: number;
  students: number;
  minutesPerWeek: number;
}

export interface HiringResult {
  /** Teacher-hours a week the new students need. */
  neededHours: number;
  /** Free teacher-hours in the window this week. */
  freeHours: number;
  /** freeHours ≥ neededHours (and there is something to take). */
  enough: boolean;
  /** neededHours − freeHours when short (0 otherwise). */
  shortHours: number;
  /** Share of the free time the new students would use (null when nothing is free). */
  load: number | null;
  /** Hours in the window with no free teacher, per weekday. */
  gaps: { weekday: number; date: string; hours: number[] }[];
  /** The weekdays asked for that the grid's week does not show. */
  missingDays: number[];
}

export function hiringCheck(grid: FreeCapacityDto, input: HiringInput): HiringResult {
  const neededHours = Math.max(0, (input.students * input.minutesPerWeek) / 60);
  const hours = Array.from({ length: 24 }, (_, h) => h).filter(
    (h) => h >= input.fromHour && h < input.toHour,
  );
  const days = grid.days.filter((d) => input.weekdays.includes(d.weekday));
  const freeHours = days.reduce((n, d) => n + hours.reduce((m, h) => m + (d.free[h] ?? 0), 0), 0);
  const gaps = days
    .map((d) => ({ weekday: d.weekday, date: d.date, hours: hours.filter((h) => !d.free[h]) }))
    .filter((g) => g.hours.length > 0);
  const enough = neededHours > 0 && freeHours >= neededHours;
  return {
    neededHours: Math.round(neededHours * 100) / 100,
    freeHours,
    enough,
    shortHours: enough ? 0 : Math.round(Math.max(0, neededHours - freeHours) * 100) / 100,
    load: freeHours > 0 ? Math.round((neededHours / freeHours) * 1000) / 1000 : null,
    gaps,
    missingDays: input.weekdays.filter((w) => !grid.days.some((d) => d.weekday === w)),
  };
}

/** Consecutive hours as ranges: [16,17,18,21] → [[16,19],[21,22]] (end exclusive). */
export function hourRanges(hours: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const h of [...hours].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] === h) last[1] = h + 1;
    else out.push([h, h + 1]);
  }
  return out;
}
