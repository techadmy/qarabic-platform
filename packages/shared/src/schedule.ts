import { z } from 'zod';
import { timeZoneSchema } from './countries.js';
import { courseRefSchema, dateOnlySchema, listQueryBaseSchema, paginatedSchema } from './people.js';

/**
 * Schedule (N2): enrollments, weekly slots, holidays, teacher blocks and work hours, availability
 * and conflict checks — the contract of `/api/v1/{enrollments,schedule-slots,schedule,holidays,
 * teachers/:id/{timetable,blocks,work-hours}}`. Ported from the Laravel M2 scheduling module
 * (docs/14 §2, §5, §8). Instants are ISO 8601 UTC strings (`2026-11-10T15:00:00Z`); weekly times
 * are a local wall time `HH:MM` in a named IANA zone (D38), so DST never moves a class by accident.
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

const id = z.number().int().positive();
const queryId = z.coerce.number().int().positive().max(2_147_483_647);

// ------------------------------------------------------------------ time fields

/** ISO weekday: 1 = Monday … 7 = Sunday (Laravel `isoWeekday`). */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const WEEKDAY_LABELS: Record<number, { ar: string; en: string }> = {
  1: { ar: 'الإثنين', en: 'Monday' },
  2: { ar: 'الثلاثاء', en: 'Tuesday' },
  3: { ar: 'الأربعاء', en: 'Wednesday' },
  4: { ar: 'الخميس', en: 'Thursday' },
  5: { ar: 'الجمعة', en: 'Friday' },
  6: { ar: 'السبت', en: 'Saturday' },
  7: { ar: 'الأحد', en: 'Sunday' },
};
export const weekdaySchema = z.number().int().min(1).max(7);

/** Local wall time `HH:MM` (24 h). */
export const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Use the 24-hour format HH:MM.' });

/** Class length: 15–180 minutes, in steps of 5 (Laravel `SlotRules`). */
export const durationMinutesSchema = z
  .number()
  .int()
  .min(15)
  .max(180)
  .refine((v) => v % 5 === 0, { message: 'Use a multiple of 5 minutes.' });

/** An instant with an explicit offset (`Z` or `+02:00`); normalised to UTC `…Z`. */
export const instantSchema = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v).toISOString().replace('.000Z', 'Z'));

/** Soft warnings the user accepts by code, e.g. `['dst_shift', 'outside_work_hours']`. */
export const acknowledgeWarningsSchema = z.array(z.string().max(40)).max(20).default([]);

// ------------------------------------------------------------------ enums + labels

export const ENROLLMENT_STATUSES = ['active', 'paused', 'ended'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];
export const ENROLLMENT_STATUS_LABELS: Labels<EnrollmentStatus> = {
  active: { ar: 'نشط', en: 'Active' },
  paused: { ar: 'موقوف مؤقتًا', en: 'Paused' },
  ended: { ar: 'منتهٍ', en: 'Ended' },
};

export const ENROLLMENT_KINDS = ['regular', 'trial'] as const;
export type EnrollmentKind = (typeof ENROLLMENT_KINDS)[number];
export const ENROLLMENT_KIND_LABELS: Labels<EnrollmentKind> = {
  regular: { ar: 'منتظم', en: 'Regular' },
  trial: { ar: 'تجريبي', en: 'Trial' },
};

export const MEETING_MODES = ['zoom', 'external'] as const;
export type MeetingMode = (typeof MEETING_MODES)[number];
export const MEETING_MODE_LABELS: Labels<MeetingMode> = {
  zoom: { ar: 'زووم (من الأكاديمية)', en: 'Zoom (academy)' },
  external: { ar: 'رابط خارجي ثابت', en: 'Fixed external link' },
};

/** Why an enrollment is paused (Laravel `EnrollmentController::pause`). */
export const PAUSE_REASONS = ['family_suspended', 'family_on_leave', 'admin'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];
export const PAUSE_REASON_LABELS: Labels<PauseReason> = {
  family_suspended: { ar: 'العائلة معلّقة', en: 'Family suspended' },
  family_on_leave: { ar: 'العائلة في إجازة', en: 'Family on leave' },
  admin: { ar: 'قرار إداري', en: 'Admin decision' },
};

export const TEACHER_BLOCK_KINDS = ['recurring', 'one_off'] as const;
export type TeacherBlockKind = (typeof TEACHER_BLOCK_KINDS)[number];
export const TEACHER_BLOCK_KIND_LABELS: Labels<TeacherBlockKind> = {
  recurring: { ar: 'أسبوعي', en: 'Weekly' },
  one_off: { ar: 'مرة واحدة', en: 'One-off' },
};
export const TEACHER_BLOCK_REASONS = [
  'break',
  'other_job',
  'leave',
  'admin_hold',
  'other',
] as const;
export type TeacherBlockReason = (typeof TEACHER_BLOCK_REASONS)[number];
export const TEACHER_BLOCK_REASON_LABELS: Labels<TeacherBlockReason> = {
  break: { ar: 'استراحة', en: 'Break' },
  other_job: { ar: 'عمل آخر', en: 'Other job' },
  leave: { ar: 'إجازة', en: 'Leave' },
  admin_hold: { ar: 'حجز إداري', en: 'Admin hold' },
  other: { ar: 'أخرى', en: 'Other' },
};

/** Hard conflicts (409, no override) and soft warnings (must be acknowledged), docs/14 §5. */
export const CONFLICT_CODES = [
  'teacher_overlap',
  'student_overlap',
  'teacher_blocked',
  'teacher_inactive',
  'enrollment_inactive',
  'outside_work_hours',
  'holiday',
  'sibling_overlap',
  'dst_shift',
  'teacher_daily_load',
  'past_time',
  'package_mismatch',
] as const;
export type ConflictCode = (typeof CONFLICT_CODES)[number];
export const CONFLICT_LABELS: Labels<ConflictCode> = {
  teacher_overlap: { ar: 'تعارض مع حصة أخرى للمعلم', en: 'Overlaps another class of the teacher' },
  student_overlap: { ar: 'تعارض مع حصة أخرى للطالب', en: 'Overlaps another class of the student' },
  teacher_blocked: { ar: 'وقت محجوز لدى المعلم', en: 'The teacher blocked this time' },
  teacher_inactive: { ar: 'المعلم غير نشط', en: 'The teacher is inactive' },
  enrollment_inactive: { ar: 'الاشتراك غير نشط', en: 'The enrollment is not active' },
  outside_work_hours: { ar: 'خارج ساعات عمل المعلم', en: 'Outside the teacher’s work hours' },
  holiday: { ar: 'يوافق عطلة رسمية', en: 'On a public holiday' },
  sibling_overlap: { ar: 'تعارض مع حصة لأحد الإخوة', en: 'Overlaps a sibling’s class' },
  dst_shift: {
    ar: 'يتغيّر توقيت المعلم مع التوقيت الصيفي',
    en: 'The teacher’s local time changes with DST',
  },
  teacher_daily_load: {
    ar: 'يتجاوز الحد اليومي للمعلم (8 ساعات)',
    en: 'Over the teacher’s daily load (8 hours)',
  },
  past_time: { ar: 'الموعد في الماضي', en: 'The time is in the past' },
  package_mismatch: {
    ar: 'عدد المواعيد لا يطابق الباقة',
    en: 'Weekly times differ from the package',
  },
};

// ------------------------------------------------------------------ shared response blocks

export const personZoneRefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  timezone: z.string(),
});
export const studentZoneRefSchema = personZoneRefSchema.extend({ familyId: z.number().int() });

/** A hard conflict or a soft warning (docs/14 §8.1 Conflict). */
export const conflictSchema = z.object({
  code: z.string(),
  severity: z.enum(['hard', 'soft']),
  message: z.string(),
  with: z
    .object({
      type: z.enum(['session', 'slot', 'block', 'teacher', 'enrollment', 'holiday']),
      id: z.number().int().nullable(),
      startsAt: z.string().nullable().optional(),
      label: z.string().nullable().optional(),
    })
    .nullable(),
  /** First local date (slot zone) where it happens, for recurring checks. */
  firstDate: z.string().nullable(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type ConflictDto = z.infer<typeof conflictSchema>;

export const conflictResultSchema = z.object({
  conflicts: z.array(conflictSchema),
  warnings: z.array(conflictSchema),
});
export type ConflictResultDto = z.infer<typeof conflictResultSchema>;

/**
 * Error bodies of the scheduling writes: `409 schedule_conflict` with `data.conflicts` +
 * `data.warnings`, then `422 warnings_not_acknowledged` with `data.warnings` until every soft
 * warning code is sent back in `acknowledgeWarnings`. (Laravel put them in `errors`; here
 * `errors` stays "field → messages" for every error, so the lists travel in `data`.)
 */
export const SCHEDULE_ERROR_CODES = ['schedule_conflict', 'warnings_not_acknowledged'] as const;

// ------------------------------------------------------------------ slots

/**
 * A weekly slot. `teacherLocal` is its next occurrence seen in the teacher's zone;
 * `variesWithDst` when that local time changes during the year (e.g. London vs Cairo).
 */
export const scheduleSlotSchema = z.object({
  id: z.number().int(),
  enrollmentId: z.number().int(),
  teacherId: z.number().int(),
  weekday: z.number().int(),
  localStartTime: z.string(),
  durationMinutes: z.number().int(),
  timezone: z.string(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  teacherLocal: z.object({
    timezone: z.string(),
    weekday: z.number().int().nullable(),
    time: z.string().nullable(),
    variesWithDst: z.boolean(),
  }),
  /** "Student — Course", on the timetable only. */
  label: z.string().optional(),
});
export type ScheduleSlotDto = z.infer<typeof scheduleSlotSchema>;

export const slotInputSchema = z.object({
  weekday: weekdaySchema,
  localStartTime: localTimeSchema,
  /** Defaults to the enrollment's `sessionMinutes`. */
  durationMinutes: durationMinutesSchema.optional(),
});
export type SlotInput = z.input<typeof slotInputSchema>;

/** `POST /enrollments/:id/slots` */
export const addSlotSchema = slotInputSchema.extend({
  /** Defaults to the later of the enrollment start and today (enrollment zone). */
  validFrom: dateOnlySchema.optional(),
  acknowledgeWarnings: acknowledgeWarningsSchema,
});
export type AddSlotInput = z.input<typeof addSlotSchema>;

/** `PATCH /schedule-slots/:id`: closes the slot the day before `effectiveFrom` and opens a new version. */
export const updateSlotSchema = z.object({
  weekday: weekdaySchema.optional(),
  localStartTime: localTimeSchema.optional(),
  durationMinutes: durationMinutesSchema.optional(),
  effectiveFrom: dateOnlySchema,
  acknowledgeWarnings: acknowledgeWarningsSchema,
});
export type UpdateSlotInput = z.input<typeof updateSlotSchema>;

/** `POST /schedule-slots/:id/end` */
export const endSlotSchema = z.object({ validTo: dateOnlySchema });
export type EndSlotInput = z.input<typeof endSlotSchema>;

// ------------------------------------------------------------------ enrollments

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d+)?([/?#][^\s]*)?$/i.test(v), {
    message: 'Use a full https:// link.',
  });

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** `POST /enrollments`. A Zoom enrollment is refused (422 `meetingMode`) while Zoom is not configured. */
export const createEnrollmentSchema = z
  .object({
    studentId: id,
    courseId: id,
    teacherId: id,
    kind: z.enum(ENROLLMENT_KINDS),
    startsOn: dateOnlySchema,
    sessionMinutes: durationMinutesSchema.optional(),
    /** Defaults to the family's zone. */
    timezone: timeZoneSchema.optional(),
    meetingMode: z.enum(MEETING_MODES),
    externalMeetingUrl: z.preprocess(blankToNull, httpsUrl.nullable()).optional(),
    notes: z.preprocess(blankToNull, z.string().trim().max(2000).nullable()).optional(),
    slots: z.array(slotInputSchema).max(14).default([]),
    acknowledgeWarnings: acknowledgeWarningsSchema,
  })
  .superRefine((v, ctx) => {
    if (v.meetingMode === 'external' && !v.externalMeetingUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['externalMeetingUrl'],
        message: 'The meeting link is required for an external meeting.',
      });
    }
  });
export type CreateEnrollmentInput = z.input<typeof createEnrollmentSchema>;

/**
 * `PATCH /enrollments/:id`. A new `teacherId` versions every live slot from `effectiveFrom`
 * (default today); the response lists `affectedManualSessions` the generator will not move.
 */
export const updateEnrollmentSchema = z
  .object({
    teacherId: id.optional(),
    effectiveFrom: dateOnlySchema.optional(),
    sessionMinutes: durationMinutesSchema.optional(),
    timezone: timeZoneSchema.optional(),
    meetingMode: z.enum(MEETING_MODES).optional(),
    externalMeetingUrl: z.preprocess(blankToNull, httpsUrl.nullable()).optional(),
    notes: z.preprocess(blankToNull, z.string().trim().max(2000).nullable()).optional(),
    acknowledgeWarnings: acknowledgeWarningsSchema,
  })
  .superRefine((v, ctx) => {
    if (v.meetingMode === 'external' && !v.externalMeetingUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['externalMeetingUrl'],
        message: 'The meeting link is required for an external meeting.',
      });
    }
  });
export type UpdateEnrollmentInput = z.input<typeof updateEnrollmentSchema>;

/** `POST /enrollments/:id/pause` */
export const pauseEnrollmentSchema = z.object({ reason: z.enum(PAUSE_REASONS) });
export type PauseEnrollmentInput = z.input<typeof pauseEnrollmentSchema>;

/** `POST /enrollments/:id/end`: slots close on `endsOn`; later generated classes are removed. */
export const endEnrollmentSchema = z.object({ endsOn: dateOnlySchema });
export type EndEnrollmentInput = z.input<typeof endEnrollmentSchema>;

export const enrollmentListQuerySchema = listQueryBaseSchema.omit({ archived: true }).extend({
  studentId: queryId.optional(),
  teacherId: queryId.optional(),
  courseId: queryId.optional(),
  status: z.enum(ENROLLMENT_STATUSES).optional(),
});
export type EnrollmentListQuery = z.input<typeof enrollmentListQuerySchema>;

export const enrollmentSchema = z.object({
  id: z.number().int(),
  student: studentZoneRefSchema,
  course: courseRefSchema,
  teacher: personZoneRefSchema,
  kind: z.enum(ENROLLMENT_KINDS),
  status: z.enum(ENROLLMENT_STATUSES),
  pausedReason: z.string().nullable(),
  startsOn: z.string(),
  endsOn: z.string().nullable(),
  sessionMinutes: z.number().int(),
  timezone: z.string(),
  meetingMode: z.enum(MEETING_MODES),
  /** Staff with `schedule.manage` only. */
  externalMeetingUrl: z.string().nullable().optional(),
  /** Staff with `schedule.manage` only. */
  notes: z.string().nullable().optional(),
  /** Current and future slots (ended versions are left out), by weekday and time. */
  slots: z.array(scheduleSlotSchema),
  createdAt: z.string(),
});
export type EnrollmentDto = z.infer<typeof enrollmentSchema>;

export const enrollmentListResponseSchema = paginatedSchema(enrollmentSchema);

// ------------------------------------------------------------------ holidays

export const holidaySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  /** Academy-local date (`academy.timezone`). */
  date: z.string(),
  endsOn: z.string().nullable(),
  paid: z.boolean(),
  appliesTo: z.string(),
});
export type HolidayDto = z.infer<typeof holidaySchema>;

const holidayFields = {
  name: z.string().trim().min(1).max(255),
  date: dateOnlySchema,
  endsOn: z.preprocess(blankToNull, dateOnlySchema.nullable()).optional(),
  paid: z.boolean().optional(),
};
const endsAfterStart = (v: { date?: string; endsOn?: string | null }, ctx: z.RefinementCtx) => {
  if (v.date && v.endsOn && v.endsOn < v.date) {
    ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'Must be on or after the date.' });
  }
};
export const createHolidaySchema = z.object(holidayFields).superRefine(endsAfterStart);
export type CreateHolidayInput = z.input<typeof createHolidaySchema>;
export const updateHolidaySchema = z
  .object({
    ...holidayFields,
    name: holidayFields.name.optional(),
    date: dateOnlySchema.optional(),
  })
  .superRefine(endsAfterStart);
export type UpdateHolidayInput = z.input<typeof updateHolidaySchema>;
export const holidayListQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

// ------------------------------------------------------------------ teacher blocks + work hours

export const teacherBlockSchema = z.object({
  id: z.number().int(),
  teacherId: z.number().int(),
  kind: z.enum(TEACHER_BLOCK_KINDS),
  reason: z.string(),
  weekday: z.number().int().nullable(),
  localStartTime: z.string().nullable(),
  durationMinutes: z.number().int().nullable(),
  timezone: z.string().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  note: z.string().nullable(),
});
export type TeacherBlockDto = z.infer<typeof teacherBlockSchema>;

const blockFields = {
  reason: z.enum(TEACHER_BLOCK_REASONS),
  weekday: weekdaySchema.nullable().optional(),
  localStartTime: localTimeSchema.nullable().optional(),
  durationMinutes: z.number().int().min(5).max(1440).nullable().optional(),
  /** Defaults to the teacher's zone. */
  timezone: timeZoneSchema.nullable().optional(),
  validFrom: dateOnlySchema.nullable().optional(),
  validTo: dateOnlySchema.nullable().optional(),
  startsAt: instantSchema.nullable().optional(),
  endsAt: instantSchema.nullable().optional(),
  note: z.preprocess(blankToNull, z.string().trim().max(500).nullable()).optional(),
};
function blockRules(
  v: {
    kind?: TeacherBlockKind;
    weekday?: number | null;
    localStartTime?: string | null;
    durationMinutes?: number | null;
    validFrom?: string | null;
    validTo?: string | null;
    startsAt?: string | null;
    endsAt?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  const need = (field: string) =>
    ctx.addIssue({ code: 'custom', path: [field], message: 'This field is required.' });
  if (v.kind === 'recurring') {
    if (v.weekday == null) need('weekday');
    if (v.localStartTime == null) need('localStartTime');
    if (v.durationMinutes == null) need('durationMinutes');
  }
  if (v.kind === 'one_off') {
    if (!v.startsAt) need('startsAt');
    if (!v.endsAt) need('endsAt');
  }
  if (v.startsAt && v.endsAt && v.endsAt <= v.startsAt) {
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Must be after the start.' });
  }
  if (v.validFrom && v.validTo && v.validTo < v.validFrom) {
    ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'Must be on or after validFrom.' });
  }
}
/** `POST /teachers/:id/blocks` */
export const createTeacherBlockSchema = z
  .object({ kind: z.enum(TEACHER_BLOCK_KINDS), ...blockFields })
  .superRefine(blockRules);
export type CreateTeacherBlockInput = z.input<typeof createTeacherBlockSchema>;
/** `PATCH /teachers/:id/blocks/:blockId` */
export const updateTeacherBlockSchema = z
  .object({
    kind: z.enum(TEACHER_BLOCK_KINDS).optional(),
    ...blockFields,
    reason: blockFields.reason.optional(),
  })
  .superRefine(blockRules);
export type UpdateTeacherBlockInput = z.input<typeof updateTeacherBlockSchema>;

export const workHourSchema = z.object({
  weekday: z.number().int(),
  localStartTime: z.string(),
  localEndTime: z.string(),
  timezone: z.string(),
});
export type WorkHourDto = z.infer<typeof workHourSchema>;

/** `PUT /teachers/:id/work-hours`: replaces the weekly set (an end before the start crosses midnight). */
export const replaceWorkHoursSchema = z.object({
  workHours: z
    .array(
      z
        .object({
          weekday: weekdaySchema,
          localStartTime: localTimeSchema,
          localEndTime: localTimeSchema,
          timezone: timeZoneSchema.nullable().optional(),
        })
        .refine((v) => v.localEndTime !== v.localStartTime, {
          path: ['localEndTime'],
          message: 'The end must differ from the start.',
        }),
    )
    .max(50),
});
export type ReplaceWorkHoursInput = z.input<typeof replaceWorkHoursSchema>;

// ------------------------------------------------------------------ availability + check + timetable

/** `GET /schedule/availability` (staff only). Times are in the student's zone. */
export const availabilityQuerySchema = z
  .object({
    studentId: queryId.optional(),
    timezone: timeZoneSchema.optional(),
    /** `weekdays=1,3` or repeated `weekdays=1&weekdays=3`. */
    weekdays: z.preprocess(
      (v) => (typeof v === 'string' ? v.split(',') : v),
      z
        .array(z.coerce.number().int().min(1).max(7))
        .min(1)
        .max(7)
        .transform((a) => [...new Set(a)]),
    ),
    fromTime: localTimeSchema,
    toTime: localTimeSchema,
    durationMinutes: z.coerce
      .number()
      .int()
      .min(15)
      .max(180)
      .refine((v) => v % 5 === 0, { message: 'Use a multiple of 5 minutes.' }),
    courseId: queryId.optional(),
    gender: z.enum(['male', 'female']).optional(),
    teacherIds: z
      .preprocess(
        (v) => (typeof v === 'string' ? v.split(',') : v),
        z.array(z.coerce.number().int().positive()).max(200),
      )
      .optional(),
    teacherTimezone: timeZoneSchema.optional(),
    effectiveFrom: dateOnlySchema.optional(),
    stepMinutes: z.coerce
      .number()
      .refine((v) => v === 15 || v === 30, { message: 'Use 15 or 30.' })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.studentId && !v.timezone) {
      ctx.addIssue({ code: 'custom', path: ['timezone'], message: 'Give a student or a zone.' });
    }
    if (v.toTime <= v.fromTime) {
      ctx.addIssue({ code: 'custom', path: ['toTime'], message: 'Must be after fromTime.' });
    }
  });
export type AvailabilityQuery = z.input<typeof availabilityQuerySchema>;

export const availabilitySchema = z.object({
  timezone: z.string(),
  teachers: z.array(
    z.object({
      teacher: z.object({
        id: z.number().int(),
        name: z.string(),
        timezone: z.string(),
        gender: z.string().nullable(),
        weeklyLoadHours: z.number(),
      }),
      matchingWeekdays: z.number().int(),
      free: z.array(
        z.object({
          weekday: z.number().int(),
          localStartTime: z.string(),
          teacherLocal: z.object({ weekday: z.number().int(), time: z.string() }),
          inWorkHours: z.boolean(),
          /** `19:00 / 18:00` when the teacher-side time changes with DST during the year. */
          dstNote: z.string().nullable(),
        }),
      ),
    }),
  ),
  workHoursNotSet: z.array(personZoneRefSchema),
  /** Nearest free time when nothing matched the window. */
  nearest: z
    .object({ weekday: z.number().int(), localStartTime: z.string(), teacherId: z.number().int() })
    .nullable(),
});
export type AvailabilityDto = z.infer<typeof availabilitySchema>;

/**
 * `POST /schedule/check` (dry run): a single class (`startsAt` + `enrollmentId`) or a weekly slot
 * (`weekday` + `localStartTime` + `studentId` + `teacherId` + `timezone`). Answers `ConflictResultDto`.
 */
export const scheduleCheckSchema = z.union([
  z.object({
    enrollmentId: id,
    startsAt: instantSchema,
    durationMinutes: durationMinutesSchema,
    teacherId: id.optional(),
    excludeSessionId: id.optional(),
  }),
  z.object({
    enrollmentId: id.optional(),
    studentId: id,
    teacherId: id,
    weekday: weekdaySchema,
    localStartTime: localTimeSchema,
    durationMinutes: durationMinutesSchema.optional(),
    timezone: timeZoneSchema,
    validFrom: dateOnlySchema.optional(),
    excludeSlotId: id.optional(),
  }),
]);
export type ScheduleCheckInput = z.input<typeof scheduleCheckSchema>;

export const timetableQuerySchema = z.object({
  /** Local dates in `tz` (default: this week from Saturday, in the teacher's zone). */
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  tz: timeZoneSchema.optional(),
});
export type TimetableQuery = z.input<typeof timetableQuerySchema>;
