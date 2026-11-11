import { z } from 'zod';
import { paginatedSchema } from './people.js';
import { acknowledgeWarningsSchema, durationMinutesSchema, instantSchema } from './schedule.js';
import { sessionSchema } from './sessions.js';

/**
 * Class requests (N2): leave, reschedule (incl. the make-up of a leave class), advance and extra —
 * `/api/v1/session-requests`. Ported from the Laravel `SessionRequestService` (D46, D135, docs/14
 * §3.4). A parent, the class's teacher or a staff member asks; holders of
 * `session_requests.approve` decide. Some requests are approved on creation:
 * - a leave notified at least `sessions.leave_notice_hours` before the class (`auto_approved`);
 * - any request made by someone who may approve it (`approved`);
 * - a reschedule into the teacher's published work hours, same teacher, no conflict or warning,
 *   at least `sessions.reschedule_auto_approve_hours` ahead (`auto_approved`, D135).
 * Pending requests expire when their class starts (hourly job), except an extra class and the
 * make-up of a leave class.
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

const id = z.number().int().positive();
const queryId = z.coerce.number().int().positive().max(2_147_483_647);
const queryBool = z
  .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
  .transform((v) => v === true || v === '1' || v === 'true');

export const REQUEST_TYPES = ['leave', 'reschedule', 'advance', 'extra'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
export const REQUEST_TYPE_LABELS: Labels<RequestType> = {
  leave: { ar: 'طلب إجازة', en: 'Leave' },
  reschedule: { ar: 'طلب تأجيل', en: 'Reschedule' },
  advance: { ar: 'طلب تقديم', en: 'Advance' },
  extra: { ar: 'حصة إضافية', en: 'Extra class' },
};

export const REQUEST_STATUSES = [
  'pending',
  'approved',
  'auto_approved',
  'rejected',
  'cancelled',
  'expired',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const REQUEST_STATUS_LABELS: Labels<RequestStatus> = {
  pending: { ar: 'قيد المراجعة', en: 'Pending' },
  approved: { ar: 'تمت الموافقة', en: 'Approved' },
  auto_approved: { ar: 'موافقة تلقائية', en: 'Auto-approved' },
  rejected: { ar: 'مرفوض', en: 'Rejected' },
  cancelled: { ar: 'سُحب الطلب', en: 'Withdrawn' },
  expired: { ar: 'انتهت صلاحيته', en: 'Expired' },
};

export const REQUEST_ACTIONS = ['approve', 'reject', 'cancel'] as const;

/**
 * `POST /session-requests`. `proposedStartsAt`: required for advance (earlier, not past) and
 * extra; a reschedule must be later than the class, or (make-up of a leave class) within
 * `sessions.makeup_window_days` of it. Refusals: 404 for a class the user cannot see, 403 when the
 * user may not ask this type, 422 on the field, 409 `conflict` when the same request is pending.
 */
export const createSessionRequestSchema = z.object({
  type: z.enum(REQUEST_TYPES),
  sessionId: id,
  reason: z.string().trim().min(1).max(2000),
  /** Leave: when the teacher or the academy was told (not in the future). */
  notifiedAt: instantSchema.optional(),
  proposedStartsAt: instantSchema.optional(),
  proposedDurationMinutes: durationMinutesSchema.optional(),
  proposedTeacherId: id.optional(),
  acknowledgeWarnings: acknowledgeWarningsSchema,
});
export type CreateSessionRequestInput = z.input<typeof createSessionRequestSchema>;

/** `POST /session-requests/:id/approve`: may change the time or teacher; re-checks conflicts. */
export const approveSessionRequestSchema = z.object({
  startsAt: instantSchema.optional(),
  teacherId: id.optional(),
  note: z.string().trim().max(2000).optional(),
  acknowledgeWarnings: acknowledgeWarningsSchema,
});
export type ApproveSessionRequestInput = z.input<typeof approveSessionRequestSchema>;

/** `POST /session-requests/:id/reject`: the note is required. */
export const rejectSessionRequestSchema = z.object({ note: z.string().trim().min(1).max(2000) });
export type RejectSessionRequestInput = z.input<typeof rejectSessionRequestSchema>;

export const sessionRequestListQuerySchema = z.object({
  /** `decided` = every status except pending. */
  status: z.enum([...REQUEST_STATUSES, 'decided']).optional(),
  type: z.enum(REQUEST_TYPES).optional(),
  studentId: queryId.optional(),
  /** Only the requests I made. */
  mine: queryBool.optional(),
  /** Answer `RequestCountsDto` (pending per type) instead of a page. */
  countOnly: queryBool.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});
export type SessionRequestListQuery = z.input<typeof sessionRequestListQuerySchema>;

export const sessionRequestSchema = z.object({
  id: z.number().int(),
  type: z.enum(REQUEST_TYPES),
  status: z.enum(REQUEST_STATUSES),
  /** Left out inside a class detail. */
  session: sessionSchema.nullable().optional(),
  student: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  requestedBy: z.object({
    id: z.number().int(),
    name: z.string().nullable(),
    role: z.string().nullable(),
  }),
  reason: z.string(),
  notifiedAt: z.string().nullable(),
  proposedStartsAt: z.string().nullable(),
  proposedDurationMinutes: z.number().int().nullable(),
  proposedTeacherId: z.number().int().nullable(),
  decidedBy: z.object({ id: z.number().int(), name: z.string().nullable() }).nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  resultSessionId: z.number().int().nullable(),
  /** `approve` / `reject` for approvers, `cancel` for the requester, while pending. */
  allowedActions: z.array(z.enum(REQUEST_ACTIONS)),
  /** Decide before the class starts (the working-hours SLA clock comes with the support centre). */
  dueAt: z.string().nullable(),
  createdAt: z.string(),
});
export type SessionRequestDto = z.infer<typeof sessionRequestSchema>;

/** `meta.counts` = requests per status (`all` + each status) for the same filters minus `status`. */
export const sessionRequestListResponseSchema = paginatedSchema(sessionRequestSchema);

/** `GET /session-requests?countOnly=1`: header counters (pending, per type). */
export const requestCountsSchema = z.object({
  pending: z.number().int(),
  byType: z.record(z.enum(REQUEST_TYPES), z.number().int()),
});
export type RequestCountsDto = z.infer<typeof requestCountsSchema>;
