import { z } from 'zod';
import { paginatedSchema } from './people.js';
import { ROLES } from './permissions.js';

/**
 * Internal operations (M8; docs/09 M16–M18, docs/03 §11–13): tasks (given / issued), announcements,
 * the notification centre (in-app + email; WhatsApp behind a flag, off until B50) with per-kind
 * preferences, class reminders, and the dashboard numbers. Complaints and class disputes are the
 * N4 support centre (restricted `complaints` queue, D99/D102): no second complaints module.
 *
 * `/api/v1/tasks…`, `/task-templates…`, `/announcements…`, `/me/notification-preferences`,
 * `/dashboard/summary`.
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

const id = z.number().int().positive();
const queryId = z.coerce.number().int().positive().max(2_147_483_647);
const page = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
};
const reasonText = z.string().trim().min(3).max(2000);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
const queryBool = z
  .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
  .transform((v) => v === true || v === '1' || v === 'true');

// ------------------------------------------------------------------ tasks

/** Old system: Pending → Awaiting (done, waiting for the issuer) → Completed; or Closed. */
export const TASK_STATUSES = ['pending', 'awaiting', 'completed', 'closed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Labels<TaskStatus> = {
  pending: { ar: 'قيد التنفيذ', en: 'Pending' },
  awaiting: { ar: 'بانتظار المراجعة', en: 'Awaiting review' },
  completed: { ar: 'مكتملة', en: 'Completed' },
  closed: { ar: 'مغلقة', en: 'Closed' },
};
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['pending', 'awaiting'];

export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const TASK_PRIORITY_LABELS: Labels<TaskPriority> = {
  low: { ar: 'منخفضة', en: 'Low' },
  normal: { ar: 'عادية', en: 'Normal' },
  high: { ar: 'عالية', en: 'High' },
};

/** What a task is about (a link shown on the task and a Tasks tab on the record). */
export const TASK_SUBJECT_TYPES = [
  'family',
  'student',
  'teacher',
  'lead',
  'session',
  'invoice',
] as const;
export type TaskSubjectType = (typeof TASK_SUBJECT_TYPES)[number];

export const TASK_BOXES = ['given', 'issued', 'all'] as const;
export type TaskBox = (typeof TASK_BOXES)[number];
export const TASK_BOX_LABELS: Labels<TaskBox> = {
  given: { ar: 'المهام المسندة إليّ', en: 'Given to me' },
  issued: { ar: 'المهام التي أصدرتها', en: 'Issued by me' },
  all: { ar: 'كل المهام', en: 'All tasks' },
};

export const TASK_EVENT_KINDS = ['comment', 'created', 'status', 'reassigned', 'updated'] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

const person = z.object({ id, name: z.string() });

export const taskSchema = z.object({
  id,
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  dueAt: z.string().nullable(),
  overdue: z.boolean(),
  assignee: person,
  createdBy: person,
  subjectType: z.enum(TASK_SUBJECT_TYPES).nullable(),
  subjectId: id.nullable(),
  submittedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  closeReason: z.string().nullable(),
  comments: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** What the viewer may do now. */
  can: z.object({
    edit: z.boolean(),
    reassign: z.boolean(),
    submit: z.boolean(),
    complete: z.boolean(),
    reopen: z.boolean(),
    close: z.boolean(),
  }),
});
export type TaskDto = z.infer<typeof taskSchema>;
export const taskListResponseSchema = paginatedSchema(taskSchema);

export const taskEventSchema = z.object({
  id,
  kind: z.enum(TASK_EVENT_KINDS),
  body: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  author: person.nullable(),
  createdAt: z.string(),
});
export type TaskEventDto = z.infer<typeof taskEventSchema>;
export const taskDetailSchema = taskSchema.extend({ events: z.array(taskEventSchema) });
export type TaskDetailDto = z.infer<typeof taskDetailSchema>;

export const taskListQuerySchema = z.object({
  box: z.enum(TASK_BOXES).default('given'),
  status: z.enum([...TASK_STATUSES, 'open'] as const).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  overdue: queryBool.optional(),
  assigneeId: queryId.optional(),
  subjectType: z.enum(TASK_SUBJECT_TYPES).optional(),
  subjectId: queryId.optional(),
  q: z.string().trim().max(100).optional(),
  ...page,
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

const dueAtSchema = z.iso.datetime({ offset: true }).nullable().optional();

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: optionalText(5000),
    assigneeId: id,
    priority: z.enum(TASK_PRIORITIES).default('normal'),
    dueAt: dueAtSchema,
    subjectType: z.enum(TASK_SUBJECT_TYPES).nullable().optional(),
    subjectId: id.nullable().optional(),
    templateId: id.optional(),
  })
  .refine((v) => Boolean(v.subjectType) === Boolean(v.subjectId), {
    message: 'Give both the subject type and its id, or neither.',
    path: ['subjectId'],
  });
export type CreateTaskInput = z.input<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: optionalText(5000),
    priority: z.enum(TASK_PRIORITIES),
    dueAt: dueAtSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });

export const reassignTaskSchema = z.object({ assigneeId: id, note: optionalText(2000) });
export const taskNoteSchema = z.object({ note: optionalText(2000) });
export const taskReasonSchema = z.object({ reason: reasonText });
export const taskCommentSchema = z.object({ body: z.string().trim().min(1).max(5000) });

export const taskTemplateSchema = z.object({
  id,
  title: z.string(),
  description: z.string().nullable(),
  priority: z.enum(TASK_PRIORITIES),
  dueInDays: z.number().int().nullable(),
  isActive: z.boolean(),
});
export type TaskTemplateDto = z.infer<typeof taskTemplateSchema>;
export const saveTaskTemplateSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: optionalText(5000),
  priority: z.enum(TASK_PRIORITIES).default('normal'),
  dueInDays: z.number().int().min(0).max(365).nullable().optional(),
  isActive: z.boolean().default(true),
});

/** People a task can be given to (active staff). */
export const taskAssigneeSchema = z.object({ id, name: z.string(), role: z.string().nullable() });
export type TaskAssigneeDto = z.infer<typeof taskAssigneeSchema>;

// ------------------------------------------------------------------ announcements

/** Who sees an announcement: roles (system or custom role names), or every staff member. */
export const ANNOUNCEMENT_STATUSES = ['draft', 'published', 'archived'] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];
export const ANNOUNCEMENT_STATUS_LABELS: Labels<AnnouncementStatus> = {
  draft: { ar: 'مسودة', en: 'Draft' },
  published: { ar: 'منشور', en: 'Published' },
  archived: { ar: 'مؤرشف', en: 'Archived' },
};

export const announcementSchema = z.object({
  id,
  title: z.string(),
  body: z.string(),
  /** Role names; empty = every role that has `announcements.view`. */
  audience: z.array(z.string()),
  pinned: z.boolean(),
  status: z.enum(ANNOUNCEMENT_STATUSES),
  publishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdBy: person.nullable(),
  /** For the viewer. */
  read: z.boolean(),
  /** Managers only: how many of the audience read it. */
  readCount: z.number().int().nullable(),
  createdAt: z.string(),
});
export type AnnouncementDto = z.infer<typeof announcementSchema>;
export const announcementListResponseSchema = paginatedSchema(announcementSchema);

export const announcementListQuerySchema = z.object({
  /** `current` = what the viewer should see now; `manage` (announcements.manage) = every one. */
  scope: z.enum(['current', 'manage']).default('current'),
  status: z.enum(ANNOUNCEMENT_STATUSES).optional(),
  unread: queryBool.optional(),
  q: z.string().trim().max(100).optional(),
  ...page,
});
export type AnnouncementListQuery = z.infer<typeof announcementListQuerySchema>;

const audienceSchema = z.array(z.string().trim().min(1).max(64)).max(ROLES.length + 50);

export const saveAnnouncementSchema = z.object({
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(3).max(10_000),
  audience: audienceSchema.default([]),
  pinned: z.boolean().default(false),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export const updateAnnouncementSchema = saveAnnouncementSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });

// ------------------------------------------------------------------ notification centre

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'push', 'whatsapp'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export const NOTIFICATION_CHANNEL_LABELS: Labels<NotificationChannel> = {
  in_app: { ar: 'داخل النظام', en: 'In the app' },
  email: { ar: 'البريد الإلكتروني', en: 'Email' },
  push: { ar: 'إشعارات تطبيق الجوال', en: 'Mobile app push' },
  whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
};

/** Notification kinds a person can tune (`notifications.kind`). */
export const NOTIFICATION_KINDS = ['task', 'announcement', 'class_reminder', 'lead'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const NOTIFICATION_KIND_LABELS: Labels<NotificationKind> = {
  task: { ar: 'المهام', en: 'Tasks' },
  announcement: { ar: 'الإعلانات', en: 'Announcements' },
  class_reminder: { ar: 'التذكير قبل الحصة', en: 'Class reminders' },
  lead: { ar: 'العملاء المحتملون', en: 'Leads' },
};
/** Defaults when a person has not chosen: in-app on, email off, WhatsApp off. */
export const NOTIFICATION_DEFAULTS: Record<NotificationChannel, boolean> = {
  in_app: true,
  email: false,
  /** Only reaches people who registered a phone (`/me/devices`). */
  push: true,
  whatsapp: false,
};

export const TASK_NOTIFICATION_EVENTS = [
  'assigned',
  'submitted',
  'completed',
  'reopened',
  'closed',
  'commented',
  'due_soon',
] as const;
export const ANNOUNCEMENT_NOTIFICATION_EVENTS = ['published'] as const;
export const CLASS_REMINDER_EVENTS = ['upcoming'] as const;

export const notificationPreferenceSchema = z.object({
  kind: z.enum(NOTIFICATION_KINDS),
  inApp: z.boolean(),
  email: z.boolean(),
  /** Mobile push (docs/17 §5); optional on input for older clients (default on). */
  push: z.boolean().default(true),
  whatsapp: z.boolean(),
});
export type NotificationPreferenceDto = z.infer<typeof notificationPreferenceSchema>;

export const notificationPreferencesResponseSchema = z.object({
  data: z.array(notificationPreferenceSchema),
  /** Channels switched on for the academy (email / WhatsApp may be off globally, D140, B50). */
  channels: z.record(z.enum(NOTIFICATION_CHANNELS), z.boolean()),
});
export type NotificationPreferencesResponse = z.infer<typeof notificationPreferencesResponseSchema>;

export const saveNotificationPreferencesSchema = z.object({
  preferences: z.array(notificationPreferenceSchema).min(1).max(NOTIFICATION_KINDS.length),
});

// ------------------------------------------------------------------ dashboard

/** One number on the dashboard; only blocks the viewer's permissions allow are present. */
export const dashboardSummarySchema = z.object({
  generatedAt: z.string(),
  today: z.string(),
  people: z
    .object({ families: z.number().int(), students: z.number().int(), teachers: z.number().int() })
    .nullable(),
  classesToday: z.record(z.string(), z.number().int()).nullable(),
  queues: z.object({
    myTasks: z.number().int().nullable(),
    myOverdueTasks: z.number().int().nullable(),
    sessionRequests: z.number().int().nullable(),
    leaveRequests: z.number().int().nullable(),
    proposedFines: z.number().int().nullable(),
    newLeads: z.number().int().nullable(),
    trialsToday: z.number().int().nullable(),
    openTickets: z.number().int().nullable(),
    openComplaints: z.number().int().nullable(),
    unreadAnnouncements: z.number().int().nullable(),
  }),
  finance: z
    .object({
      overdueInvoices: z.array(
        z.object({ currency: z.string(), count: z.number().int(), amount: z.string() }),
      ),
      receivedThisMonth: z.array(z.object({ currency: z.string(), amount: z.string() })),
      payrollAwaitingApproval: z.number().int(),
      ledgerPending: z.number().int().nullable(),
    })
    .nullable(),
});
export type DashboardSummaryDto = z.infer<typeof dashboardSummarySchema>;

export const OPERATIONS_ERROR_MESSAGES = {
  invalid_task_status: {
    ar: 'لا يمكن تنفيذ هذا الإجراء على المهمة في حالتها الحالية.',
    en: 'This action is not allowed for the task in its current status.',
  },
  assignee_invalid: {
    ar: 'يجب أن يكون المكلّف موظفًا نشطًا.',
    en: 'The assignee must be an active staff member.',
  },
  not_allowed: {
    ar: 'لا تملك صلاحية تنفيذ هذا الإجراء على هذه المهمة.',
    en: 'You may not do this on this task.',
  },
  same_assignee: {
    ar: 'المهمة مسندة بالفعل إلى هذا الشخص.',
    en: 'The task is already given to this person.',
  },
  audience_invalid: {
    ar: 'يوجد دور غير معروف في الجمهور.',
    en: 'The audience has an unknown role.',
  },
  invalid_announcement_status: {
    ar: 'لا يمكن تنفيذ هذا الإجراء على الإعلان في حالته الحالية.',
    en: 'This action is not allowed for the announcement in its current status.',
  },
} as const;
export type OperationsErrorCode = keyof typeof OPERATIONS_ERROR_MESSAGES;
