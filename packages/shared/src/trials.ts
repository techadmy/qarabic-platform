import { z } from 'zod';
import { timeZoneSchema } from './countries.js';
import { courseRefSchema, dateOnlySchema, genderSchema, personRefSchema } from './people.js';
import { acknowledgeWarningsSchema, localTimeSchema } from './schedule.js';

/**
 * Trial classes, steps T2–T5 of docs/33 (D136, D137): choosing the teacher (eligibility and
 * ranking), open offers, reminders and the teacher's trial report, and the CRM rates. Teachers
 * never see family names or contact details here: only course, time, the child's age and gender.
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

const queryId = z.coerce.number().int().positive();
const id = z.number().int().positive();
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optionalText = (max: number) =>
  z.preprocess(blankToNull, z.string().trim().max(max).nullable()).optional();
const trialMinutes = z
  .number()
  .int()
  .min(15)
  .max(90)
  .refine((n) => n % 5 === 0, { message: 'Use steps of 5 minutes.' });

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
export const TRIAL_NOTIFICATION_EVENTS = [
  'trial_booked',
  'trial_cancelled',
  'trial_offer',
  'trial_offer_taken',
] as const;
export type TrialNotificationEvent = (typeof TRIAL_NOTIFICATION_EVENTS)[number];
export const TRIAL_NOTIFICATION_LABELS: Labels<TrialNotificationEvent> = {
  trial_booked: { ar: 'حصة تجريبية جديدة', en: 'New trial class' },
  trial_cancelled: { ar: 'أُلغيت حصة تجريبية', en: 'Trial class cancelled' },
  trial_offer: { ar: 'عرض حصة تجريبية', en: 'Trial class offer' },
  trial_offer_taken: { ar: 'تم إسناد الحصة التجريبية', en: 'Trial offer taken' },
};

// ------------------------------------------------------------------ T3 open offers

/**
 * Open offers (docs/33 §4.3): the CSR offers a trial to the eligible teachers (or a shortlist).
 * `first_accept`: the first teacher to accept is booked (atomic). `volunteer`: teachers volunteer
 * and the CSR picks one. An offer closes at `expiresAt` (≤ 6 h before the trial by default).
 */
export const TRIAL_OFFER_STATUSES = ['open', 'claimed', 'expired', 'cancelled'] as const;
export type TrialOfferStatus = (typeof TRIAL_OFFER_STATUSES)[number];
export const TRIAL_OFFER_STATUS_LABELS: Labels<TrialOfferStatus> = {
  open: { ar: 'مفتوح', en: 'Open' },
  claimed: { ar: 'تم الإسناد', en: 'Assigned' },
  expired: { ar: 'انتهت المهلة', en: 'Expired' },
  cancelled: { ar: 'ملغى', en: 'Cancelled' },
};
export const TRIAL_OFFER_POLICIES = ['first_accept', 'volunteer'] as const;
export type TrialOfferPolicy = (typeof TRIAL_OFFER_POLICIES)[number];
export const TRIAL_OFFER_POLICY_LABELS: Labels<TrialOfferPolicy> = {
  first_accept: { ar: 'أول من يقبل', en: 'First to accept' },
  volunteer: { ar: 'تطوّع ثم اختيار', en: 'Volunteers, then pick' },
};
export const TRIAL_OFFER_AUDIENCES = ['eligible', 'shortlist'] as const;
export type TrialOfferAudience = (typeof TRIAL_OFFER_AUDIENCES)[number];
export const TRIAL_OFFER_RESPONSES = ['accept', 'volunteer', 'decline'] as const;
export type TrialOfferResponse = (typeof TRIAL_OFFER_RESPONSES)[number];
export const TRIAL_OFFER_RESPONSE_LABELS: Labels<TrialOfferResponse> = {
  accept: { ar: 'قبل', en: 'Accepted' },
  volunteer: { ar: 'يرغب', en: 'Volunteered' },
  decline: { ar: 'اعتذر', en: 'Declined' },
};

/** `POST /leads/:id/trial-offers`. */
export const createTrialOfferSchema = z
  .object({
    studentId: id,
    courseId: id,
    localDate: dateOnlySchema,
    localTime: localTimeSchema,
    timezone: timeZoneSchema.nullable().optional(),
    durationMinutes: trialMinutes.nullable().optional(),
    policy: z.enum(TRIAL_OFFER_POLICIES).default('first_accept'),
    audience: z.enum(TRIAL_OFFER_AUDIENCES).default('eligible'),
    /** The shortlist (eligible teachers only); required with `audience: shortlist`. */
    teacherIds: z
      .array(id)
      .min(1)
      .max(50)
      .transform((a) => [...new Set(a)])
      .optional(),
    /** Default `crm.trial_offer_expiry_minutes`; always capped ≥ N h before the trial. */
    expiresInMinutes: z.number().int().min(15).max(1440).optional(),
    meetingUrl: z
      .preprocess(
        blankToNull,
        z
          .string()
          .trim()
          .max(500)
          .refine((v) => /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d+)?([/?#][^\s]*)?$/i.test(v), {
            message: 'Use a full https:// link.',
          })
          .nullable(),
      )
      .optional(),
    /** Shown to the teachers: no family names or contacts. */
    note: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.audience === 'shortlist' && !v.teacherIds?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['teacherIds'],
        message: 'Choose the teachers of the shortlist.',
      });
    }
  });
export type CreateTrialOfferInput = z.input<typeof createTrialOfferSchema>;

/** `POST /trial-offers/:id/assign` (volunteer policy, or any open offer): book this teacher. */
export const assignTrialOfferSchema = z.object({
  teacherId: id,
  acknowledgeWarnings: acknowledgeWarningsSchema,
});
export type AssignTrialOfferInput = z.input<typeof assignTrialOfferSchema>;

/** `POST /trial-offers/:id/resend`: open again (expired or open) with a new deadline. */
export const resendTrialOfferSchema = z.object({
  expiresInMinutes: z.number().int().min(15).max(1440).optional(),
});
export type ResendTrialOfferInput = z.input<typeof resendTrialOfferSchema>;

/** `POST /trial-offers/:id/cancel`. */
export const cancelTrialOfferSchema = z.object({ reason: optionalText(500) });

const localMoment = z.object({ date: z.string(), time: z.string() });

/** The CSR's view of an offer. */
export const trialOfferSchema = z.object({
  id: z.number().int(),
  leadId: z.number().int(),
  studentId: z.number().int(),
  course: courseRefSchema,
  startsAt: z.string(),
  durationMinutes: z.number().int(),
  familyZone: z.string(),
  familyLocal: localMoment,
  policy: z.enum(TRIAL_OFFER_POLICIES),
  audience: z.enum(TRIAL_OFFER_AUDIENCES),
  status: z.enum(TRIAL_OFFER_STATUSES),
  expiresAt: z.string(),
  note: z.string().nullable(),
  createdBy: personRefSchema.nullable(),
  claimedTeacher: personRefSchema.nullable(),
  sessionId: z.number().int().nullable(),
  closedAt: z.string().nullable(),
  /** Every teacher it went to: rank when offered (null = shortlist outside the ranking). */
  teachers: z.array(
    z.object({
      teacher: personRefSchema,
      rank: z.number().int().nullable(),
      response: z.enum(TRIAL_OFFER_RESPONSES).nullable(),
      respondedAt: z.string().nullable(),
    }),
  ),
  createdAt: z.string(),
});
export type TrialOfferDto = z.infer<typeof trialOfferSchema>;

/**
 * A teacher's card in «عروض الحصص التجريبية». `state`: `open` (can answer), `mine` (booked for
 * me), `taken` («تم إسناد هذه الحصة»), `closed` (expired or cancelled). Never family details.
 */
export const myTrialOfferSchema = z.object({
  id: z.number().int(),
  course: courseRefSchema,
  startsAt: z.string(),
  durationMinutes: z.number().int(),
  teacherZone: z.string(),
  teacherLocal: localMoment,
  student: z.object({
    age: z.number().int().nullable(),
    gender: genderSchema.nullable(),
    /** Not known before the trial report (T4). */
    level: z.string().nullable(),
  }),
  note: z.string().nullable(),
  policy: z.enum(TRIAL_OFFER_POLICIES),
  state: z.enum(['open', 'mine', 'taken', 'closed']),
  expiresAt: z.string(),
  myResponse: z.enum(TRIAL_OFFER_RESPONSES).nullable(),
  sessionId: z.number().int().nullable(),
});
export type MyTrialOfferDto = z.infer<typeof myTrialOfferSchema>;
