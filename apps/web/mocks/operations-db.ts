import type {
  AnnouncementStatus,
  NotificationKind,
  TaskEventKind,
  TaskPriority,
  TaskStatus,
  TaskSubjectType,
} from '@qarabic/shared';

/**
 * The mock store for M8 (apps/api `operations/`): tasks between the demo staff (admin 1, monitor
 * 12, accounts 13) with their timelines, task templates, announcements with read receipts and the
 * per-person notification preferences. Times are relative to the page clock. Fake data only.
 */
type Person = { id: number; name: string };
export type EventRow = {
  id: number;
  kind: TaskEventKind;
  body: string | null;
  data: Record<string, unknown>;
  author: Person | null;
  createdAt: string;
};
export type TaskRow = {
  id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  assignee: Person;
  createdBy: Person;
  subjectType: TaskSubjectType | null;
  subjectId: number | null;
  submittedAt: string | null;
  completedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  createdAt: string;
  updatedAt: string;
  events: EventRow[];
};
export type TemplateRow = {
  id: number;
  title: string;
  description: string | null;
  priority: TaskPriority;
  dueInDays: number | null;
  isActive: boolean;
};
export type AnnouncementRow = {
  id: number;
  title: string;
  body: string;
  audience: string[];
  pinned: boolean;
  status: AnnouncementStatus;
  publishedAt: string | null;
  expiresAt: string | null;
  createdBy: Person | null;
  createdAt: string;
  readBy: Set<number>;
};
export type PrefRow = { inApp: boolean; email: boolean; push: boolean; whatsapp: boolean };

export const STAFF = {
  admin: { id: 1, name: 'مدير النظام' },
  monitor: { id: 12, name: 'Rana Monitor' },
  accounts: { id: 13, name: 'Accounts Officer' },
} as const;

type Db = {
  tasks: TaskRow[];
  templates: TemplateRow[];
  announcements: AnnouncementRow[];
  prefs: Map<number, Partial<Record<NotificationKind, PrefRow>>>;
  seq: { task: number; event: number; template: number; announcement: number };
};

const empty = (): Db => ({
  tasks: [],
  templates: [],
  announcements: [],
  prefs: new Map(),
  seq: { task: 0, event: 0, template: 0, announcement: 0 },
});

export let odb: Db = empty();

const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

export function addEvent(
  t: TaskRow,
  kind: TaskEventKind,
  author: Person | null,
  body: string | null = null,
  data: Record<string, unknown> = {},
  createdAt = new Date().toISOString(),
) {
  t.events.push({ id: ++odb.seq.event, kind, body, data, author, createdAt });
  t.updatedAt = createdAt;
}

function task(
  db: Db,
  p: Partial<TaskRow> & Pick<TaskRow, 'title' | 'assignee' | 'createdBy'>,
  createdHoursAgo: number,
): TaskRow {
  const createdAt = at(-createdHoursAgo);
  const row: TaskRow = {
    id: ++db.seq.task,
    description: null,
    status: 'pending',
    priority: 'normal',
    dueAt: null,
    subjectType: null,
    subjectId: null,
    submittedAt: null,
    completedAt: null,
    closedAt: null,
    closeReason: null,
    createdAt,
    updatedAt: createdAt,
    events: [],
    ...p,
  };
  db.tasks.push(row);
  addEvent(row, 'created', row.createdBy, null, {}, createdAt);
  return row;
}

function build(): Db {
  const db = empty();
  odb = db;
  const { admin, monitor, accounts } = STAFF;
  const t1 = task(
    db,
    {
      title: 'اتصل بأسرة Hassan لتأكيد الجدول الجديد',
      description: 'تأكد من موعد الثلاثاء بعد تغيير المعلم، وسجّل الرد في ملف الأسرة.',
      assignee: monitor,
      createdBy: admin,
      priority: 'high',
      dueAt: at(20),
      subjectType: 'family',
      subjectId: 1,
    },
    5,
  );
  addEvent(t1, 'comment', monitor, 'اتصلت مرة ولم يرد أحد، سأعيد المحاولة مساءً.', {}, at(-2));
  task(
    db,
    {
      title: 'إقفال حسابات الشهر الماضي',
      description: 'راجع القيود التلقائية المنتظرة ثم أقفل الفترة.',
      assignee: accounts,
      createdBy: admin,
      priority: 'high',
      dueAt: at(-26),
    },
    72,
  );
  const t3 = task(
    db,
    {
      title: 'مراجعة فاتورة أسرة Ali المقسّمة',
      assignee: accounts,
      createdBy: monitor,
      status: 'awaiting',
      submittedAt: at(-1),
      dueAt: at(48),
      subjectType: 'invoice',
      subjectId: 3,
    },
    30,
  );
  addEvent(
    t3,
    'status',
    accounts,
    'تمت المراجعة، المبالغ صحيحة.',
    { from: 'pending', to: 'awaiting' },
    at(-1),
  );
  task(
    db,
    {
      title: 'تحديث قائمة العطلات الرسمية لعام 2027',
      assignee: admin,
      createdBy: admin,
      priority: 'low',
    },
    10,
  );
  const t5 = task(
    db,
    {
      title: 'تجهيز تقرير الحضور الأسبوعي',
      assignee: monitor,
      createdBy: admin,
      status: 'completed',
      submittedAt: at(-30),
      completedAt: at(-28),
    },
    50,
  );
  addEvent(t5, 'status', monitor, null, { from: 'pending', to: 'awaiting' }, at(-30));
  addEvent(t5, 'status', admin, 'شكرًا.', { from: 'awaiting', to: 'completed' }, at(-28));
  const t6 = task(
    db,
    {
      title: 'نقل طالب إلى معلم آخر',
      assignee: monitor,
      createdBy: admin,
      status: 'closed',
      closedAt: at(-40),
      closeReason: 'طلبت الأسرة البقاء مع المعلم الحالي.',
    },
    60,
  );
  addEvent(
    t6,
    'status',
    admin,
    'طلبت الأسرة البقاء مع المعلم الحالي.',
    { from: 'pending', to: 'closed' },
    at(-40),
  );
  task(
    db,
    { title: 'متابعة طلب إجازة المعلم Ahmed', assignee: admin, createdBy: monitor, dueAt: at(4) },
    3,
  );

  db.templates.push(
    {
      id: ++db.seq.template,
      title: 'اتصال متابعة بأسرة',
      description: 'اتصل بالأسرة وسجّل الرد.',
      priority: 'normal',
      dueInDays: 1,
      isActive: true,
    },
    {
      id: ++db.seq.template,
      title: 'مراجعة فاتورة',
      description: null,
      priority: 'normal',
      dueInDays: 3,
      isActive: true,
    },
    {
      id: ++db.seq.template,
      title: 'اختبار مستوى طالب جديد',
      description: null,
      priority: 'high',
      dueInDays: 2,
      isActive: true,
    },
  );

  const ann = (p: Partial<AnnouncementRow> & Pick<AnnouncementRow, 'title' | 'body'>) => {
    const row: AnnouncementRow = {
      id: ++db.seq.announcement,
      audience: [],
      pinned: false,
      status: 'published',
      publishedAt: at(-24),
      expiresAt: null,
      createdBy: admin,
      createdAt: at(-30),
      readBy: new Set(),
      ...p,
    };
    db.announcements.push(row);
    return row;
  };
  ann({
    title: 'تحديث سياسة الإجازات',
    body: 'يُقدَّم طلب الإجازة قبل الموعد بـ 48 ساعة على الأقل من صفحة «حضوري وإجازاتي». الطلبات المتأخرة تحتاج موافقة المدير.',
    pinned: true,
    publishedAt: at(-48),
  });
  ann({
    title: 'تدريب المعلمين يوم الخميس',
    body: 'جلسة تدريبية عن تقارير الحصص الجديدة يوم الخميس الساعة 7 مساءً بتوقيت القاهرة.',
    audience: ['teacher'],
    publishedAt: at(-6),
  }).readBy.add(1);
  ann({
    title: 'إجازة نصف العام',
    body: 'تتوقف الحصص من 1 إلى 7 فبراير، وتُرسل الجداول البديلة للأسر قبلها بأسبوع.',
    audience: ['parent', 'teacher', 'monitor', 'manager', 'senior_manager', 'csr'],
    publishedAt: at(-3),
  });
  ann({
    title: 'جدول مناوبات المشرفين لشهر ديسمبر',
    body: 'مسودة: تُراجع قبل النشر.',
    status: 'draft',
    publishedAt: null,
  });
  ann({
    title: 'صيانة النظام القديم',
    body: 'انتهت الصيانة.',
    status: 'archived',
    publishedAt: at(-200),
  });
  return db;
}

export function resetOperationsDb() {
  odb = build();
}

resetOperationsDb();
