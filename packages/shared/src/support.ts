import { z } from 'zod';
import { timeZoneSchema } from './countries.js';
import { sessionRequestSchema, REQUEST_STATUSES, REQUEST_TYPES } from './requests.js';
import {
  SLA_STATES,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_QUEUES,
  TICKET_STATUSES,
  TICKET_SUBCATEGORIES,
  type TicketCategory,
  type TicketQueue,
  type TicketSubcategory,
  ticketSchema,
} from './tickets.js';

/**
 * Support centre (N4, docs/32 S1–S2, D135): «تواصل معنا» for families and teachers, the unified
 * staff inbox (tickets of the user's queues + pending class requests in «الجدولة»), the merged
 * «طلباتي», the dashboard counters and the queue settings — `/api/v1/support/…` and
 * `/api/v1/settings/support`. Approve / reject of a class request stays on `/session-requests`;
 * reply / status / assignment of a ticket on `/feedback/tickets`.
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

const queryId = z.coerce.number().int().positive().max(2_147_483_647);
const queryBool = z
  .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
  .transform((v) => v === true || v === '1' || v === 'true');
const queryList = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
    z.array(item).max(20),
  );

/** The menu entry (header on desktop, bottom bar on mobile) and the screen title. */
export const CONTACT_US_LABEL = { ar: 'تواصل معنا', en: 'Contact us' } as const;
export const CONTACT_US_QUESTION = { ar: 'بخصوص ماذا؟', en: 'What is it about?' } as const;
export const MY_REQUESTS_LABEL = { ar: 'طلباتي', en: 'My requests' } as const;

/**
 * One «تواصل معنا» card (docs/32 §2b): at most four choices inside, two taps to the right form.
 * A choice either opens a ticket form (`category` + `subcategory`) or a class request
 * (`requestType`, starting from the child's next classes), or the technical report flow.
 */
export interface ContactUsChoice {
  key: string;
  label: { ar: string; en: string };
  category: TicketCategory;
  subcategory?: TicketSubcategory;
  /** Opens the class request form on a chosen class (leave / reschedule) instead of a ticket. */
  requestType?: (typeof REQUEST_TYPES)[number];
  /** Pick a class / invoice / child first (pre-fills `subjectType` + `subjectId`). */
  subject?: 'session' | 'invoice' | 'student';
}
export interface ContactUsCard {
  key: string;
  label: { ar: string; en: string };
  hint: { ar: string; en: string };
  choices: ContactUsChoice[];
}

/** The parent's four cards (docs/32 §2b); «موضوع آخر» is a small link under them. */
export const PARENT_CONTACT_CARDS: ContactUsCard[] = [
  {
    key: 'classes',
    label: { ar: 'الحصص والمواعيد', en: 'Classes and times' },
    hint: {
      ar: 'تغيير موعد، اعتذار، أو مشكلة في حصة',
      en: 'Change a time, excuse, or a class issue',
    },
    choices: [
      {
        key: 'reschedule',
        label: { ar: 'تغيير موعد حصة', en: 'Change a class time' },
        category: 'classes',
        requestType: 'reschedule',
        subject: 'session',
      },
      {
        key: 'leave',
        label: { ar: 'الاعتذار عن حصة', en: 'Excuse from a class' },
        category: 'classes',
        requestType: 'leave',
        subject: 'session',
      },
      {
        key: 'session_issue',
        label: { ar: 'الإبلاغ عن مشكلة في حصة', en: 'Report a problem in a class' },
        category: 'classes',
        subcategory: 'session_issue',
        subject: 'session',
      },
      {
        key: 'schedule_change',
        label: { ar: 'تغيير الجدول الأسبوعي', en: 'Change the weekly schedule' },
        category: 'classes',
        subcategory: 'schedule_change',
      },
    ],
  },
  {
    key: 'teacher',
    label: { ar: 'المعلم والمستوى الدراسي', en: 'Teacher and progress' },
    hint: {
      ar: 'تغيير المعلم، ملاحظة، أو سؤال عن التقدم',
      en: 'Teacher change, feedback, progress',
    },
    choices: [
      {
        key: 'teacher_change',
        label: { ar: 'طلب تغيير المعلم', en: 'Ask for another teacher' },
        category: 'teacher',
        subcategory: 'teacher_change',
        subject: 'student',
      },
      {
        key: 'teacher_feedback',
        label: { ar: 'ملاحظة أو شكوى بخصوص المعلم', en: 'Feedback or complaint about the teacher' },
        category: 'teacher',
        subcategory: 'teacher_feedback',
        subject: 'student',
      },
      {
        key: 'progress_question',
        label: { ar: 'سؤال عن المستوى والتقدم', en: 'Question about progress' },
        category: 'teacher',
        subcategory: 'progress_question',
        subject: 'student',
      },
    ],
  },
  {
    key: 'billing',
    label: { ar: 'الفواتير والاشتراك', en: 'Invoices and subscription' },
    hint: { ar: 'استفسار عن فاتورة، أو إيقاف الاشتراك', en: 'An invoice question, or pausing' },
    choices: [
      {
        key: 'invoice_question',
        label: { ar: 'استفسار عن فاتورة أو دفعة', en: 'Question about an invoice or payment' },
        category: 'billing',
        subcategory: 'invoice_question',
        subject: 'invoice',
      },
      {
        key: 'subscription_change',
        label: { ar: 'إيقاف مؤقت أو إلغاء الاشتراك', en: 'Pause or cancel the subscription' },
        category: 'billing',
        subcategory: 'subscription_change',
      },
    ],
  },
  {
    key: 'technical',
    label: { ar: 'مشكلة تقنية أو اقتراح', en: 'Technical problem or suggestion' },
    hint: { ar: 'مع لقطة شاشة تلقائية', en: 'With an automatic screenshot' },
    choices: [
      {
        key: 'technical',
        label: { ar: 'الإبلاغ عن مشكلة تقنية', en: 'Report a technical problem' },
        category: 'technical',
      },
      {
        key: 'suggestion',
        label: { ar: 'اقتراح', en: 'A suggestion' },
        category: 'suggestion',
      },
    ],
  },
];

/** The teacher's shell (docs/32 §2b). Leaves (M6) and salary questions arrive with N6/N7. */
export const TEACHER_CONTACT_CARDS: ContactUsCard[] = [
  {
    key: 'classes',
    label: { ar: 'حصصي', en: 'My classes' },
    hint: { ar: 'تغيير موعد، أو مشكلة في حصة', en: 'Change a time, or a class issue' },
    choices: [
      {
        key: 'reschedule',
        label: { ar: 'تغيير موعد حصة', en: 'Change a class time' },
        category: 'classes',
        requestType: 'reschedule',
        subject: 'session',
      },
      {
        key: 'session_issue',
        label: { ar: 'مشكلة في حصة', en: 'A problem in a class' },
        category: 'classes',
        subcategory: 'session_issue',
        subject: 'session',
      },
      {
        key: 'makeup',
        label: { ar: 'حصة تعويضية', en: 'Make-up class' },
        category: 'classes',
        subcategory: 'makeup',
        subject: 'session',
      },
    ],
  },
  {
    key: 'salary',
    label: { ar: 'الراتب', en: 'Salary' },
    hint: { ar: 'استفسار عن الراتب', en: 'A salary question' },
    choices: [
      {
        key: 'salary',
        label: { ar: 'استفسار عن الراتب', en: 'A salary question' },
        category: 'billing',
        subcategory: 'salary',
      },
    ],
  },
  {
    key: 'technical',
    label: { ar: 'مشكلة تقنية أو اقتراح', en: 'Technical problem or suggestion' },
    hint: { ar: 'مع لقطة شاشة تلقائية', en: 'With an automatic screenshot' },
    choices: [
      {
        key: 'technical',
        label: { ar: 'الإبلاغ عن مشكلة تقنية', en: 'Report a technical problem' },
        category: 'technical',
      },
      { key: 'suggestion', label: { ar: 'اقتراح', en: 'A suggestion' }, category: 'suggestion' },
    ],
  },
];

/** What happens next, from the requester's side («طلباتي»). */
export const NEXT_STEPS = [
  'awaiting_team',
  'in_progress',
  'reply_needed',
  'confirm_fix',
  'awaiting_approval',
] as const;
export type NextStep = (typeof NEXT_STEPS)[number];
export const NEXT_STEP_LABELS: Labels<NextStep> = {
  awaiting_team: { ar: 'بانتظار رد الفريق', en: 'Waiting for the team' },
  in_progress: { ar: 'جارٍ العمل عليه', en: 'Being worked on' },
  reply_needed: { ar: 'مطلوب ردك', en: 'Your reply is needed' },
  confirm_fix: { ar: 'أكّد أن المشكلة حُلّت', en: 'Confirm it is solved' },
  awaiting_approval: { ar: 'بانتظار الموافقة', en: 'Waiting for approval' },
};

export const INBOX_KINDS = ['ticket', 'session_request'] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

// ------------------------------------------------------------------ settings

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/);
const queueEnum = z.enum(TICKET_QUEUES);
const routingKey = z.string().refine((key) => {
  const [category, sub, ...rest] = key.split('.');
  if (rest.length || !(TICKET_CATEGORIES as readonly string[]).includes(category ?? '')) {
    return false;
  }
  return (
    sub === undefined ||
    (TICKET_SUBCATEGORIES[category as TicketCategory] as readonly string[]).includes(sub)
  );
}, 'Use a category or category.subcategory.');

/**
 * `GET/PUT /settings/support` (docs/32 §5): flat dotted keys; PUT takes any subset, each key
 * replaced as a whole; an unknown key is a 422 on that key. Role names in `queue_members` must
 * exist. Working days are ISO weekdays (1 = Monday … 7 = Sunday).
 */
export const SUPPORT_SETTING_RULES = {
  /** Category or `category.subcategory` → queue (the more specific key wins). */
  'support.queue_by_category': z.record(routingKey, queueEnum),
  /** Queue → member role names. `support.manage` holders see and handle every queue. */
  'support.queue_members': z.partialRecord(queueEnum, z.array(z.string().min(1).max(100)).max(50)),
  /** Tickets routed here are restricted (reporter + `support.view_restricted` only). */
  'support.restricted_queues': z.array(queueEnum).max(TICKET_QUEUES.length),
  /** First-response target per queue, in working hours (0 < h ≤ 720). */
  'support.sla_hours': z.partialRecord(queueEnum, z.number().positive().max(720)),
  'support.working_hours': z
    .object({
      timezone: timeZoneSchema,
      days: z.array(z.number().int().min(1).max(7)).max(7),
      start: hhmm,
      end: hhmm,
    })
    .refine((v) => v.start < v.end, { path: ['end'], message: 'End after start.' }),
} as const;
export type SupportSettingKey = keyof typeof SUPPORT_SETTING_RULES;
export const updateSupportSettingsSchema = z
  .object(SUPPORT_SETTING_RULES)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one setting.' });
export type UpdateSupportSettingsInput = z.input<typeof updateSupportSettingsSchema>;
export interface SupportSettingsDto {
  'support.queue_by_category': Record<string, TicketQueue>;
  'support.queue_members': Partial<Record<TicketQueue, string[]>>;
  'support.restricted_queues': TicketQueue[];
  'support.sla_hours': Partial<Record<TicketQueue, number>>;
  'support.working_hours': { timezone: string; days: number[]; start: string; end: string };
}

// ------------------------------------------------------------------ inbox

/**
 * `GET /support/inbox` (`support.view`): breached first, then by deadline, then newest.
 * `status` = open (default) | closed | all | one ticket status. Class requests are listed only
 * while pending, only in «الجدولة», for holders of `session_requests.view`, and drop out of any
 * filter they cannot match (a priority, an assignee, a category other than `classes`).
 */
export const inboxQuerySchema = z.object({
  queue: queueEnum.optional(),
  kind: z.enum(INBOX_KINDS).optional(),
  category: queryList(z.enum(TICKET_CATEGORIES)).optional(),
  status: z.enum(['open', 'closed', 'all', ...TICKET_STATUSES]).default('open'),
  priority: queryList(z.enum([...TICKET_PRIORITIES, 'none'])).optional(),
  breached: queryBool.optional(),
  familyId: queryId.optional(),
  /** me | none | a user id */
  assignee: z.union([z.enum(['me', 'none']), queryId]).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});
export type InboxQuery = z.input<typeof inboxQuerySchema>;

const ref = z.object({ id: z.number().int(), name: z.string().nullable() });

export const inboxItemSchema = z.object({
  kind: z.enum(INBOX_KINDS),
  /** `ticket:12` / `request:7` (stable list key). */
  key: z.string(),
  id: z.number().int(),
  queue: queueEnum,
  slaDueAt: z.string().nullable(),
  slaState: z.enum(SLA_STATES),
  family: ref.nullable(),
  teacher: ref.nullable(),
  open: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  ticket: ticketSchema.nullable(),
  /** With `allowedActions` (approve / reject) from `/session-requests`. */
  request: sessionRequestSchema.nullable(),
});
export type InboxItemDto = z.infer<typeof inboxItemSchema>;

export const queueCountsSchema = z.object({
  open: z.number().int(),
  breached: z.number().int(),
  unassigned: z.number().int(),
});
export type QueueCountsDto = z.infer<typeof queueCountsSchema>;

export const inboxResponseSchema = z.object({
  data: z.array(inboxItemSchema),
  meta: z.object({
    page: z.number().int(),
    perPage: z.number().int(),
    total: z.number().int(),
    lastPage: z.number().int(),
    /** The queues this user sees (the tabs), in display order. */
    queues: z.array(queueEnum),
    /** Per visible queue, ignoring the filters. */
    counts: z.partialRecord(queueEnum, queueCountsSchema),
  }),
});
export type InboxResponse = z.infer<typeof inboxResponseSchema>;

/** `GET /support/summary`: the dashboard tile «طلبات متأخرة» and the header counters. */
export const supportSummarySchema = z.object({
  openTotal: z.number().int(),
  breachedTotal: z.number().int(),
  unassignedTotal: z.number().int(),
  queues: z.partialRecord(queueEnum, queueCountsSchema),
});
export type SupportSummaryDto = z.infer<typeof supportSummarySchema>;

/** `GET /support/assignees?queue=` (422 for a queue the user does not see). */
export const supportAssigneesQuerySchema = z.object({ queue: queueEnum });

/** `GET /support/people?familyId=&teacherId=`: the inbox side panel. */
export const supportPeopleQuerySchema = z.object({
  familyId: queryId.optional(),
  teacherId: queryId.optional(),
});
export const supportPeopleSchema = z.object({
  /** Details (status, zone, children, counts) need `families.view`; otherwise null / empty. */
  family: z
    .object({
      id: z.number().int(),
      name: z.string().nullable(),
      status: z.string().nullable(),
      timezone: z.string().nullable(),
      children: z.array(z.object({ id: z.number().int(), name: z.string() })),
      openTickets: z.number().int(),
      pendingRequests: z.number().int(),
    })
    .nullable(),
  teacher: z.object({ id: z.number().int(), name: z.string(), timezone: z.string() }).nullable(),
});
export type SupportPeopleDto = z.infer<typeof supportPeopleSchema>;

// ------------------------------------------------------------------ «طلباتي»

/**
 * `GET /support/mine` (`feedback.request` or `session_requests.request`): my tickets and my class
 * requests in one list, open first, then latest change. A parent also sees the class requests
 * staff filed for their children; a teacher only the ones they filed. `meta.open` counts open
 * items whatever the filter.
 */
export const myRequestsQuerySchema = z.object({
  status: z.enum(['open', 'closed']).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});
export type MyRequestsQuery = z.input<typeof myRequestsQuerySchema>;

export const myRequestItemSchema = z.object({
  kind: z.enum(INBOX_KINDS),
  key: z.string(),
  id: z.number().int(),
  title: z.string().nullable(),
  status: z.union([z.enum(TICKET_STATUSES), z.enum(REQUEST_STATUSES)]),
  open: z.boolean(),
  category: z.enum(TICKET_CATEGORIES).nullable(),
  requestType: z.enum(REQUEST_TYPES).nullable(),
  nextStep: z.enum(NEXT_STEPS).nullable(),
  slaDueAt: z.string().nullable(),
  hasUpdate: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  ticket: ticketSchema.nullable(),
  request: sessionRequestSchema.nullable(),
});
export type MyRequestItemDto = z.infer<typeof myRequestItemSchema>;
export const myRequestsResponseSchema = z.object({
  data: z.array(myRequestItemSchema),
  meta: z.object({
    page: z.number().int(),
    perPage: z.number().int(),
    total: z.number().int(),
    lastPage: z.number().int(),
    open: z.number().int(),
  }),
});
export type MyRequestsResponse = z.infer<typeof myRequestsResponseSchema>;
