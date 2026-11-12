import type { SessionDto } from '@qarabic/shared';

/**
 * Rules of the teacher's home «يومي» (docs/15 §6.2), kept out of the component so they are unit
 * tested on their own.
 */

/** How many days after today «يومي» lists (the next five days, collapsed). */
export const UPCOMING_DAYS = 5;

export const RUNNING_STAGES: ReadonlySet<string> = new Set(['activated', 'in_progress']);

export type Day = { date: string; sessions: SessionDto[] };

/**
 * The class «يومي» puts on top: the one running now, else the next one still ahead (today first,
 * then the coming days). Ended, marked and moved classes never qualify.
 */
export function pickHeroClass(days: Day[], now: Date): SessionDto | null {
  const all = days.flatMap((d) => d.sessions);
  const running = all.find((s) => RUNNING_STAGES.has(s.stage));
  if (running) return running;
  return (
    all
      .filter((s) => s.stage === 'scheduled' && Date.parse(s.endsAt) > now.getTime())
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] ?? null
  );
}

/** The days after `today` (up to `count`), from this week and the next. */
export function upcomingDays(days: Day[], today: string, count = UPCOMING_DAYS): Day[] {
  return days
    .filter((d) => d.date > today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, count);
}
