import { afterEach, expect, it, vi } from 'vitest';
import { resetScheduleDb, sdb } from '../schedule-db';
import { resetTeachingDb, tdb } from '../teaching-db';
import { dueAtOf } from '../teaching-present';

/*
| T4 web e2e (`e2e/teaching.spec.ts`, «the trial report closes a trial class») opens the demo
| teacher's «بلا تقرير» list and needs an ended trial class in its first rows, at any hour of any
| weekday. The mock data is built from the clock, so check a week of build times.
*/

afterEach(() => {
  vi.useRealTimers();
  resetScheduleDb();
  resetTeachingDb();
});

it('the demo teacher always has a past-due trial class without a report near the top', () => {
  const misses: string[] = [];
  const start = Date.parse('2026-11-09T00:44:00Z');
  // Every 5 hours over a week: each hour of the day comes up on a different weekday.
  for (let h = 0; h < 24 * 7; h += 5) {
    const now = start + h * 3_600_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    resetScheduleDb();
    resetTeachingDb();
    const missing = sdb.sessions
      .filter(
        (s) =>
          s.teacherId === 1 &&
          !s.deleted &&
          (s.stage === 'ended' || s.stage === 'taken') &&
          !tdb.reports.has(s.id) &&
          now > dueAtOf(s),
      )
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt) || b.id - a.id);
    const at = missing.findIndex((s) => s.kind === 'trial' && s.stage === 'ended');
    if (at < 0 || at >= 12) misses.push(`${new Date(now).toISOString()}: ${at}`);
  }
  expect(misses).toEqual([]);
});
