import { z } from 'zod';
import { timeZoneSchema } from './countries.js';
import { dateOnlySchema, genderSchema } from './people.js';
import { conflictResultSchema, localTimeSchema } from './schedule.js';

/**
 * Trial classes, steps T2–T5 of docs/33 (D136, D137): choosing the teacher (eligibility and
 * ranking), open offers, reminders and the teacher's trial report, and the CRM rates. Teachers
 * never see family names or contact details here: only course, time, the child's age and gender.
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

const queryId = z.coerce.number().int().positive();

// ------------------------------------------------------------------ T2 eligibility + ranking

/**
 * Why a teacher is not eligible for a trial (docs/33 §4.1). Every reason but `busy` can be
 * overridden when booking, with a reason (`overrideReason`); `busy` is a schedule clash (409).
 */
export const TRIAL_INELIGIBLE_REASONS = [
  'course',
  'not_accepting',
  'weekly_limit',
  'gender',
  'audience',
  'on_leave',
  'busy',
] as const;
export type TrialIneligibleReason = (typeof TRIAL_INELIGIBLE_REASONS)[number];
export const TRIAL_INELIGIBLE_LABELS: Labels<TrialIneligibleReason> = {
  course: { ar: 'لا يدرّس هذه الدورة', en: 'Does not teach this course' },
  not_accepting: { ar: 'لا يقبل الحصص التجريبية', en: 'Not taking trial classes' },
  weekly_limit: { ar: 'بلغ الحد الأسبوعي للحصص التجريبية', en: 'Weekly trial limit reached' },
  gender: { ar: 'لا يطابق جنس المعلم المطلوب', en: 'Not the requested teacher gender' },
  audience: { ar: 'لا يدرّس هذه الفئة العمرية', en: 'Does not teach this age group' },
  on_leave: { ar: 'في إجازة', en: 'On leave' },
  busy: { ar: 'مشغول في هذا الموعد', en: 'Busy at this time' },
};

/** `GET /leads/:id/trial-teachers`: the teachers for a trial at this time, in the family's zone. */
export const trialTeachersQuerySchema = z.object({
  studentId: queryId,
  courseId: queryId,
  localDate: dateOnlySchema,
  localTime: localTimeSchema,
  /** The zone of `localDate` + `localTime`; the family's zone when omitted. */
  timezone: timeZoneSchema.optional(),
  durationMinutes: z.coerce
    .number()
    .int()
    .min(15)
    .max(90)
    .refine((n) => n % 5 === 0, { message: 'Use steps of 5 minutes.' })
    .optional(),
});
export type TrialTeachersQuery = z.input<typeof trialTeachersQuerySchema>;

export const trialTeacherOptionSchema = z.object({
  teacher: z.object({
    id: z.number().int(),
    name: z.string(),
    gender: genderSchema.nullable(),
    timezone: z.string(),
  }),
  eligible: z.boolean(),
  /** Empty when eligible. */
  reasons: z.array(z.enum(TRIAL_INELIGIBLE_REASONS)),
  /** Ineligible, but bookable with a reason (no `busy`). */
  overridable: z.boolean(),
  /** 1, 2, … among the eligible teachers; null for the others. */
  rank: z.number().int().nullable(),
  /** The trial time in the teacher's zone (D30). */
  teacherLocal: z.object({ date: z.string(), time: z.string() }),
  inWorkHours: z.boolean(),
  /**
   * The booking's own check for this teacher at this exact date and time (one-off classes,
   * blocks and weekly times included): the same hard conflicts (409) and soft warnings
   * (`acknowledgeWarnings`) `POST /leads/:id/trials` applies. Defaults keep older mocks valid.
   */
  check: conflictResultSchema.default({ conflicts: [], warnings: [] }),
  /** The teacher teaches in the student's language; null when the student's language is not set. */
  languageMatch: z.boolean().nullable(),
  /** Trials in the last 90 days and how many became regular; `rate` 0–100, null with no trials. */
  conversion: z.object({
    trials: z.number().int(),
    converted: z.number().int(),
    rate: z.number().int().nullable(),
  }),
  /** Work hours this week minus weekly classes; null when work hours are not set. */
  weeklyFreeHours: z.number().nullable(),
  /** Trials in the teacher's week of the trial, against `maxTrialsPerWeek` (null = no cap). */
  trialsThisWeek: z.number().int(),
  maxTrialsPerWeek: z.number().int().nullable(),
  /** Trials in the last 14 days (fair spread: fewer ranks higher). */
  recentTrials: z.number().int(),
});
export type TrialTeacherOptionDto = z.infer<typeof trialTeacherOptionSchema>;

/**
 * Ranking order (shown, never hidden): inside work hours, language match, fewer recent trials,
 * higher conversion rate, more free hours, then name.
 */
export const trialTeachersResponseSchema = z.object({
  data: z.object({
    eligible: z.array(trialTeacherOptionSchema),
    ineligible: z.array(trialTeacherOptionSchema),
  }),
  meta: z.object({
    startsAt: z.string(),
    durationMinutes: z.number().int(),
    familyZone: z.string(),
    /** The student is an adult for `audience` (age ≥ 16); null when the age is unknown. */
    adult: z.boolean().nullable(),
    teacherGenderPref: z.enum(['male', 'female']).nullable(),
  }),
});
export type TrialTeachersResponse = z.infer<typeof trialTeachersResponseSchema>;

/** Teacher-facing trial notices (kind `trial`): never the family's name or contacts. */
export const TRIAL_NOTIFICATION_EVENTS = ['trial_booked', 'trial_cancelled'] as const;
export type TrialNotificationEvent = (typeof TRIAL_NOTIFICATION_EVENTS)[number];
export const TRIAL_NOTIFICATION_LABELS: Labels<TrialNotificationEvent> = {
  trial_booked: { ar: 'حصة تجريبية جديدة', en: 'New trial class' },
  trial_cancelled: { ar: 'أُلغيت حصة تجريبية', en: 'Trial class cancelled' },
};
