import {
  CLOSED_TICKET_STATUSES,
  type SupportSettingsDto,
  type TicketAttachmentSource,
  type TicketCategory,
  type TicketChannel,
  type TicketCommentKind,
  type TicketPriority,
  type TicketQueue,
  type TicketStatus,
  type TicketSubjectType,
  type TicketType,
  type TicketVisibility,
  type SupportRequestDto,
} from '@qarabic/shared';
import { db as people } from './people-db';
import { sdb } from './schedule-db';

/**
 * In-memory «تواصل معنا» data for the MSW mocks (N4), built on the people and schedule mocks:
 * the demo parent's tickets (one fixed and waiting for their confirmation, one overdue, a complaint
 * about the demo teacher, one waiting for their reply, one closed), the demo teacher's technical
 * report with a screenshot, a ticket filed by staff for another family and a suggestion. Times are
 * relative to the clock when the mocks are built. Fake data only.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

export interface TicketRow {
  id: number;
  channel: TicketChannel;
  type: TicketType;
  category: TicketCategory;
  subcategory: string | null;
  subjectType: TicketSubjectType | null;
  subjectId: number | null;
  status: TicketStatus;
  priority: TicketPriority | null;
  title: string;
  description: string;
  area: string | null;
  resolution: string | null;
  reporter: { id: number; name: string; role: string | null } | null;
  familyId: number | null;
  teacherId: number | null;
  queue: TicketQueue;
  visibility: TicketVisibility;
  slaDueAt: string | null;
  firstResponseAt: string | null;
  assignee: { id: number; name: string } | null;
  prUrl: string | null;
  duplicateOfId: number | null;
  triagedAt: string | null;
  fixedAt: string | null;
  verifiedAt: string | null;
  closedAt: string | null;
  lastPublicAt: string | null;
  reporterSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  context: Record<string, unknown>;
  /** S3 typed request (schedule / teacher / subscription change, invoice question). */
  request?: SupportRequestDto | null;
}

export interface CommentRow {
  id: number;
  ticketId: number;
  kind: TicketCommentKind;
  body: string | null;
  internal: boolean;
  meta: Record<string, unknown>;
  author: { id: number; name: string } | null;
  authorLabel: string | null;
  createdAt: string;
}

export interface AttachmentRow {
  id: number;
  ticketId: number;
  commentId: number | null;
  source: TicketAttachmentSource;
  mime: string;
  size: number;
  name: string | null;
  blob: Blob | null;
  createdAt: string;
}

export interface SupportDb {
  tickets: TicketRow[];
  comments: CommentRow[];
  attachments: AttachmentRow[];
  settings: SupportSettingsDto;
  nextId: { ticket: number; comment: number; attachment: number };
}

export const SUPPORT_DEFAULTS: SupportSettingsDto = {
  'support.queue_by_category': {
    classes: 'scheduling',
    teacher: 'scheduling',
    'teacher.teacher_feedback': 'complaints',
    billing: 'billing',
    technical: 'tech',
    suggestion: 'product',
    other: 'general',
  },
  'support.queue_members': {
    scheduling: ['monitor', 'csr', 'manager'],
    billing: ['billing', 'accounts'],
    complaints: ['admin', 'senior_manager'],
    tech: ['admin'],
    product: ['admin'],
    general: ['csr'],
  },
  'support.restricted_queues': ['complaints'],
  'support.sla_hours': {
    scheduling: 4,
    billing: 12,
    complaints: 12,
    tech: 12,
    product: 60,
    general: 12,
  },
  'support.working_hours': {
    timezone: 'Africa/Cairo',
    days: [6, 7, 1, 2, 3, 4],
    start: '10:00',
    end: '22:00',
  },
};

export const isClosed = (s: TicketStatus) =>
  (CLOSED_TICKET_STATUSES as readonly string[]).includes(s);

/** A 1×1 PNG served for the seeded screenshot (mock mode has no real files). */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN4+vQpAAViArCRv9DsAAAAAElFTkSuQmCC';
export function pixelBlob(): Blob {
  const bytes = Uint8Array.from(atob(PIXEL), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

function build(): SupportDb {
  const now = Date.now();
  const parent = { id: 3, name: 'ولي أمر تجريبي', role: 'parent' };
  const teacherUser = { id: 2, name: 'معلم تجريبي', role: 'teacher' };
  const admin = { id: 1, name: 'مدير النظام' };
  const demoChildren = people.students.filter((s) => s.familyId === 1);
  const child = demoChildren[0];
  const pastClass = sdb.sessions
    .filter((s) => s.studentId === child?.id && Date.parse(s.startsAt) < now && !s.deleted)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0];
  const other = people.families.find((f) => f.id === 4) ?? people.families[1]!;
  const tickets: TicketRow[] = [];
  const comments: CommentRow[] = [];
  const attachments: AttachmentRow[] = [];
  let commentId = 1;
  const base = (id: number, o: Partial<TicketRow>): TicketRow => ({
    id,
    channel: 'in_app',
    type: 'feature',
    category: 'other',
    subcategory: null,
    subjectType: null,
    subjectId: null,
    status: 'new',
    priority: 'p2',
    title: '',
    description: '',
    area: null,
    resolution: null,
    reporter: parent,
    familyId: 1,
    teacherId: null,
    queue: 'general',
    visibility: 'normal',
    slaDueAt: null,
    firstResponseAt: null,
    assignee: null,
    prUrl: null,
    duplicateOfId: null,
    triagedAt: null,
    fixedAt: null,
    verifiedAt: null,
    closedAt: null,
    lastPublicAt: null,
    reporterSeenAt: null,
    createdAt: iso(now - 2 * HOUR),
    updatedAt: iso(now - 2 * HOUR),
    context: { pageUrl: '/', locale: 'ar', displayZone: 'Europe/London' },
    ...o,
  });
  const comment = (ticketId: number, o: Partial<CommentRow>) => {
    const row: CommentRow = {
      id: commentId++,
      ticketId,
      kind: 'comment',
      body: null,
      internal: false,
      meta: {},
      author: admin,
      authorLabel: null,
      createdAt: iso(now - HOUR),
      ...o,
    };
    comments.push(row);
    return row;
  };

  // 1. The demo parent's class problem, fixed and waiting for their confirmation (with news).
  tickets.push(
    base(1, {
      category: 'classes',
      subcategory: 'session_issue',
      subjectType: pastClass ? 'session' : null,
      subjectId: pastClass?.id ?? null,
      title: 'The meeting link did not open for the last class',
      description:
        'The meeting link did not open for the last class.\nWe waited ten minutes and then left.',
      status: 'fixed',
      priority: 'p1',
      queue: 'scheduling',
      teacherId: pastClass?.teacherId ?? 1,
      assignee: { id: 1, name: admin.name },
      slaDueAt: iso(now - 20 * HOUR),
      firstResponseAt: iso(now - 22 * HOUR),
      triagedAt: iso(now - 22 * HOUR),
      fixedAt: iso(now - 30 * MIN),
      resolution: 'We fixed the meeting link; the next class opens normally.',
      lastPublicAt: iso(now - 30 * MIN),
      reporterSeenAt: iso(now - 20 * HOUR),
      createdAt: iso(now - 24 * HOUR),
      updatedAt: iso(now - 30 * MIN),
    }),
  );
  comment(1, { body: 'Thank you, we are checking the link now.', createdAt: iso(now - 22 * HOUR) });
  comment(1, {
    kind: 'status',
    meta: { from: 'triaged', to: 'fixed' },
    body: 'We fixed the meeting link; the next class opens normally.',
    createdAt: iso(now - 30 * MIN),
  });
  comment(1, {
    body: 'Zoom host had expired; renewed.',
    internal: true,
    createdAt: iso(now - 40 * MIN),
  });

  // 2. An invoice question, overdue in «الحسابات والفواتير».
  tickets.push(
    base(2, {
      category: 'billing',
      subcategory: 'invoice_question',
      title: 'I paid the November invoice but it still shows unpaid',
      description: 'I paid the November invoice but it still shows unpaid.',
      queue: 'billing',
      slaDueAt: iso(now - 3 * HOUR),
      createdAt: iso(now - 30 * HOUR),
      updatedAt: iso(now - 30 * HOUR),
    }),
  );

  // 3. A complaint about the demo teacher: restricted, never shown to that teacher.
  tickets.push(
    base(3, {
      category: 'teacher',
      subcategory: 'teacher_feedback',
      subjectType: child ? 'student' : null,
      subjectId: child?.id ?? null,
      title: 'The teacher was late twice this week',
      description: 'The teacher was late twice this week and ended the class early.',
      priority: 'p1',
      queue: 'complaints',
      visibility: 'restricted',
      teacherId: 1,
      slaDueAt: iso(now + 6 * HOUR),
      createdAt: iso(now - 3 * HOUR),
      updatedAt: iso(now - 3 * HOUR),
    }),
  );

  // 4. The demo teacher's technical report, in progress, with a screenshot.
  tickets.push(
    base(4, {
      type: 'bug',
      category: 'technical',
      title: 'The week view does not scroll on my tablet',
      description: 'The week view does not scroll on my tablet; I cannot see Thursday.',
      status: 'in_progress',
      priority: 'p1',
      queue: 'tech',
      reporter: teacherUser,
      familyId: null,
      teacherId: 1,
      area: 'my-classes',
      assignee: { id: 1, name: admin.name },
      slaDueAt: iso(now - 26 * HOUR),
      firstResponseAt: iso(now - 27 * HOUR),
      triagedAt: iso(now - 27 * HOUR),
      lastPublicAt: iso(now - 27 * HOUR),
      reporterSeenAt: iso(now - 26 * HOUR),
      createdAt: iso(now - 28 * HOUR),
      updatedAt: iso(now - 27 * HOUR),
      context: {
        pageUrl: '/my-classes',
        route: '/my-classes',
        area: 'my-classes',
        appVersion: 'dev',
        platform: 'iPad',
        viewport: '820x1180',
        displayZone: 'Africa/Cairo',
        timeZone: 'Africa/Cairo',
        locale: 'ar',
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)',
        recentErrors: [{ method: 'GET', path: '/teacher-portal/week', status: 500 }],
      },
    }),
  );
  comment(4, {
    kind: 'status',
    meta: { from: 'triaged', to: 'in_progress' },
    createdAt: iso(now - 27 * HOUR),
  });
  attachments.push({
    id: 1,
    ticketId: 4,
    commentId: null,
    source: 'screenshot',
    mime: 'image/png',
    size: 68,
    name: 'screenshot.png',
    blob: null,
    createdAt: iso(now - 28 * HOUR),
  });

  // 5. A schedule change waiting for the parent's reply.
  tickets.push(
    base(5, {
      category: 'classes',
      subcategory: 'schedule_change',
      subjectType: demoChildren[1] ? 'student' : null,
      subjectId: demoChildren[1]?.id ?? null,
      title: 'Move Mariam’s classes to the evening',
      description: 'Please move Mariam’s classes to the evening from next week.',
      status: 'needs_info',
      priority: 'p2',
      queue: 'scheduling',
      assignee: { id: 1, name: admin.name },
      slaDueAt: iso(now - 5 * HOUR),
      firstResponseAt: iso(now - 6 * HOUR),
      triagedAt: iso(now - 6 * HOUR),
      lastPublicAt: iso(now - 6 * HOUR),
      reporterSeenAt: iso(now - 5 * HOUR),
      createdAt: iso(now - 8 * HOUR),
      updatedAt: iso(now - 6 * HOUR),
    }),
  );
  comment(5, {
    kind: 'status',
    meta: { from: 'triaged', to: 'needs_info' },
    body: 'Which days and times suit Mariam in the evening?',
    createdAt: iso(now - 6 * HOUR),
  });

  // 6. Filed by staff on the phone for another family, due soon in «الجدولة».
  tickets.push(
    base(6, {
      channel: 'phone',
      category: 'classes',
      subcategory: 'makeup',
      title: 'Make-up class for a missed lesson',
      description: 'The parent called: they need a make-up class for Tuesday’s missed lesson.',
      queue: 'scheduling',
      reporter: { id: 1, name: admin.name, role: 'admin' },
      familyId: other.id,
      slaDueAt: iso(now + 40 * MIN),
      createdAt: iso(now - 3 * HOUR),
      updatedAt: iso(now - 3 * HOUR),
    }),
  );

  // 7. A closed request of the demo parent.
  tickets.push(
    base(7, {
      category: 'teacher',
      subcategory: 'progress_question',
      title: 'How is Ali doing in memorisation?',
      description: 'How is Ali doing in memorisation, and what should we revise at home?',
      status: 'verified',
      queue: 'scheduling',
      resolution: 'Ali memorised two pages this month; revise An-Naba at home.',
      firstResponseAt: iso(now - 70 * HOUR),
      fixedAt: iso(now - 50 * HOUR),
      verifiedAt: iso(now - 48 * HOUR),
      closedAt: iso(now - 48 * HOUR),
      lastPublicAt: iso(now - 48 * HOUR),
      reporterSeenAt: iso(now - 47 * HOUR),
      createdAt: iso(now - 72 * HOUR),
      updatedAt: iso(now - 48 * HOUR),
    }),
  );

  // 8. A staff suggestion, not triaged yet.
  tickets.push(
    base(8, {
      category: 'suggestion',
      title: 'Print the teacher’s week',
      description: 'A print button on the teacher’s week, to pin it next to the desk.',
      priority: null,
      queue: 'product',
      reporter: { id: 4, name: 'مشرف تجريبي', role: 'custom_10' },
      familyId: null,
      slaDueAt: iso(now + 50 * HOUR),
      createdAt: iso(now - 50 * MIN),
      updatedAt: iso(now - 50 * MIN),
    }),
  );

  return {
    tickets,
    comments,
    attachments,
    settings: structuredClone(SUPPORT_DEFAULTS),
    nextId: { ticket: 9, comment: commentId, attachment: 2 },
  };
}

/** Live binding: rebuilt per test by `resetSupportDb()`. */
export let supdb: SupportDb = undefined as unknown as SupportDb;
supdb = build();

/** Rebuilt after the people and schedule mocks (resetMockState). */
export function resetSupportDb() {
  supdb = build();
}
