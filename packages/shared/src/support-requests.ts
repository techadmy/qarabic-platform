import { z } from 'zod';

/**
 * Typed support requests, step S3 of docs/32 (§3 #4–#7, B75): a weekly schedule change, a teacher
 * change, a pause or stop, and an invoice question each carry a structured `request` payload on
 * the «تواصل معنا» ticket, and a small life of their own (`requestState`):
 *
 * - teacher change: submitted → proposed (staff propose a teacher from a date) → accepted /
 *   declined by the family → done (staff reassigned the enrollment); declined → proposed again;
 * - the others: submitted → approved (staff confirm, e.g. after the retention call) → done;
 * - any open one → rejected (with a note).
 *
 * The change itself is made with the existing tools (enrollment editor, pause / end, invoice);
 * «done» records it. The current teacher never sees a teacher-change request.
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

const id = z.number().int().positive();
const date = z.iso.date();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.');
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optionalText = (max: number) =>
  z.preprocess(blankToNull, z.string().trim().max(max).nullable()).optional();

export const TYPED_REQUESTS = [
  'schedule_change',
  'teacher_change',
  'subscription_change',
  'invoice_question',
] as const;
export type TypedRequest = (typeof TYPED_REQUESTS)[number];
export const isTypedRequest = (v: unknown): v is TypedRequest =>
  typeof v === 'string' && (TYPED_REQUESTS as readonly string[]).includes(v);

export const TEACHER_CHANGE_REASONS = [
  'level',
  'teaching_style',
  'punctuality',
  'language',
  'schedule',
  'other',
] as const;
export const TEACHER_CHANGE_REASON_LABELS: Labels<(typeof TEACHER_CHANGE_REASONS)[number]> = {
  level: { ar: 'لا يناسب مستوى الطالب', en: 'Not the right level' },
  teaching_style: { ar: 'أسلوب التدريس', en: 'Teaching style' },
  punctuality: { ar: 'الالتزام بالمواعيد', en: 'Punctuality' },
  language: { ar: 'اللغة', en: 'Language' },
  schedule: { ar: 'المواعيد المتاحة', en: 'Available times' },
  other: { ar: 'سبب آخر', en: 'Other' },
};

export const SUBSCRIPTION_ACTIONS = ['pause', 'stop'] as const;
export const SUBSCRIPTION_REASONS = [
  'travel',
  'financial',
  'schedule',
  'satisfaction',
  'other',
] as const;
export const SUBSCRIPTION_REASON_LABELS: Labels<(typeof SUBSCRIPTION_REASONS)[number]> = {
  travel: { ar: 'سفر', en: 'Travel' },
  financial: { ar: 'أسباب مالية', en: 'Financial' },
  schedule: { ar: 'ضيق الوقت', en: 'No time' },
  satisfaction: { ar: 'غير راضين عن الخدمة', en: 'Not satisfied' },
  other: { ar: 'سبب آخر', en: 'Other' },
};

export const INVOICE_TOPICS = [
  'amount',
  'payment_not_reflected',
  'refund',
  'currency',
  'other',
] as const;
export const INVOICE_TOPIC_LABELS: Labels<(typeof INVOICE_TOPICS)[number]> = {
  amount: { ar: 'قيمة الفاتورة', en: 'The amount' },
  payment_not_reflected: { ar: 'دفعت ولم تظهر الدفعة', en: 'Payment not showing' },
  refund: { ar: 'استرداد مبلغ', en: 'A refund' },
  currency: { ar: 'العملة', en: 'The currency' },
  other: { ar: 'أخرى', en: 'Other' },
};

/** The payload of each typed request (validated by the subcategory). */
export const REQUEST_PAYLOAD_SCHEMAS = {
  schedule_change: z.object({
    studentId: id,
    /** The new weekly times, in `timezone` (the family's zone by default). */
    slots: z
      .array(z.object({ weekday: z.number().int().min(1).max(7), localTime: time }))
      .min(1)
      .max(7),
    startsOn: date,
    timezone: z.string().max(64).optional(),
  }),
  teacher_change: z.object({
    studentId: id,
    reason: z.enum(TEACHER_CHANGE_REASONS),
    preferredGender: z.enum(['male', 'female']).nullable().optional(),
    preferredTimes: optionalText(300),
  }),
  subscription_change: z
    .object({
      action: z.enum(SUBSCRIPTION_ACTIONS),
      /** Empty = the whole family. */
      studentIds: z.array(id).max(20).default([]),
      from: date,
      /** Required for a pause. */
      to: date.nullable().optional(),
      reason: z.enum(SUBSCRIPTION_REASONS),
    })
    .superRefine((v, ctx) => {
      if (v.action === 'pause' && !v.to) {
        ctx.addIssue({ code: 'custom', path: ['to'], message: 'Give the end of the pause.' });
      }
      if (v.to && v.to < v.from) {
        ctx.addIssue({ code: 'custom', path: ['to'], message: 'The end is before the start.' });
      }
    }),
  /** The invoice itself is the ticket's subject (`subjectType: invoice`). */
  invoice_question: z.object({ topic: z.enum(INVOICE_TOPICS) }),
} as const satisfies Record<TypedRequest, z.ZodType>;

export type RequestPayload<T extends TypedRequest> = z.output<(typeof REQUEST_PAYLOAD_SCHEMAS)[T]>;

export const REQUEST_STATES = [
  'submitted',
  'proposed',
  'accepted',
  'declined',
  'approved',
  'rejected',
  'done',
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];
export const REQUEST_STATE_LABELS: Labels<RequestState> = {
  submitted: { ar: 'قيد المراجعة', en: 'Under review' },
  proposed: { ar: 'بانتظار موافقتك على الاقتراح', en: 'Waiting for your answer' },
  accepted: { ar: 'وافقت على الاقتراح', en: 'You accepted' },
  declined: { ar: 'رفضت الاقتراح', en: 'You declined' },
  approved: { ar: 'تمت الموافقة', en: 'Approved' },
  rejected: { ar: 'تعذّر تنفيذ الطلب', en: 'Not possible' },
  done: { ar: 'تم التنفيذ', en: 'Done' },
};

/** `POST /support/tickets/:id/request` (staff who handle the ticket's queue). */
export const requestActionSchema = z
  .object({
    action: z.enum(['propose', 'approve', 'reject', 'complete']),
    /** Shown to the family (required to reject). */
    note: optionalText(2000),
    /** Teacher change: who, and from when. */
    proposal: z.object({ teacherId: id, fromDate: date }).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'propose' && !v.proposal) {
      ctx.addIssue({ code: 'custom', path: ['proposal'], message: 'Propose a teacher.' });
    }
    if (v.action === 'reject' && !v.note) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'Say why.' });
    }
  });
export type RequestActionInput = z.input<typeof requestActionSchema>;

/** `POST /support/tickets/:id/request/answer` (the requester, on a proposal). */
export const requestAnswerSchema = z.object({ accept: z.boolean(), note: optionalText(2000) });
export type RequestAnswerInput = z.input<typeof requestAnswerSchema>;

/** What the viewer may do next: staff steps, or the requester's answer to a proposal. */
export const SUPPORT_REQUEST_ACTIONS = [
  'propose',
  'approve',
  'complete',
  'reject',
  'accept',
  'decline',
] as const;
export type SupportRequestAction = (typeof SUPPORT_REQUEST_ACTIONS)[number];

/** On the ticket (`ticketSchema.request`); null for a plain ticket. */
export const supportRequestSchema = z.object({
  kind: z.enum(TYPED_REQUESTS),
  state: z.enum(REQUEST_STATES),
  payload: z.record(z.string(), z.unknown()),
  /** Teacher change: the proposed teacher (name only) and the date. */
  proposal: z
    .object({
      teacher: z.object({ id: z.number().int(), name: z.string() }),
      fromDate: z.string(),
    })
    .nullable(),
  /** For this viewer (the server's state and permission rules); empty when nothing is open to them. */
  allowedActions: z.array(z.enum(SUPPORT_REQUEST_ACTIONS)).default([]),
  /** Who took the latest step and when (staff or the family). */
  decidedBy: z.object({ id: z.number().int(), name: z.string() }).nullable().default(null),
  decidedAt: z.string().nullable().default(null),
  /** The latest step's note (a rejection's reason, a decline's words); shown to the family. */
  note: z.string().nullable().default(null),
});
export type SupportRequestDto = z.infer<typeof supportRequestSchema>;
