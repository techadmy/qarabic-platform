import { describe, expect, it } from 'vitest';
import {
  availabilityQuerySchema,
  BOARD_COUNTERS,
  BOARD_COUNTER_LABELS,
  createEnrollmentSchema,
  createSessionRequestSchema,
  instantSchema,
  SESSION_STAGE_LABELS,
  SESSION_STAGES,
  sessionListQuerySchema,
  transitionSchema,
  updateSessionSettingsSchema,
} from './index.js';

describe('N2 contract', () => {
  it('normalises instants to UTC Z and refuses ones without an offset', () => {
    expect(instantSchema.parse('2026-11-10T17:00:00+02:00')).toBe('2026-11-10T15:00:00Z');
    expect(instantSchema.safeParse('2026-11-10T17:00:00').success).toBe(false);
  });

  it('needs an https link for an external meeting', () => {
    const base = {
      studentId: 1,
      courseId: 1,
      teacherId: 1,
      kind: 'regular',
      startsOn: '2026-11-09',
      meetingMode: 'external',
    };
    expect(createEnrollmentSchema.safeParse(base).success).toBe(false);
    expect(
      createEnrollmentSchema.safeParse({ ...base, externalMeetingUrl: 'http://x.example.com' })
        .success,
    ).toBe(false);
    const ok = createEnrollmentSchema.parse({
      ...base,
      externalMeetingUrl: 'https://meet.example.com/a',
    });
    expect(ok.slots).toEqual([]);
    expect(ok.acknowledgeWarnings).toEqual([]);
  });

  it('refuses a slot time outside 24 h and a duration off the 5-minute grid', () => {
    const base = {
      studentId: 1,
      courseId: 1,
      teacherId: 1,
      kind: 'regular',
      startsOn: '2026-11-09',
      meetingMode: 'zoom',
    };
    expect(
      createEnrollmentSchema.safeParse({
        ...base,
        slots: [{ weekday: 1, localStartTime: '24:00' }],
      }).success,
    ).toBe(false);
    expect(
      createEnrollmentSchema.safeParse({
        ...base,
        slots: [{ weekday: 8, localStartTime: '10:00' }],
      }).success,
    ).toBe(false);
    expect(createEnrollmentSchema.safeParse({ ...base, sessionMinutes: 33 }).success).toBe(false);
  });

  it('reads list filters from the query string', () => {
    expect(
      sessionListQuerySchema.parse({ stage: 'leave,cancelled', perPage: '300' }),
    ).toMatchObject({
      stage: ['leave', 'cancelled'],
      perPage: 300,
    });
    expect(sessionListQuerySchema.safeParse({ perPage: '501' }).success).toBe(false);
    expect(
      availabilityQuerySchema.parse({
        timezone: 'Europe/London',
        weekdays: '1,3,1',
        fromTime: '17:00',
        toTime: '18:00',
        durationMinutes: '30',
      }).weekdays,
    ).toEqual([1, 3]);
    expect(
      availabilityQuerySchema.safeParse({
        weekdays: '1',
        fromTime: '17:00',
        toTime: '18:00',
        durationMinutes: '30',
      }).success,
    ).toBe(false);
  });

  it('requires the expected stage on a transition and a reason on a request', () => {
    expect(transitionSchema.safeParse({ action: 'activate' }).success).toBe(false);
    expect(transitionSchema.safeParse({ action: 'fly', expectedStage: 'scheduled' }).success).toBe(
      false,
    );
    expect(
      createSessionRequestSchema.safeParse({ type: 'leave', sessionId: 1, reason: ' ' }).success,
    ).toBe(false);
  });

  it('refuses unknown class rules', () => {
    expect(updateSessionSettingsSchema.safeParse({ 'nope.key': 1 }).success).toBe(false);
    expect(updateSessionSettingsSchema.parse({ 'sessions.horizon_days': 21 })).toEqual({
      'sessions.horizon_days': 21,
    });
  });

  it('labels every stage and board counter in Arabic and English', () => {
    for (const s of SESSION_STAGES) expect(SESSION_STAGE_LABELS[s].ar).toBeTruthy();
    for (const c of BOARD_COUNTERS) expect(BOARD_COUNTER_LABELS[c].en).toBeTruthy();
  });
});
