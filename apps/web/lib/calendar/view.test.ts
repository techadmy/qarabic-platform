import { calendarEventsQuerySchema, CALENDAR_MAX_DAYS } from '@qarabic/shared';
import { describe, expect, it } from 'vitest';
import {
  calendarParams,
  calendarState,
  eventsQuery,
  stepDate,
  viewDays,
  viewRange,
  zoneOf,
} from './view';

const TODAY = '2026-11-15';
const from = (q: Record<string, string>) => (k: string) => q[k] ?? null;

describe('calendar URL state (C2)', () => {
  it('reads defaults and ignores what it cannot use', () => {
    const s = calendarState(from({ view: 'year', kind: 'x', teachers: '3,abc,-1,4' }), TODAY);
    expect(s).toMatchObject({ view: 'week', date: TODAY, kind: null, zone: 'academy' });
    expect(s.teacherIds).toEqual([3, 4]);
  });

  it('writes only what differs from the defaults', () => {
    expect(
      calendarParams({ view: 'week', date: TODAY, teacherIds: [], zone: 'academy' }, TODAY),
    ).toEqual({ view: null, date: null, teachers: null, zone: null });
    expect(calendarParams({ view: 'month', teacherIds: [1, 2], stage: 'taken' }, TODAY)).toEqual({
      view: 'month',
      teachers: '1,2',
      stage: 'taken',
    });
  });
});

describe('calendar ranges', () => {
  it('a week starts on Saturday; a month is whole weeks', () => {
    expect(viewDays('week', '2026-11-15')).toEqual({ first: '2026-11-14', last: '2026-11-20' });
    expect(viewDays('month', '2026-11-15')).toEqual({ first: '2026-10-31', last: '2026-12-04' });
    expect(viewDays('day', '2026-11-15')).toEqual({ first: '2026-11-15', last: '2026-11-15' });
  });

  it('the range is half-open in the zone, and every view fits the API limit', () => {
    expect(viewRange('day', '2026-11-15', 'Africa/Cairo')).toEqual({
      from: '2026-11-14T22:00:00Z',
      to: '2026-11-15T22:00:00Z',
    });
    for (const view of ['month', 'week', 'day', 'list'] as const) {
      const q = eventsQuery(calendarState(from({ view }), TODAY), 'America/New_York');
      expect(calendarEventsQuerySchema.safeParse(q).success).toBe(true);
      const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
      expect(days).toBeLessThanOrEqual(CALENDAR_MAX_DAYS);
    }
  });

  it('steps by the view', () => {
    expect(stepDate('week', TODAY, 1)).toBe('2026-11-22');
    expect(stepDate('month', '2026-01-31', -1)).toBe('2025-12-01');
    expect(stepDate('day', TODAY, -1)).toBe('2026-11-14');
  });

  it('the teacher’s zone needs one teacher; otherwise the academy’s', () => {
    const ctx = {
      academy: 'Africa/Cairo',
      mine: 'Europe/London',
      teacherTz: null,
      studentTz: null,
    };
    expect(zoneOf('teacher', ctx)).toBe('Africa/Cairo');
    expect(zoneOf('teacher', { ...ctx, teacherTz: 'Asia/Karachi' })).toBe('Asia/Karachi');
    expect(zoneOf('mine', ctx)).toBe('Europe/London');
  });
});
