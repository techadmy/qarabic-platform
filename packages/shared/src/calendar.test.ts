import { describe, expect, it } from 'vitest';
import {
  CALENDAR_MAX_DAYS,
  calendarBackgroundQuerySchema,
  calendarEventSchema,
  calendarEventsQuerySchema,
} from './calendar.js';
import { boardQuerySchema, sessionListQuerySchema, updateSessionSchema } from './sessions.js';

const FROM = '2026-11-01T00:00:00Z';

describe('calendarEventsQuerySchema', () => {
  it('accepts a range with comma or repeated lists of filters', () => {
    const q = calendarEventsQuerySchema.parse({
      from: FROM,
      to: '2026-12-01T00:00:00Z',
      teacherIds: '3,4',
      studentIds: ['7', '8'],
      familyIds: '2',
      courseIds: '1',
      kinds: 'regular,trial',
      stages: ['scheduled', 'taken'],
      tz: 'Africa/Cairo',
    });
    expect(q).toMatchObject({
      teacherIds: [3, 4],
      studentIds: [7, 8],
      familyIds: [2],
      courseIds: [1],
      kinds: ['regular', 'trial'],
      stages: ['scheduled', 'taken'],
    });
  });

  it('needs an end after the start and at most CALENDAR_MAX_DAYS days', () => {
    expect(calendarEventsQuerySchema.safeParse({ from: FROM, to: FROM }).success).toBe(false);
    const tooLong = new Date(Date.parse(FROM) + (CALENDAR_MAX_DAYS + 1) * 86_400_000);
    expect(
      calendarEventsQuerySchema.safeParse({ from: FROM, to: tooLong.toISOString() }).success,
    ).toBe(false);
    const max = new Date(Date.parse(FROM) + CALENDAR_MAX_DAYS * 86_400_000);
    expect(calendarEventsQuerySchema.safeParse({ from: FROM, to: max.toISOString() }).success).toBe(
      true,
    );
  });

  it('refuses unknown kinds, stages, ids and zones', () => {
    const base = { from: FROM, to: '2026-11-08T00:00:00Z' };
    for (const bad of [
      { kinds: 'lecture' },
      { stages: 'done' },
      { teacherIds: '0' },
      { teacherIds: 'x' },
      { tz: 'Mars/Base' },
    ])
      expect(
        calendarEventsQuerySchema.safeParse({ ...base, ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
  });
});

describe('calendarBackgroundQuerySchema', () => {
  it('has the same range limit; teachers are optional', () => {
    expect(
      calendarBackgroundQuerySchema.parse({ from: FROM, to: '2026-11-08T00:00:00Z' }).teacherIds,
    ).toBeUndefined();
    expect(
      calendarBackgroundQuerySchema.safeParse({ from: FROM, to: '2027-03-01T00:00:00Z' }).success,
    ).toBe(false);
  });
});

describe('calendarEventSchema', () => {
  it('parses a compact event', () => {
    expect(
      calendarEventSchema.parse({
        id: 1,
        startsAt: '2026-11-03T10:00:00.000Z',
        endsAt: '2026-11-03T10:30:00.000Z',
        durationMinutes: 30,
        kind: 'regular',
        stage: 'scheduled',
        attention: [],
        teacher: { id: 2, name: 'T', timezone: 'Africa/Cairo' },
        student: { id: 3, name: 'S', timezone: 'Europe/London', familyId: 4 },
        course: { id: 5, nameAr: 'قرآن', nameEn: 'Quran' },
        enrollmentId: 6,
        slotId: 7,
        isDetached: false,
        lockVersion: 0,
      }).slotId,
    ).toBe(7);
  });
});

describe('session edits and lists (D148)', () => {
  it('PATCH scope defaults to this and accepts following', () => {
    const base = { expectedStage: 'scheduled', startsAt: '2026-11-03T11:00:00Z' };
    expect(updateSessionSchema.parse(base).scope).toBe('this');
    expect(updateSessionSchema.parse({ ...base, scope: 'following' }).scope).toBe('following');
    expect(updateSessionSchema.safeParse({ ...base, scope: 'all' }).success).toBe(false);
  });

  it('the board and the list take course and kind filters', () => {
    expect(boardQuerySchema.parse({ courseIds: '1,2', kinds: 'trial' })).toMatchObject({
      courseIds: [1, 2],
      kinds: ['trial'],
    });
    expect(sessionListQuerySchema.parse({ courseIds: '3' }).courseIds).toEqual([3]);
  });
});
