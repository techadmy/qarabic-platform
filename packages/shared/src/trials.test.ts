import { describe, expect, it } from 'vitest';
import { bookTrialSchema } from './crm.js';
import { teacherSchema, updateTeacherSchema } from './people.js';
import { trialReportInputSchema, trialTeachersQuerySchema } from './trials.js';

describe('T2 trial eligibility schemas', () => {
  it('reads the trial-teachers query from the URL', () => {
    const q = trialTeachersQuerySchema.parse({
      studentId: '4',
      courseId: '2',
      localDate: '2026-11-18',
      localTime: '17:00',
      durationMinutes: '45',
    });
    expect(q).toMatchObject({ studentId: 4, courseId: 2, durationMinutes: 45 });
    expect(trialTeachersQuerySchema.safeParse({ studentId: '4' }).success).toBe(false);
  });

  it('booking: a blank override reason is none, a short one is refused', () => {
    const base = {
      studentId: 1,
      courseId: 1,
      teacherId: 1,
      localDate: '2026-11-18',
      localTime: '17:00',
    };
    expect(bookTrialSchema.parse({ ...base, overrideReason: '  ' }).overrideReason).toBeNull();
    expect(bookTrialSchema.safeParse({ ...base, overrideReason: 'ok' }).success).toBe(false);
  });

  it('teacher trial settings: languages deduplicated, older payloads get defaults', () => {
    expect(updateTeacherSchema.parse({ languages: ['urdu', 'urdu'] }).languages).toEqual(['urdu']);
    expect(updateTeacherSchema.safeParse({ maxTrialsPerWeek: 0 }).success).toBe(false);
    const shape = teacherSchema.shape;
    expect(shape.acceptsTrials.parse(undefined)).toBe(true);
    expect(shape.audience.parse(undefined)).toBe('both');
    expect(shape.languages.parse(undefined)).toEqual([]);
  });
});

describe('T4 trial report schema', () => {
  it('needs the level, plan and engagement; minutes in steps of 5', () => {
    const ok = {
      attendance: 'on_time',
      level: 'beginner',
      classesPerWeek: 2,
      minutesPerClass: 30,
      engagement: 'high',
      notes: '  ',
    };
    expect(trialReportInputSchema.parse(ok).notes).toBeNull();
    expect(trialReportInputSchema.safeParse({ ...ok, minutesPerClass: 32 }).success).toBe(false);
    expect(trialReportInputSchema.safeParse({ ...ok, classesPerWeek: 8 }).success).toBe(false);
    expect(trialReportInputSchema.safeParse({ ...ok, level: 'expert' }).success).toBe(false);
  });
});
