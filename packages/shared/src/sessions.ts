import { z } from 'zod';
import { timeZoneSchema } from './countries.js';
import { dateOnlySchema, paginatedSchema } from './people.js';
import {
  acknowledgeWarningsSchema,
  durationMinutesSchema,
  enrollmentSchema,
  instantSchema,
  personZoneRefSchema,
  scheduleSlotSchema,
  studentZoneRefSchema,
  teacherBlockSchema,
  workHourSchema,
} from './schedule.js';

/**
 * Classes (N2): the class list, one class with its timeline, the state machine transitions, the
 * Today board and the generator — `/api/v1/sessions…`, `/api/v1/teachers/:id/timetable`,
 * `/api/v1/settings/sessions` and `/api/v1/zoom-hosts`. Ported from the Laravel M2 sessions module
 * (docs/14 §3, §6, §8; docs/04 status codes). Instants are ISO 8601 UTC; the viewer's zone comes
 * first in the UI and the other party's time is labelled (D30).
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

const id = z.number().int().positive();
const queryId = z.coerce.number().int().positive().max(2_147_483_647);
/** `stage=a,b` or `stage=a&stage=b`. */
const queryList = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',') : v), z.array(item).max(20));

// ------------------------------------------------------------------ enums + labels

/** What happened to a class (docs/14 §3.1). The old codes: docs/04. */
export const SESSION_STAGES = [
  'scheduled',
  'activated',
  'in_progress',
  'ended',
  'taken',
  'absent',
  'declined',
  'leave',
  'cancelled',
  'moved_out',
] as const;
export type SessionStage = (typeof SESSION_STAGES)[number];
export const sessionStageSchema = z.enum(SESSION_STAGES);
export const SESSION_STAGE_LABELS: Labels<SessionStage> = {
  scheduled: { ar: 'مجدولة', en: 'Scheduled' },
  activated: { ar: 'مفعّلة', en: 'Activated' },
  in_progress: { ar: 'جارية', en: 'Running' },
  ended: { ar: 'انتهت (بلا تقرير)', en: 'Ended' },
  taken: { ar: 'منعقدة', en: 'Taken' },
  absent: { ar: 'غياب', en: 'Absent' },
  declined: { ar: 'رفض الطالب', en: 'Declined' },
  leave: { ar: 'إجازة', en: 'Leave' },
  cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  moved_out: { ar: 'نُقلت', en: 'Moved' },
};
/** Final stages (a class there needs `revert` to change again). */
export const TERMINAL_STAGES: readonly SessionStage[] = [
  'taken',
  'absent',
  'declined',
  'leave',
  'cancelled',
  'moved_out',
];
/** Stages that hold the teacher's and the student's time (leave, cancelled and moved free it). */
export const OCCUPYING_STAGES: readonly SessionStage[] = [
  'scheduled',
  'activated',
  'in_progress',
  'ended',
  'taken',
  'absent',
  'declined',
];

export const SESSION_KINDS = ['regular', 'trial', 'rescheduled', 'advance', 'extra'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];
export const SESSION_KIND_LABELS: Labels<SessionKind> = {
  regular: { ar: 'منتظمة', en: 'Regular' },
  trial: { ar: 'تجريبية', en: 'Trial' },
  rescheduled: { ar: 'تعويضية', en: 'Re-scheduled' },
  advance: { ar: 'مقدّمة', en: 'Advance' },
  extra: { ar: 'إضافية', en: 'Extra' },
};

export const SESSION_SOURCES = ['generated', 'manual', 'request', 'migrated'] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

export const ZOOM_STATUSES = ['none', 'pending', 'ready', 'failed', 'external', 'deleted'] as const;
export type ZoomStatus = (typeof ZOOM_STATUSES)[number];
export const ZOOM_STATUS_LABELS: Labels<ZoomStatus> = {
  none: { ar: 'بلا اجتماع', en: 'No meeting' },
  pending: { ar: 'قيد الإنشاء', en: 'Being created' },
  ready: { ar: 'جاهز', en: 'Ready' },
  failed: { ar: 'تعذّر الإنشاء', en: 'Failed' },
  external: { ar: 'رابط خارجي', en: 'External link' },
  deleted: { ar: 'حُذف', en: 'Deleted' },
};

/** Qualifier of a stage: who took leave, why a class was cancelled or moved. */
export const LEAVE_REASONS = ['student', 'teacher'] as const;
export const CANCEL_REASONS = [
  'holiday',
  'family_suspended',
  'family_on_leave',
  'teacher_unavailable',
  'enrollment_ended',
  'schedule_changed',
  'admin',
] as const;
export const STAGE_REASONS = [
  ...LEAVE_REASONS,
  ...CANCEL_REASONS,
  'rescheduled',
  'advanced',
] as const;
export type StageReason = (typeof STAGE_REASONS)[number];
export const STAGE_REASON_LABELS: Labels<StageReason> = {
  student: { ar: 'من الطالب', en: 'By the student' },
  teacher: { ar: 'من المعلم', en: 'By the teacher' },
  holiday: { ar: 'عطلة رسمية', en: 'Public holiday' },
  family_suspended: { ar: 'العائلة معلّقة', en: 'Family suspended' },
  family_on_leave: { ar: 'العائلة في إجازة', en: 'Family on leave' },
  teacher_unavailable: { ar: 'المعلم غير متاح', en: 'Teacher unavailable' },
  enrollment_ended: { ar: 'انتهى الاشتراك', en: 'Enrollment ended' },
  schedule_changed: { ar: 'تغيّر الجدول', en: 'Schedule changed' },
  admin: { ar: 'قرار إداري', en: 'Admin decision' },
  rescheduled: { ar: 'أُعيدت جدولتها', en: 'Rescheduled' },
  advanced: { ar: 'قُدّمت', en: 'Advanced' },
};

/** Actions a user may send to `POST /sessions/:id/transitions` (docs/14 §3.2). */
export const SESSION_ACTIONS = [
  'activate',
  'undo_activate',
  'start',
  'end',
  'mark_absent',
  'mark_declined',
  'mark_leave',
  'cancel',
  'undo_mark',
  'revert',
] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];
/**
 * `allowedActions` may also hold `submit_report`: the report is sent with `PUT /sessions/:id/report`
 * (an ended class; a taken one inside the edit window, or always for `sessions.manage`).
 */
export const SESSION_ACTION_LABELS: Labels<SessionAction | 'submit_report'> = {
  activate: { ar: 'تفعيل', en: 'Activate' },
  undo_activate: { ar: 'تراجع عن التفعيل', en: 'Undo activation' },
  start: { ar: 'بدء', en: 'Start' },
  end: { ar: 'إنهاء', en: 'End' },
  mark_absent: { ar: 'تسجيل غياب', en: 'Mark absent' },
  mark_declined: { ar: 'تسجيل رفض الطالب', en: 'Mark declined' },
  mark_leave: { ar: 'تسجيل إجازة', en: 'Mark leave' },
  cancel: { ar: 'إلغاء الحصة', en: 'Cancel class' },
  undo_mark: { ar: 'تراجع', en: 'Undo' },
  revert: { ar: 'إعادة إلى مجدولة', en: 'Revert to scheduled' },
  submit_report: { ar: 'تقرير الحصة', en: 'Lesson report' },
};

/** Flags on a row (docs/14 §6.2): computed for "now" by the server. */
export const ATTENTION_CODES = [
  'late',
  'late_activation',
  'report_missing',
  'needs_entry',
  'teacher_unavailable',
  'zoom_failed',
  'needs_review',
  'pending_request',
  'dst_adjusted',
  'deleted',
] as const;
export type AttentionCode = (typeof ATTENTION_CODES)[number];
export const ATTENTION_LABELS: Labels<AttentionCode> = {
  late: { ar: 'المعلم متأخر', en: 'Teacher late' },
  late_activation: { ar: 'فُعّلت متأخرة', en: 'Activated late' },
  report_missing: { ar: 'بلا تقرير', en: 'Report missing' },
  needs_entry: { ar: 'تحتاج تسجيلًا', en: 'Needs entry' },
  teacher_unavailable: { ar: 'المعلم غير متاح', en: 'Teacher unavailable' },
  zoom_failed: { ar: 'تعذّر إنشاء الاجتماع', en: 'Meeting failed' },
  needs_review: { ar: 'تحتاج مراجعة', en: 'Needs review' },
  pending_request: { ar: 'طلب قيد المراجعة', en: 'Pending request' },
  dst_adjusted: { ar: 'عُدّل بسبب التوقيت الصيفي', en: 'DST adjusted' },
  deleted: { ar: 'حُذفت', en: 'Removed' },
};

/** Today board counters, in the old dashboard's order (docs/15 §3.1 K1). */
export const BOARD_COUNTERS = [
  'total',
  'taken',
  'remaining',
  'running',
  'late',
  'absent',
  'leave',
  'declined',
  'suspended',
  'trial',
  'advance',
  'rescheduled',
  'ended',
  'holiday',
  'extra',
  'needs_entry',
  'teacher_unavailable',
  'zoom_failed',
  'needs_review',
  'pending_requests',
] as const;
export type BoardCounter = (typeof BOARD_COUNTERS)[number];
export const BOARD_COUNTER_LABELS: Labels<BoardCounter> = {
  total: { ar: 'الإجمالي', en: 'Total' },
  taken: { ar: 'منعقدة', en: 'Taken' },
  remaining: { ar: 'المتبقية', en: 'Remaining' },
  running: { ar: 'الجارية', en: 'Running' },
  late: { ar: 'متأخرة', en: 'Late' },
  absent: { ar: 'غياب', en: 'Absent' },
  leave: { ar: 'إجازة', en: 'Leave' },
  declined: { ar: 'رفض الطالب', en: 'Declined' },
  suspended: { ar: 'معلّقة', en: 'Suspended' },
  trial: { ar: 'تجريبية', en: 'Trial' },
  advance: { ar: 'مقدّمة', en: 'Advance' },
  rescheduled: { ar: 'تعويضية', en: 'Re-scheduled' },
  ended: { ar: 'بلا تقرير', en: 'Ended' },
  holiday: { ar: 'عطلة', en: 'Holiday' },
  extra: { ar: 'إضافية', en: 'Extra' },
  needs_entry: { ar: 'تحتاج تسجيلًا', en: 'Needs entry' },
  teacher_unavailable: { ar: 'المعلم غير متاح', en: 'Teacher unavailable' },
  zoom_failed: { ar: 'تعذّر الاجتماع', en: 'Meeting failed' },
  needs_review: { ar: 'تحتاج مراجعة', en: 'Needs review' },
  pending_requests: { ar: 'طلبات قيد المراجعة', en: 'Pending requests' },
};

/**
 * Refusal codes of the class endpoints: `invalid_transition` (409, or 422 for an unknown action),
 * `outside_window` (422, `errors.available_from` / `available_until`), `stale_session` (409, `data`
 * = the fresh class), `forbidden` (403), `zoom_unavailable` (503), `conflict` (409), plus the
 * scheduling `schedule_conflict` / `warnings_not_acknowledged`.
 */
export const SESSION_ERROR_CODES = [
  'invalid_transition',
  'outside_window',
  'stale_session',
  'zoom_unavailable',
  'conflict',
] as const;

// ------------------------------------------------------------------ class

export const sessionSchema = z.object({
  id: z.number().int(),
  kind: z.enum(SESSION_KINDS),
  /** A removed (re-synced away) row in a board delta reads `cancelled` with attention `deleted`. */
  stage: sessionStageSchema,
  stageReason: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  durationMinutes: z.number().int(),
  occurrenceDate: z.string().nullable(),
  source: z.enum(SESSION_SOURCES),
  isDetached: z.boolean(),
  student: studentZoneRefSchema,
  /** `phone` for staff with `sessions.manage` only. */
  teacher: personZoneRefSchema.extend({ phone: z.string().nullable().optional() }),
  course: z.object({ id: z.number().int(), nameAr: z.string(), nameEn: z.string() }),
  enrollmentId: z.number().int().nullable(),
  scheduleSlotId: z.number().int().nullable(),
  originSessionId: z.number().int().nullable(),
  times: z.object({
    activatedAt: z.string().nullable(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    markedAt: z.string().nullable(),
  }),
  latenessMinutes: z.number().int(),
  /** Never a URL: links come from `/zoom/start` and `/zoom/join` inside their windows. */
  zoom: z.object({ status: z.enum(ZOOM_STATUSES), joinAvailable: z.boolean() }),
  evidence: z.object({
    actualStartedAt: z.string().nullable(),
    teacherJoinedAt: z.string().nullable(),
    studentJoinedAt: z.string().nullable(),
  }),
  /**
   * The lesson report (N3): `submitted`, and until when the class's teacher may still edit it
   * (`editableUntil`, a taken class only; staff with `sessions.manage` edit at any time).
   */
  report: z.object({ submitted: z.boolean(), editableUntil: z.string().nullable() }),
  /**
   * N7 pay snapshot (D41/D56), taken when the stage is decided: pay hours (factor × duration),
   * the rule key and billable. Only for viewers with `payroll.view` or `sessions.manage`.
   */
  pay: z
    .object({
      hours: z.string().nullable(),
      ruleKey: z.string().nullable(),
      billable: z.boolean().nullable(),
    })
    .optional(),
  attention: z.array(z.string()),
  pendingRequests: z.array(z.object({ id: z.number().int(), type: z.string() })),
  /** What the viewer may do now (the server runs the same guards as the transition). */
  allowedActions: z.array(z.string()),
  /** Time-guarded actions that open later, e.g. `{ action: 'mark_absent', availableAt }`. */
  upcomingActions: z.array(z.object({ action: z.string(), availableAt: z.string() })),
  needsReview: z.boolean(),
  reviewReason: z.string().nullable(),
  lockVersion: z.number().int(),
  updatedAt: z.string(),
});
export type SessionDto = z.infer<typeof sessionSchema>;

export const sessionEventSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  fromStage: z.string().nullable(),
  toStage: z.string().nullable(),
  /**
   * null = the system (generator, re-sync, request auto-approval). For a parent or teacher, staff
   * appear by role only (`id` and `name` null, B118); their own actions keep their name.
   */
  actor: z
    .object({
      id: z.number().int().nullable(),
      name: z.string().nullable(),
      role: z.string().nullable(),
    })
    .nullable(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  occurredAt: z.string(),
});
export type SessionEventDto = z.infer<typeof sessionEventSchema>;

export const sessionListQuerySchema = z.object({
  /** One local day in `tz` (default: the viewer's zone). */
  date: dateOnlySchema.optional(),
  tz: timeZoneSchema.optional(),
  from: instantSchema.optional(),
  to: instantSchema.optional(),
  teacherId: queryId.optional(),
  studentId: queryId.optional(),
  enrollmentId: queryId.optional(),
  stage: queryList(sessionStageSchema).optional(),
  kind: queryList(z.enum(SESSION_KINDS)).optional(),
  attention: z.enum(['needs_review', 'zoom_failed', 'pending_request']).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  /** The teacher's My day / My week ask for 300 (two weeks in one page); max 500. */
  perPage: z.coerce.number().int().min(1).max(500).default(50),
});
export type SessionListQuery = z.input<typeof sessionListQuerySchema>;

/** `meta.counts` = classes per stage (`all` + each stage) for the same filters minus `stage`. */
export const sessionListResponseSchema = paginatedSchema(sessionSchema);

/** `POST /sessions`: a one-off class on an enrollment (`sessions.manage`). */
export const createSessionSchema = z.object({
  enrollmentId: id,
  kind: z.enum(['regular', 'trial', 'extra']),
  startsAt: instantSchema,
  durationMinutes: durationMinutesSchema,
  teacherId: id.optional(),
  originSessionId: id.optional(),
  acknowledgeWarnings: acknowledgeWarningsSchema,
});
export type CreateSessionInput = z.input<typeof createSessionSchema>;

/** `PATCH /sessions/:id`: shift a scheduled class or change its teacher (it becomes detached). */
export const updateSessionSchema = z.object({
  startsAt: instantSchema.optional(),
  durationMinutes: durationMinutesSchema.optional(),
  teacherId: id.optional(),
  expectedStage: sessionStageSchema,
  lockVersion: z.number().int().min(0).optional(),
  reason: z.string().trim().max(1000).optional(),
  acknowledgeWarnings: acknowledgeWarningsSchema,
});
export type UpdateSessionInput = z.input<typeof updateSessionSchema>;

/**
 * `POST /sessions/:id/transitions`. `expectedStage` (and `lockVersion`) guard against a stale
 * screen (409 `stale_session` with the fresh class in `data`); repeating an action whose target is
 * already reached is a no-op (double click). `note` is required for absent / declined, `reason`
 * for revert, an early end by staff and an override; `stageReason` from the lists for leave
 * (`student` | `teacher`, teacher-leave by staff only) and cancel.
 */
export const transitionSchema = z.object({
  action: z.enum(SESSION_ACTIONS),
  expectedStage: sessionStageSchema,
  lockVersion: z.number().int().min(0).optional(),
  reason: z.string().trim().max(1000).optional(),
  note: z.string().trim().max(2000).optional(),
  /** When the teacher was told about a leave (default now). */
  notifiedAt: instantSchema.optional(),
  stageReason: z.string().max(32).optional(),
  /** Staff only: act outside the time window (with a reason). */
  override: z.boolean().optional(),
});
export type TransitionInput = z.input<typeof transitionSchema>;

// ------------------------------------------------------------------ board + generator

export const boardQuerySchema = z.object({
  date: dateOnlySchema.optional(),
  tz: timeZoneSchema.optional(),
  /** The previous answer's `cursor`: only rows changed since (removed ones included). */
  since: z.string().max(40).optional(),
});
export type BoardQuery = z.input<typeof boardQuerySchema>;

export const generatorHealthSchema = z.object({
  lastSuccessAt: z.string().nullable(),
  /** No successful run in the last 2 hours: the cron stopped. */
  stale: z.boolean(),
});

/**
 * `GET /sessions/board`: the viewer's day (staff: everyone; a teacher: own classes). Poll every
 * ~15 s with `since=cursor` and upsert rows by id; an `If-None-Match` with the last `ETag`
 * answers 304 when nothing changed.
 */
export const boardSchema = z.object({
  counters: z.record(z.enum(BOARD_COUNTERS), z.number().int()),
  sessions: z.array(sessionSchema),
  cursor: z.string().nullable(),
  generator: generatorHealthSchema,
  serverTime: z.string(),
});
export type BoardDto = z.infer<typeof boardSchema>;

/** `POST /sessions/generate`: «مزامنة حصص اليوم» for one academy-local date, with a dry run. */
export const generateSessionsSchema = z.object({
  date: dateOnlySchema,
  dryRun: z.boolean().default(false),
});
export type GenerateSessionsInput = z.input<typeof generateSessionsSchema>;

export const generatePreviewRowSchema = z.object({
  startsAt: z.string(),
  student: z.object({ id: z.number().int(), name: z.string().nullable() }),
  teacher: z.object({ id: z.number().int(), name: z.string().nullable() }),
  course: z.object({ id: z.number().int(), name: z.string().nullable() }),
  stage: z.string(),
  stageReason: z.string().nullable(),
});
export const generateResultSchema = z.object({
  toCreate: z.array(generatePreviewRowSchema),
  created: z.array(z.number().int()),
});
export type GenerateResultDto = z.infer<typeof generateResultSchema>;

// ------------------------------------------------------------------ detail, timetable, enrollment detail

/** A request inside a class detail (the full shape, with its class, is in requests.ts). */
export const sessionRequestSummarySchema = z.object({
  id: z.number().int(),
  type: z.string(),
  status: z.string(),
  /** '' for a parent or teacher when someone else made the request. */
  reason: z.string(),
  /** By role only (`id`, `name` null) for a parent or teacher when someone else made it. */
  requestedBy: z.object({
    id: z.number().int().nullable(),
    name: z.string().nullable(),
    role: z.string().nullable(),
  }),
  proposedStartsAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  resultSessionId: z.number().int().nullable(),
  createdAt: z.string(),
});

// `sessionDetailSchema` (`GET /sessions/:id`, with the lesson report) lives in reports.ts.

/** `GET /enrollments/:id`: the enrollment + its next classes (up to 20, from an hour ago). */
export const enrollmentDetailSchema = enrollmentSchema.extend({
  upcomingSessions: z.array(sessionSchema),
});
export type EnrollmentDetailDto = z.infer<typeof enrollmentDetailSchema>;

/** Writes that may leave hand-touched classes alone answer them here (the admin decides, §4.4). */
export const affectedManualSessionsSchema = z.array(sessionSchema);

/** `GET /teachers/:id/timetable`: a teacher's week (staff, or the teacher themself). */
export const timetableSchema = z.object({
  teacher: personZoneRefSchema,
  slots: z.array(scheduleSlotSchema),
  blocks: z.array(teacherBlockSchema),
  workHours: z.array(workHourSchema),
  sessions: z.array(sessionSchema),
});
export type TimetableDto = z.infer<typeof timetableSchema>;

// ------------------------------------------------------------------ meeting links

/** `GET /sessions/:id/zoom/start` (own teacher, from 15 min before): never stored or logged. */
export const zoomStartSchema = z.object({ startUrl: z.string() });
/** `GET /sessions/:id/zoom/join` (anyone who sees the class, from 60 min before). */
export const zoomJoinSchema = z.object({ joinUrl: z.string() });

export const zoomHostSchema = z.object({
  id: z.number().int(),
  zoomUserId: z.string(),
  email: z.string(),
  label: z.string().nullable(),
  teacherId: z.number().int().nullable(),
  isActive: z.boolean(),
});
export type ZoomHostDto = z.infer<typeof zoomHostSchema>;
export const createZoomHostSchema = z.object({
  zoomUserId: z.string().trim().min(1).max(64),
  email: z.email().max(255),
  label: z.string().trim().max(100).nullable().optional(),
  teacherId: id.nullable().optional(),
  isActive: z.boolean().optional(),
});
export type CreateZoomHostInput = z.input<typeof createZoomHostSchema>;
export const updateZoomHostSchema = createZoomHostSchema.partial();
export type UpdateZoomHostInput = z.input<typeof updateZoomHostSchema>;

// ------------------------------------------------------------------ class rules (settings)

/**
 * `GET/PUT /settings/sessions`: the class rules as flat keys (Laravel `SessionSettingsController`).
 * A PUT sends only the keys it changes; an unknown key is a 422 on that key.
 */
export const SESSION_SETTING_RULES = {
  'academy.timezone': timeZoneSchema,
  'sessions.horizon_days': z.number().int().min(1).max(60),
  'sessions.activation_window_before_min': z.number().int().min(0).max(120),
  'sessions.activation_window_after_min': z.number().int().min(0).max(240),
  'sessions.undo_activation_min': z.number().int().min(0).max(60),
  'sessions.absent_min_wait_min': z.number().int().min(0).max(120),
  'sessions.min_duration_min': z.number().int().min(0).max(180),
  'sessions.leave_notice_hours': z.number().int().min(0).max(72),
  'sessions.late_teacher_min': z.number().int().min(0).max(60),
  'sessions.report_due_hours': z.number().int().min(1).max(168),
  'sessions.report_edit_hours': z.number().int().min(0).max(720),
  'sessions.makeup_window_days': z.number().int().min(1).max(90),
  'sessions.teacher_buffer_min': z.number().int().min(0).max(60),
  'sessions.reschedule_auto_approve_hours': z.number().int().min(0).max(168),
  'zoom.create_lead_hours': z.number().int().min(1).max(168),
  /** B30 (D72): parents see the 1–5 class rating of a lesson report. */
  'reports.parent_sees_rating': z.boolean(),
} as const;
export type SessionSettingKey = keyof typeof SESSION_SETTING_RULES;
export const sessionSettingsSchema = z.object(SESSION_SETTING_RULES);
export type SessionSettingsDto = z.infer<typeof sessionSettingsSchema>;
export const updateSessionSettingsSchema = z.strictObject(SESSION_SETTING_RULES).partial();
export type UpdateSessionSettingsInput = z.input<typeof updateSessionSettingsSchema>;
