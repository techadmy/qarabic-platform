import { z } from 'zod';
import { supportRequestSchema } from './support-requests.js';

/**
 * «تواصل معنا» tickets (N4): pilot feedback (docs/22) grown into the support centre (docs/32, D99,
 * D135) — `/api/v1/feedback/…`. Ported from the Laravel Feedback module (`FeedbackTicket`,
 * `TicketService`, `FeedbackTicketPolicy`). A ticket has a category (what it is about), an
 * optional subcategory from a fixed list, an optional subject (a class, an invoice or a child in the
 * reporter's own scope), a queue (who handles it, from the category), a priority P0–P3, a status
 * lifecycle and a first-response SLA in working hours.
 *
 * Visibility (D99, D135, D138): a reporter sees their own tickets; holders of `feedback.review` see
 * all; queue members (`support.view`) see their queues. Complaints are `restricted`: only the
 * reporter and holders of `support.view_restricted`, and never the teacher they are about.
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

const id = z.number().int().positive();
const queryId = z.coerce.number().int().positive().max(2_147_483_647);
/** `x=a,b`, `x=a&x=b` or `x[]=a`: a list of values. */
const queryList = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
    z.array(item).max(20),
  );

// ------------------------------------------------------------------ enums + labels

/** D121: a problem or a request to add / change something (kept in step with the category). */
export const TICKET_TYPES = ['bug', 'feature'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];
export const TICKET_TYPE_LABELS: Labels<TicketType> = {
  bug: { ar: 'مشكلة', en: 'Problem' },
  feature: { ar: 'طلب إضافة أو تعديل', en: 'Feature request' },
};

/** docs/32 §2b: the four «بخصوص ماذا؟» groups plus `suggestion` and `other` («موضوع آخر»). */
export const TICKET_CATEGORIES = [
  'classes',
  'teacher',
  'billing',
  'technical',
  'suggestion',
  'other',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export const TICKET_CATEGORY_LABELS: Labels<TicketCategory> = {
  classes: { ar: 'الحصص والمواعيد', en: 'Classes and times' },
  teacher: { ar: 'المعلم والمستوى الدراسي', en: 'Teacher and progress' },
  billing: { ar: 'الفواتير والاشتراك', en: 'Invoices and subscription' },
  technical: { ar: 'مشكلة تقنية', en: 'Technical problem' },
  suggestion: { ar: 'اقتراح', en: 'Suggestion' },
  other: { ar: 'موضوع آخر', en: 'Something else' },
};

/** Fixed allow-list of subcategories per category (docs/32 §2b); empty = none allowed. */
export const TICKET_SUBCATEGORIES = {
  classes: ['session_issue', 'schedule_change', 'makeup'],
  teacher: ['teacher_change', 'teacher_feedback', 'progress_question'],
  billing: ['invoice_question', 'subscription_change', 'salary'],
  technical: [],
  suggestion: [],
  other: [],
} as const satisfies Record<TicketCategory, readonly string[]>;
export type TicketSubcategory = (typeof TICKET_SUBCATEGORIES)[TicketCategory][number];
export const TICKET_SUBCATEGORY_LABELS: Labels<TicketSubcategory> = {
  session_issue: { ar: 'مشكلة في حصة', en: 'A problem in a class' },
  schedule_change: { ar: 'تغيير الجدول الأسبوعي', en: 'Change the weekly schedule' },
  makeup: { ar: 'حصة تعويضية', en: 'Make-up class' },
  teacher_change: { ar: 'طلب تغيير المعلم', en: 'Change the teacher' },
  teacher_feedback: {
    ar: 'ملاحظة أو شكوى بخصوص المعلم',
    en: 'Feedback or complaint about the teacher',
  },
  progress_question: { ar: 'سؤال عن المستوى والتقدم', en: 'Question about progress' },
  invoice_question: { ar: 'استفسار عن فاتورة أو دفعة', en: 'Question about an invoice or payment' },
  subscription_change: {
    ar: 'إيقاف مؤقت أو إلغاء الاشتراك',
    en: 'Pause or cancel the subscription',
  },
  salary: { ar: 'الراتب', en: 'Salary' },
};

/** The legacy type a category carries: technical ⇔ bug, everything else ⇔ feature. */
export const categoryType = (category: TicketCategory): TicketType =>
  category === 'technical' ? 'bug' : 'feature';
/** The category of a ticket that only has the legacy type (old clients, WhatsApp). */
export const categoryOfType = (type: TicketType): TicketCategory =>
  type === 'bug' ? 'technical' : 'suggestion';

export const isSubcategoryOf = (category: TicketCategory, sub: string): boolean =>
  (TICKET_SUBCATEGORIES[category] as readonly string[]).includes(sub);

/** Where a ticket came from (docs/32 §4). Staff filing on someone's behalf say how it reached them. */
export const TICKET_CHANNELS = ['in_app', 'whatsapp', 'staff', 'phone'] as const;
export type TicketChannel = (typeof TICKET_CHANNELS)[number];
export const TICKET_CHANNEL_LABELS: Labels<TicketChannel> = {
  in_app: { ar: 'من النظام', en: 'In the app' },
  whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
  staff: { ar: 'بواسطة الموظف', en: 'By staff' },
  phone: { ar: 'مكالمة هاتفية', en: 'Phone call' },
};
/** Channels a staff member may set when filing on someone's behalf. */
export const STAFF_TICKET_CHANNELS = ['staff', 'phone', 'whatsapp'] as const;

/** D98: P0 = real work blocked or wrong money / data … P3 = an idea or wording. */
export const TICKET_PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_PRIORITY_LABELS: Labels<TicketPriority> = {
  p0: { ar: 'حرجة (P0)', en: 'Critical (P0)' },
  p1: { ar: 'عالية (P1)', en: 'High (P1)' },
  p2: { ar: 'متوسطة (P2)', en: 'Medium (P2)' },
  p3: { ar: 'منخفضة (P3)', en: 'Low (P3)' },
};
export const TICKET_PRIORITY_HINTS: Labels<TicketPriority> = {
  p0: {
    ar: 'العمل متوقف، أو خطأ في المال أو البيانات',
    en: 'Work blocked, or wrong money or data',
  },
  p1: { ar: 'يعطل العمل وله حل مؤقت', en: 'Hurts the work, with a workaround' },
  p2: { ar: 'مزعج ولا يعطل العمل', en: 'Annoying, does not block the work' },
  p3: { ar: 'فكرة أو صياغة', en: 'An idea or wording' },
};

/**
 * Lifecycle (docs/22 §3, D97): new → triaged → in_progress → fixed (awaiting the reporter) →
 * verified (closed), plus needs_info and wont_fix. A closed ticket can be reopened to triaged.
 */
export const TICKET_STATUSES = [
  'new',
  'triaged',
  'in_progress',
  'needs_info',
  'fixed',
  'verified',
  'wont_fix',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_STATUS_LABELS: Labels<TicketStatus> = {
  new: { ar: 'جديد', en: 'New' },
  triaged: { ar: 'قيد المراجعة', en: 'Triaged' },
  in_progress: { ar: 'قيد التنفيذ', en: 'In progress' },
  needs_info: { ar: 'بانتظار معلومات منك', en: 'Needs information' },
  fixed: { ar: 'تم الحل (بانتظار التأكيد)', en: 'Resolved (awaiting confirmation)' },
  verified: { ar: 'مغلق', en: 'Closed' },
  wont_fix: { ar: 'مغلق دون تنفيذ', en: 'Closed without change' },
};
export const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  new: ['triaged', 'in_progress', 'needs_info', 'wont_fix'],
  triaged: ['in_progress', 'needs_info', 'fixed', 'wont_fix'],
  in_progress: ['triaged', 'needs_info', 'fixed', 'wont_fix'],
  needs_info: ['triaged', 'in_progress', 'wont_fix'],
  fixed: ['verified', 'triaged', 'in_progress'],
  verified: ['triaged'],
  wont_fix: ['triaged'],
};
export const CLOSED_TICKET_STATUSES = ['verified', 'wont_fix'] as const satisfies TicketStatus[];
export const OPEN_TICKET_STATUSES = TICKET_STATUSES.filter(
  (s) => !(CLOSED_TICKET_STATUSES as readonly string[]).includes(s),
);
export const isClosedStatus = (s: TicketStatus): boolean =>
  (CLOSED_TICKET_STATUSES as readonly string[]).includes(s);
/** A public note is required when moving here (D97). */
export const NOTE_REQUIRED_STATUSES = ['needs_info', 'wont_fix'] as const;
/** A priority is required before moving here. */
export const PRIORITY_REQUIRED_STATUSES = ['triaged', 'in_progress', 'fixed'] as const;
/** Status changes the reporter is told about (D101). */
export const REPORTER_NOTIFIED_STATUSES = ['needs_info', 'fixed', 'verified', 'wont_fix'] as const;

/** What a ticket may point to (docs/32 §2b): a class, an invoice or a child. */
export const TICKET_SUBJECT_TYPES = ['session', 'invoice', 'student'] as const;
export type TicketSubjectType = (typeof TICKET_SUBJECT_TYPES)[number];
export const TICKET_SUBJECT_LABELS: Labels<TicketSubjectType> = {
  session: { ar: 'حصة', en: 'Class' },
  invoice: { ar: 'فاتورة', en: 'Invoice' },
  student: { ar: 'الطالب', en: 'Student' },
};

/** Support queues (docs/32 §5, D135); a ticket is routed to one from its category. */
export const TICKET_QUEUES = [
  'scheduling',
  'billing',
  'complaints',
  'tech',
  'product',
  'general',
] as const;
export type TicketQueue = (typeof TICKET_QUEUES)[number];
export const TICKET_QUEUE_LABELS: Labels<TicketQueue> = {
  scheduling: { ar: 'الجدولة', en: 'Scheduling' },
  billing: { ar: 'الحسابات والفواتير', en: 'Billing' },
  complaints: { ar: 'الشكاوى', en: 'Complaints' },
  tech: { ar: 'الدعم التقني', en: 'Technical' },
  product: { ar: 'الاقتراحات', en: 'Product' },
  general: { ar: 'عام', en: 'General' },
};

export const TICKET_VISIBILITIES = ['normal', 'restricted'] as const;
export type TicketVisibility = (typeof TICKET_VISIBILITIES)[number];

/** First-response SLA state: `met` once answered; `none` without a deadline or once closed. */
export const SLA_STATES = ['ok', 'due_soon', 'breached', 'met', 'none'] as const;
export type SlaState = (typeof SLA_STATES)[number];
export const SLA_STATE_LABELS: Labels<SlaState> = {
  ok: { ar: 'في الوقت', en: 'On time' },
  due_soon: { ar: 'يقترب موعد الرد', en: 'Due soon' },
  breached: { ar: 'متأخر', en: 'Overdue' },
  met: { ar: 'تم الرد', en: 'Answered' },
  none: { ar: '—', en: '—' },
};
/** Minutes before the deadline when an item counts as "due soon". */
export const SLA_DUE_SOON_MINUTES = 60;

/** One timeline row: a comment or a status / priority / assignment / system change. */
export const TICKET_COMMENT_KINDS = [
  'comment',
  'status',
  'priority',
  'assignment',
  'system',
] as const;
export type TicketCommentKind = (typeof TICKET_COMMENT_KINDS)[number];

export const TICKET_ATTACHMENT_SOURCES = ['screenshot', 'upload', 'whatsapp'] as const;
export type TicketAttachmentSource = (typeof TICKET_ATTACHMENT_SOURCES)[number];

/** Upload rules (D102): images only, private storage, never served without a session. */
export const TICKET_UPLOAD_LIMITS = {
  /** PNG, JPEG, WebP (checked from the bytes, not the file name). SVG is refused. */
  imageMimes: ['image/png', 'image/jpeg', 'image/webp'],
  maxImageBytes: 5 * 1024 * 1024,
  /** Per request: one screenshot plus this many `attachments`. */
  maxImagesPerRequest: 3,
  maxAttachmentsPerTicket: 10,
} as const;

// ------------------------------------------------------------------ requests

/**
 * The client context sent with a report (docs/22 §5.1). The server keeps only these keys, caps the
 * strings and strips secrets from `pageUrl` queries; `recentErrors` is staff-only on reads.
 */
export const ticketContextSchema = z
  .object({
    pageUrl: z.string().optional(),
    route: z.string().optional(),
    appVersion: z.string().optional(),
    userAgent: z.string().optional(),
    platform: z.string().optional(),
    viewport: z.string().optional(),
    screen: z.string().optional(),
    timeZone: z.string().optional(),
    displayZone: z.string().optional(),
    locale: z.string().optional(),
    portal: z.string().optional(),
    area: z.string().optional(),
    online: z.boolean().optional(),
    touch: z.boolean().optional(),
    recentErrors: z
      .array(
        z.object({
          method: z.string().optional(),
          path: z.string().optional(),
          status: z.number().optional(),
          requestId: z.string().optional(),
          at: z.string().optional(),
        }),
      )
      .optional(),
  })
  .partial();
export type TicketContext = z.infer<typeof ticketContextSchema>;

/** Multipart sends every field as text: these accept both forms. */
const formId = z.preprocess((v) => (v === '' ? undefined : v), queryId.optional());
const formJson = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  if (v === '') return undefined;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}, z.record(z.string(), z.unknown()).optional());
const blankToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);

/**
 * `POST /feedback/tickets` — JSON or `multipart/form-data` with files `screenshot` (one) and
 * `attachments` (up to 3). `category` wins over the legacy `type`; `subcategory` must belong to the
 * category; `subjectType` + `subjectId` must be in the reporter's own scope (a family: its
 * children's classes and children; a teacher: own classes and students, never invoices). Only
 * staff may send `channel` and `familyId` (filing on someone's behalf). 422 per field otherwise;
 * 429 after 10 tickets an hour / 30 a day.
 */
export const createTicketSchema = z.object({
  type: z.preprocess(blankToUndefined, z.enum(TICKET_TYPES).optional()),
  category: z.preprocess(blankToUndefined, z.enum(TICKET_CATEGORIES).optional()),
  subcategory: z.preprocess(blankToUndefined, z.string().trim().max(40).optional()),
  subjectType: z.preprocess(blankToUndefined, z.enum(TICKET_SUBJECT_TYPES).optional()),
  subjectId: formId,
  channel: z.preprocess(blankToUndefined, z.enum(STAFF_TICKET_CHANNELS).optional()),
  familyId: formId,
  description: z.string().trim().min(10).max(5000),
  context: formJson,
  /**
   * S3: the structured part of a typed request (`REQUEST_PAYLOAD_SCHEMAS[subcategory]`), as JSON
   * in a form field. Optional: without it the ticket stays a plain message.
   */
  request: formJson,
});
export type CreateTicketInput = z.input<typeof createTicketSchema>;

/**
 * `PATCH /feedback/tickets/:id` (triage: `feedback.manage`, or `support.handle` in the ticket's
 * queue). Lifecycle refusals are 422 on the field: `status` (not allowed from the current one),
 * `note` (needs_info / wont_fix), `priority` (none yet), `prUrl` (a technical fix needs its PR),
 * `assigneeId` (cannot handle the queue or see the ticket), `duplicateOfId` (itself).
 */
export const updateTicketSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).nullable().optional(),
  type: z.enum(TICKET_TYPES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  queue: z.enum(TICKET_QUEUES).optional(),
  area: z
    .string()
    .regex(/^[a-z0-9_-]{1,40}$/)
    .nullable()
    .optional(),
  title: z.string().trim().min(3).max(160).optional(),
  assigneeId: id.nullable().optional(),
  prUrl: z
    .string()
    .trim()
    .max(300)
    .regex(/^https:\/\/github\.com\/qarabicacademy\/[A-Za-z0-9_.-]+\/pull\/\d+$/)
    .nullable()
    .optional(),
  resolution: z.string().trim().max(2000).nullable().optional(),
  duplicateOfId: id.nullable().optional(),
  /** Public note with a status change; an internal remark without one. */
  note: z.string().trim().max(2000).nullable().optional(),
});
export type UpdateTicketInput = z.input<typeof updateTicketSchema>;

/**
 * `POST /feedback/tickets/:id/comments` — JSON or multipart (`attachments`, up to 3 images).
 * `internal` is honoured only for people who manage the ticket. A reporter cannot reply on a
 * closed ticket (422 `body`). A reporter's reply moves `needs_info` back to `triaged`.
 */
export const createTicketCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  internal: z
    .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
    .transform((v) => v === true || v === '1' || v === 'true')
    .optional(),
});
export type CreateTicketCommentInput = z.input<typeof createTicketCommentSchema>;

/** `POST /feedback/tickets/:id/confirm` (reporter, on a fixed ticket): `body` when not resolved. */
export const confirmTicketSchema = z
  .object({
    resolved: z.boolean(),
    body: z.string().trim().max(2000).optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.resolved && !v.body) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'Tell us what still happens.' });
    }
  });
export type ConfirmTicketInput = z.input<typeof confirmTicketSchema>;

/**
 * `GET /feedback/tickets`: the reporter's own («طلباتي», `scope=mine`) or all for
 * `feedback.review` (the triage board, default for them). `status` also takes `open` / `closed`;
 * `priority` also `none`; `assigneeId` also `none`. `meta.counts` per status ignores `status`.
 */
export const ticketListQuerySchema = z.object({
  scope: z.enum(['mine', 'all']).optional(),
  status: queryList(z.enum([...TICKET_STATUSES, 'open', 'closed'])).optional(),
  priority: queryList(z.enum([...TICKET_PRIORITIES, 'none'])).optional(),
  type: queryList(z.enum(TICKET_TYPES)).optional(),
  category: queryList(z.enum(TICKET_CATEGORIES)).optional(),
  channel: z.enum(TICKET_CHANNELS).optional(),
  queue: z.enum(TICKET_QUEUES).optional(),
  assigneeId: z.union([z.literal('none'), queryId]).optional(),
  area: z.string().max(40).optional(),
  /** Title / description text, or `#12` / `12` for a ticket number. */
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['newest', 'priority', 'updated']).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});
export type TicketListQuery = z.input<typeof ticketListQuerySchema>;

// ------------------------------------------------------------------ responses

const ref = z.object({ id: z.number().int(), name: z.string().nullable() });

export const ticketAttachmentSchema = z.object({
  id: z.number().int(),
  source: z.enum(TICKET_ATTACHMENT_SOURCES),
  mime: z.string(),
  size: z.number().int(),
  name: z.string().nullable(),
  commentId: z.number().int().nullable(),
  /** false once the file was pruned (the ticket closed long ago). */
  available: z.boolean(),
  /** `/api/v1/feedback/attachments/:id` (needs the session; private, no-sniff, sandboxed). */
  url: z.string().nullable(),
  createdAt: z.string(),
});
export type TicketAttachmentDto = z.infer<typeof ticketAttachmentSchema>;

export const ticketCommentSchema = z.object({
  id: z.number().int(),
  kind: z.enum(TICKET_COMMENT_KINDS),
  body: z.string().nullable(),
  internal: z.boolean(),
  /** Status rows: `{ from, to, byReporter? }`. Staff also get `field`, assignment names … */
  meta: z.record(z.string(), z.unknown()),
  author: ref.nullable(),
  /** "Claude" (CLI) or the WhatsApp sender when there is no user. */
  authorLabel: z.string().nullable(),
  byReporter: z.boolean(),
  attachments: z.array(ticketAttachmentSchema),
  createdAt: z.string(),
});
export type TicketCommentDto = z.infer<typeof ticketCommentSchema>;

/**
 * One shape for lists and detail. Staff fields (`assignee`, `prUrl`, the people, the triage dates)
 * only for `feedback.review` or members of the ticket's queue. Nobody gets the WhatsApp contact
 * phone (`hasContactPhone` only).
 */
export const ticketSchema = z.object({
  id: z.number().int(),
  /** `#12` */
  number: z.string(),
  channel: z.enum(TICKET_CHANNELS),
  type: z.enum(TICKET_TYPES),
  category: z.enum(TICKET_CATEGORIES),
  subcategory: z.string().nullable(),
  subject: z.object({ type: z.enum(TICKET_SUBJECT_TYPES), id: z.number().int() }).nullable(),
  status: z.enum(TICKET_STATUSES),
  priority: z.enum(TICKET_PRIORITIES).nullable(),
  title: z.string(),
  area: z.string().nullable(),
  resolution: z.string().nullable(),
  reporter: ref.extend({ role: z.string().nullable() }).nullable(),
  isMine: z.boolean(),
  /** Mine and changed since I last opened it (the «طلباتي» dot). */
  hasUpdate: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastPublicAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  attachmentsCount: z.number().int().optional(),
  queue: z.enum(TICKET_QUEUES),
  visibility: z.enum(TICKET_VISIBILITIES),
  slaDueAt: z.string().nullable(),
  slaState: z.enum(SLA_STATES),
  firstResponseAt: z.string().nullable(),
  /** Who handles it, first name only (docs/22 §10). */
  handledBy: z.string().nullable(),
  // staff only
  assignee: ref.nullable().optional(),
  prUrl: z.string().nullable().optional(),
  duplicateOfId: z.number().int().nullable().optional(),
  triagedAt: z.string().nullable().optional(),
  fixedAt: z.string().nullable().optional(),
  verifiedAt: z.string().nullable().optional(),
  hasContactPhone: z.boolean().optional(),
  family: ref.nullable().optional(),
  teacher: ref.nullable().optional(),
  /** S3 typed request (schedule / teacher change, pause or stop, invoice question). */
  request: supportRequestSchema.nullable().default(null),
});
export type TicketDto = z.infer<typeof ticketSchema>;

export const ticketDetailSchema = ticketSchema.extend({
  description: z.string(),
  /** Without `recentErrors` / `userAgent` for non-staff. */
  context: z.record(z.string(), z.unknown()),
  /** Internal rows for staff only. */
  timeline: z.array(ticketCommentSchema),
  attachments: z.array(ticketAttachmentSchema),
  can: z.object({
    manage: z.boolean(),
    comment: z.boolean(),
    commentInternal: z.boolean(),
    confirm: z.boolean(),
    nextStatuses: z.array(z.enum(TICKET_STATUSES)),
  }),
});
export type TicketDetailDto = z.infer<typeof ticketDetailSchema>;

export const ticketListMetaSchema = z.object({
  page: z.number().int(),
  perPage: z.number().int(),
  total: z.number().int(),
  lastPage: z.number().int(),
  /** Per status (`all` + each), same filters minus `status`. */
  counts: z.record(z.string(), z.number().int()),
  scope: z.enum(['mine', 'all']),
});
export const ticketListResponseSchema = z.object({
  data: z.array(ticketSchema),
  meta: ticketListMetaSchema,
});
export type TicketListResponse = z.infer<typeof ticketListResponseSchema>;

/** `GET /feedback/summary`: menu badges (docs/22 §6). `triageNew` is null without `feedback.review`. */
export const feedbackSummarySchema = z.object({
  mineUpdates: z.number().int(),
  triageNew: z.number().int().nullable(),
});
export type FeedbackSummaryDto = z.infer<typeof feedbackSummarySchema>;
