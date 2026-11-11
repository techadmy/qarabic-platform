import { z } from 'zod';
import { dateOnlySchema } from './people.js';
import { lastPositionSchema } from './progress.js';
import { personZoneRefSchema } from './schedule.js';
import { sessionSchema } from './sessions.js';

/**
 * The teacher portal (N3, D71): `GET /api/v1/teacher-portal/week` and `/teacher-portal/students`,
 * for a signed-in teacher (`sessions.conduct`, role kind `teacher`; anyone else 403). Only the
 * teacher's own classes and students (D138). The teacher's own id is also on `/me` (`teacherId`),
 * for `/teachers/:id/timetable` and `/work-hours`.
 */

/** «أسبوعي»: Saturday → Friday in the teacher's zone; `date` = any day of the week (default today). */
export const teacherWeekQuerySchema = z.object({ date: dateOnlySchema.optional() });
export type TeacherWeekQuery = z.input<typeof teacherWeekQuerySchema>;

export const teacherWeekSummarySchema = z.object({
  /** Every class of the week except moved ones. */
  total: z.number().int(),
  taken: z.number().int(),
  /** Not held yet: scheduled, activated or running. */
  remaining: z.number().int(),
  /** Ended without a report («بلا تقرير»). */
  needsReport: z.number().int(),
  absent: z.number().int(),
  leave: z.number().int(),
});

export const teacherWeekSchema = z.object({
  teacher: personZoneRefSchema,
  /** The zone the week is cut in (the teacher's). */
  timezone: z.string(),
  weekStart: z.string(),
  weekEnd: z.string(),
  today: z.string(),
  previousWeek: z.string(),
  nextWeek: z.string(),
  summary: teacherWeekSummarySchema,
  /** Seven days, Saturday first; classes by start time. */
  days: z.array(z.object({ date: z.string(), sessions: z.array(sessionSchema) })),
});
export type TeacherWeekDto = z.infer<typeof teacherWeekSchema>;

/** One of the teacher's students: no contact or family data (D138). */
export const teacherStudentSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  age: z.number().int().nullable(),
  timezone: z.string(),
  remarkTeacher: z.string().nullable(),
  enrollments: z.array(
    z.object({
      id: z.number().int(),
      status: z.string(),
      course: z.object({ id: z.number().int(), nameAr: z.string(), nameEn: z.string() }),
    }),
  ),
  nextSession: z.object({ id: z.number().int(), startsAt: z.string() }).nullable(),
  lastReport: z.object({ sessionId: z.number().int(), submittedAt: z.string() }).nullable(),
  /** Classes of this student that ended without a report. */
  reportsMissing: z.number().int(),
  lastPositions: z.array(lastPositionSchema),
});
export type TeacherStudentDto = z.infer<typeof teacherStudentSchema>;

export const teacherStudentsSchema = z.array(teacherStudentSchema);

export const TEACHER_PORTAL_LABELS = {
  myDay: { ar: 'يومي', en: 'My day' },
  myWeek: { ar: 'أسبوعي', en: 'My week' },
  myStudents: { ar: 'طلابي', en: 'My students' },
  needsReport: { ar: 'بلا تقرير', en: 'Report missing' },
  nextClass: { ar: 'الحصة التالية', en: 'Next class' },
  lastReport: { ar: 'آخر تقرير', en: 'Last report' },
} as const;
