import type { FreeCapacityDto } from '@qarabic/shared';
import { describe, expect, it } from 'vitest';
import { hiringCheck, hourRanges } from './hiring';

const grid = (free: (weekday: number, h: number) => number): FreeCapacityDto => ({
  range: { from: '2026-11-14', to: '2026-11-20', timezone: 'Africa/Cairo' },
  teacherCount: 5,
  days: [6, 7, 1, 2, 3, 4, 5].map((weekday, i) => ({
    date: `2026-11-${14 + i}`,
    weekday,
    free: Array.from({ length: 24 }, (_, h) => free(weekday, h)),
  })),
});

describe('hiring check (R1)', () => {
  it('compares the hours the new students need with the free teacher-hours in the window', () => {
    // 2 teachers free 16:00–20:00 on Saturday and Monday: 2 × 4 × 2 = 16 free hours.
    const g = grid((w, h) => ([6, 1].includes(w) && h >= 16 && h < 20 ? 2 : 0));
    const ok = hiringCheck(g, {
      weekdays: [6, 1],
      fromHour: 16,
      toHour: 20,
      students: 10,
      minutesPerWeek: 60,
    });
    expect(ok).toMatchObject({ neededHours: 10, freeHours: 16, enough: true, shortHours: 0 });
    expect(ok.gaps).toEqual([]);
    const short = hiringCheck(g, {
      weekdays: [6, 1, 2],
      fromHour: 14,
      toHour: 20,
      students: 20,
      minutesPerWeek: 60,
    });
    expect(short).toMatchObject({ neededHours: 20, freeHours: 16, enough: false, shortHours: 4 });
    // The gaps: 14–16 on Saturday and Monday, the whole window on Tuesday.
    expect(short.gaps.map((x) => [x.weekday, hourRanges(x.hours)])).toEqual([
      [6, [[14, 16]]],
      [1, [[14, 16]]],
      [2, [[14, 20]]],
    ]);
  });

  it('no free time: no load, and nothing needed is never «enough»', () => {
    const g = grid(() => 0);
    expect(
      hiringCheck(g, { weekdays: [6], fromHour: 0, toHour: 24, students: 1, minutesPerWeek: 30 }),
    ).toMatchObject({ load: null, enough: false });
    expect(
      hiringCheck(g, { weekdays: [6], fromHour: 0, toHour: 24, students: 0, minutesPerWeek: 30 })
        .enough,
    ).toBe(false);
  });
});
