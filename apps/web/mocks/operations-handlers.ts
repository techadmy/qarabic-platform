import {
  ANNOUNCEMENT_STATUSES,
  announcementListQuerySchema,
  createTaskSchema,
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_KINDS,
  OPEN_TASK_STATUSES,
  OPERATIONS_ERROR_MESSAGES,
  reassignTaskSchema,
  saveAnnouncementSchema,
  saveNotificationPreferencesSchema,
  TASK_STATUSES,
  taskCommentSchema,
  taskListQuerySchema,
  taskNoteSchema,
  taskReasonSchema,
  updateAnnouncementSchema,
  updateTaskSchema,
  type AnnouncementDto,
  type OperationsErrorCode,
  type TaskDetailDto,
  type TaskStatus,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { MOCK_USERS, type MockUser } from './data';
import { addEvent, odb, type AnnouncementRow, type TaskRow } from './operations-db';
import { paginate, queryOf } from './schedule-handlers';
import { apiError, guard, notFound, validationFailed } from './session';

/**
 * MSW handlers for M8 (apps/api `operations.controllers.ts`): tasks (boxes, lifecycle, timeline,
 * reassign, comments, templates), announcements (current / manage, read receipts, publish,
 * archive), notification preferences and the dashboard numbers. Same permissions, scope (a task
 * outside the viewer's boxes is 404) and refusal codes as the API. Fake data only.
 */
const API = '*/api/v1';
const has = (me: MockUser, p: string) => me.permissions.includes(p);
const ref = (me: MockUser) => ({ id: me.id, name: me.name });
const refuse = (code: OperationsErrorCode, status: number, field?: string) =>
  apiError(
    status,
    code,
    OPERATIONS_ERROR_MESSAGES[code].en,
    field ? { [field]: [OPERATIONS_ERROR_MESSAGES[code].en] } : undefined,
  );
const isOpen = (s: TaskStatus) => OPEN_TASK_STATUSES.includes(s);
const oversees = (me: MockUser) => has(me, 'tasks.oversee');
const isIssuer = (t: TaskRow, me: MockUser) => t.createdBy.id === me.id || oversees(me);
const visible = (t: TaskRow, me: MockUser) =>
  oversees(me) || t.assignee.id === me.id || t.createdBy.id === me.id;

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function presentTask(t: TaskRow, me: MockUser): TaskDetailDto {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    dueAt: t.dueAt,
    overdue: Boolean(t.dueAt && isOpen(t.status) && Date.parse(t.dueAt) < Date.now()),
    assignee: t.assignee,
    createdBy: t.createdBy,
    subjectType: t.subjectType,
    subjectId: t.subjectId,
    submittedAt: t.submittedAt,
    completedAt: t.completedAt,
    closedAt: t.closedAt,
    closeReason: t.closeReason,
    comments: t.events.filter((e) => e.kind === 'comment').length,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    can: {
      edit: isOpen(t.status) && isIssuer(t, me),
      reassign: isOpen(t.status) && (isIssuer(t, me) || t.assignee.id === me.id),
      submit: t.status === 'pending' && t.assignee.id === me.id,
      complete: isOpen(t.status) && isIssuer(t, me),
      reopen: (t.status === 'awaiting' || t.status === 'completed') && isIssuer(t, me),
      close: isOpen(t.status) && isIssuer(t, me),
    },
    events: [...t.events].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id),
  };
}

const staffPeople = () =>
  MOCK_USERS.filter(
    (u) => u.role?.kind !== 'teacher' && u.role?.kind !== 'parent' && has(u, 'tasks.view'),
  );

function findTask(id: number, me: MockUser) {
  const t = odb.tasks.find((x) => x.id === id);
  return t && visible(t, me) ? t : null;
}

const currentFor = (a: AnnouncementRow, me: MockUser) =>
  a.status === 'published' &&
  !!a.publishedAt &&
  Date.parse(a.publishedAt) <= Date.now() &&
  (!a.expiresAt || Date.parse(a.expiresAt) > Date.now()) &&
  (a.audience.length === 0 || a.audience.includes(me.role?.name ?? ''));

function presentAnnouncement(a: AnnouncementRow, me: MockUser, manage: boolean): AnnouncementDto {
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    audience: a.audience,
    pinned: a.pinned,
    status: a.status,
    publishedAt: a.publishedAt,
    expiresAt: a.expiresAt,
    createdBy: a.createdBy,
    read: a.readBy.has(me.id),
    readCount: manage ? a.readBy.size : null,
    createdAt: a.createdAt,
  };
}

function transition(t: TaskRow, me: MockUser, to: TaskStatus, text: string | null) {
  const from = t.status;
  t.status = to;
  const now = new Date().toISOString();
  if (to === 'awaiting') t.submittedAt = now;
  if (to === 'completed') t.completedAt = now;
  if (to === 'closed') {
    t.closedAt = now;
    t.closeReason = text;
  }
  if (to === 'pending') {
    t.completedAt = null;
    t.submittedAt = null;
  }
  addEvent(t, 'status', ref(me), text, { from, to });
}

export const operationsHandlers: HttpHandler[] = [
  // ---------------------------------------------------------------- tasks
  http.get(`${API}/tasks`, ({ request }) => {
    const g = guard(request, 'tasks.view');
    if ('error' in g) return g.error;
    const parsed = taskListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    if (q.box === 'all' && !oversees(g.me)) return refuse('not_allowed', 403);
    const needle = q.q?.toLowerCase();
    const now = Date.now();
    const base = odb.tasks
      .filter((t) =>
        q.box === 'given'
          ? t.assignee.id === g.me.id
          : q.box === 'issued'
            ? t.createdBy.id === g.me.id
            : true,
      )
      .filter((t) => !q.priority || t.priority === q.priority)
      .filter((t) => !q.assigneeId || t.assignee.id === q.assigneeId)
      .filter((t) => !q.subjectType || t.subjectType === q.subjectType)
      .filter((t) => !q.subjectId || t.subjectId === q.subjectId)
      .filter((t) => !q.overdue || (isOpen(t.status) && !!t.dueAt && Date.parse(t.dueAt) < now))
      .filter(
        (t) =>
          !needle ||
          t.title.toLowerCase().includes(needle) ||
          (t.description ?? '').toLowerCase().includes(needle),
      );
    const counts: Record<string, number> = { all: base.length };
    for (const s of TASK_STATUSES) counts[s] = base.filter((t) => t.status === s).length;
    const rows = base
      .filter((t) => (q.status === 'open' ? isOpen(t.status) : !q.status || t.status === q.status))
      .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || b.id - a.id);
    const out = paginate(rows, q.page, q.perPage, counts);
    return HttpResponse.json({
      ...out,
      data: out.data.map((t) => {
        const { events: _events, ...dto } = presentTask(t, g.me);
        return dto;
      }),
    });
  }),

  http.get(`${API}/tasks/assignees`, ({ request }) => {
    const g = guard(request, 'tasks.manage');
    if ('error' in g) return g.error;
    const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase();
    return HttpResponse.json({
      data: staffPeople()
        .filter((u) => !q || u.name.toLowerCase().includes(q))
        .map((u) => ({ id: u.id, name: u.name, role: u.role?.labelAr ?? null })),
    });
  }),

  http.get(`${API}/tasks/:id`, ({ request, params }) => {
    const g = guard(request, 'tasks.view');
    if ('error' in g) return g.error;
    const t = findTask(Number(params.id), g.me);
    return t ? HttpResponse.json({ data: presentTask(t, g.me) }) : notFound();
  }),

  http.post(`${API}/tasks`, async ({ request }) => {
    const g = guard(request, 'tasks.manage');
    if ('error' in g) return g.error;
    const parsed = createTaskSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const b = parsed.data;
    const assignee = staffPeople().find((u) => u.id === b.assigneeId);
    if (!assignee) return refuse('assignee_invalid', 422, 'assigneeId');
    const now = new Date().toISOString();
    const t: TaskRow = {
      id: ++odb.seq.task,
      title: b.title,
      description: b.description ?? null,
      status: 'pending',
      priority: b.priority,
      dueAt: b.dueAt ?? null,
      assignee: ref(assignee),
      createdBy: ref(g.me),
      subjectType: b.subjectType ?? null,
      subjectId: b.subjectId ?? null,
      submittedAt: null,
      completedAt: null,
      closedAt: null,
      closeReason: null,
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    odb.tasks.push(t);
    addEvent(t, 'created', ref(g.me));
    return HttpResponse.json({ data: presentTask(t, g.me) }, { status: 201 });
  }),

  http.patch(`${API}/tasks/:id`, async ({ request, params }) => {
    const g = guard(request, 'tasks.manage');
    if ('error' in g) return g.error;
    const t = findTask(Number(params.id), g.me);
    if (!t) return notFound();
    const parsed = updateTaskSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    if (!isIssuer(t, g.me)) return refuse('not_allowed', 403);
    if (!isOpen(t.status)) return refuse('invalid_task_status', 409);
    Object.assign(t, parsed.data);
    addEvent(t, 'updated', ref(g.me));
    return HttpResponse.json({ data: presentTask(t, g.me) });
  }),

  http.post(`${API}/tasks/:id/:action`, async ({ request, params }) => {
    const g = guard(request, 'tasks.view');
    if ('error' in g) return g.error;
    const t = findTask(Number(params.id), g.me);
    if (!t) return notFound();
    const action = String(params.action);
    const raw = await body(request);
    const me = g.me;
    switch (action) {
      case 'submit': {
        const p = taskNoteSchema.safeParse(raw);
        if (!p.success) return validationFailed(p.error.issues);
        if (t.assignee.id !== me.id) return refuse('not_allowed', 403);
        if (t.status !== 'pending') return refuse('invalid_task_status', 409);
        transition(t, me, t.createdBy.id === t.assignee.id ? 'completed' : 'awaiting', p.data.note);
        break;
      }
      case 'complete': {
        const p = taskNoteSchema.safeParse(raw);
        if (!p.success) return validationFailed(p.error.issues);
        if (!isIssuer(t, me)) return refuse('not_allowed', 403);
        if (!isOpen(t.status)) return refuse('invalid_task_status', 409);
        transition(t, me, 'completed', p.data.note);
        break;
      }
      case 'reopen':
      case 'close': {
        const p = taskReasonSchema.safeParse(raw);
        if (!p.success) return validationFailed(p.error.issues);
        if (!isIssuer(t, me)) return refuse('not_allowed', 403);
        const ok =
          action === 'reopen'
            ? t.status === 'awaiting' || t.status === 'completed'
            : isOpen(t.status);
        if (!ok) return refuse('invalid_task_status', 409);
        transition(t, me, action === 'reopen' ? 'pending' : 'closed', p.data.reason);
        break;
      }
      case 'reassign': {
        const p = reassignTaskSchema.safeParse(raw);
        if (!p.success) return validationFailed(p.error.issues);
        if (!(isIssuer(t, me) || t.assignee.id === me.id)) return refuse('not_allowed', 403);
        if (!isOpen(t.status)) return refuse('invalid_task_status', 409);
        if (t.assignee.id === p.data.assigneeId) return refuse('same_assignee', 422, 'assigneeId');
        const to = staffPeople().find((u) => u.id === p.data.assigneeId);
        if (!to) return refuse('assignee_invalid', 422, 'assigneeId');
        const from = t.assignee;
        t.assignee = ref(to);
        if (t.status === 'awaiting') t.status = 'pending';
        addEvent(t, 'reassigned', ref(me), p.data.note, { from, to: ref(to) });
        break;
      }
      case 'comments': {
        const p = taskCommentSchema.safeParse(raw);
        if (!p.success) return validationFailed(p.error.issues);
        addEvent(t, 'comment', ref(me), p.data.body);
        return HttpResponse.json({ data: presentTask(t, me) }, { status: 201 });
      }
      default:
        return notFound();
    }
    return HttpResponse.json({ data: presentTask(t, me) });
  }),

  http.get(`${API}/task-templates`, ({ request }) => {
    const g = guard(request, 'tasks.manage');
    if ('error' in g) return g.error;
    const all = new URL(request.url).searchParams.get('all') === '1';
    return HttpResponse.json({ data: odb.templates.filter((x) => all || x.isActive) });
  }),

  // ---------------------------------------------------------------- announcements
  http.get(`${API}/announcements`, ({ request }) => {
    const g = guard(request, 'announcements.view');
    if ('error' in g) return g.error;
    const parsed = announcementListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const manage = q.scope === 'manage';
    if (manage && !has(g.me, 'announcements.manage')) return refuse('not_allowed', 403);
    const needle = q.q?.toLowerCase();
    const base = odb.announcements
      .filter((a) => manage || currentFor(a, g.me))
      .filter(
        (a) =>
          !needle ||
          a.title.toLowerCase().includes(needle) ||
          a.body.toLowerCase().includes(needle),
      )
      .filter((a) => !q.unread || !a.readBy.has(g.me.id));
    const counts: Record<string, number> = {};
    if (manage) {
      counts.all = base.length;
      for (const s of ANNOUNCEMENT_STATUSES) counts[s] = base.filter((a) => a.status === s).length;
    }
    const rows = base
      .filter((a) => !manage || !q.status || a.status === q.status)
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          (b.publishedAt ?? '9999').localeCompare(a.publishedAt ?? '9999') ||
          b.id - a.id,
      );
    const out = paginate(rows, q.page, q.perPage, counts);
    return HttpResponse.json({
      ...out,
      data: out.data.map((a) => presentAnnouncement(a, g.me, has(g.me, 'announcements.manage'))),
    });
  }),

  http.post(`${API}/announcements/:id/read`, ({ request, params }) => {
    const g = guard(request, 'announcements.view');
    if ('error' in g) return g.error;
    const a = odb.announcements.find((x) => x.id === Number(params.id));
    if (!a || !(currentFor(a, g.me) || has(g.me, 'announcements.manage'))) return notFound();
    a.readBy.add(g.me.id);
    return HttpResponse.json({
      data: presentAnnouncement(a, g.me, has(g.me, 'announcements.manage')),
    });
  }),

  http.post(`${API}/announcements`, async ({ request }) => {
    const g = guard(request, 'announcements.manage');
    if ('error' in g) return g.error;
    const parsed = saveAnnouncementSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const a: AnnouncementRow = {
      id: ++odb.seq.announcement,
      ...parsed.data,
      expiresAt: parsed.data.expiresAt ?? null,
      status: 'draft',
      publishedAt: null,
      createdBy: ref(g.me),
      createdAt: new Date().toISOString(),
      readBy: new Set(),
    };
    odb.announcements.push(a);
    return HttpResponse.json({ data: presentAnnouncement(a, g.me, true) }, { status: 201 });
  }),

  http.patch(`${API}/announcements/:id`, async ({ request, params }) => {
    const g = guard(request, 'announcements.manage');
    if ('error' in g) return g.error;
    const a = odb.announcements.find((x) => x.id === Number(params.id));
    if (!a) return notFound();
    const parsed = updateAnnouncementSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    if (a.status === 'archived') return refuse('invalid_announcement_status', 409);
    Object.assign(a, parsed.data);
    return HttpResponse.json({ data: presentAnnouncement(a, g.me, true) });
  }),

  http.post(`${API}/announcements/:id/:action`, ({ request, params }) => {
    const g = guard(request, 'announcements.manage');
    if ('error' in g) return g.error;
    const a = odb.announcements.find((x) => x.id === Number(params.id));
    if (!a) return notFound();
    if (params.action === 'publish') {
      if (a.status !== 'draft') return refuse('invalid_announcement_status', 409);
      a.status = 'published';
      a.publishedAt = new Date().toISOString();
    } else if (params.action === 'archive') {
      if (a.status === 'archived') return refuse('invalid_announcement_status', 409);
      a.status = 'archived';
    } else return notFound();
    return HttpResponse.json({ data: presentAnnouncement(a, g.me, true) });
  }),

  // ---------------------------------------------------------------- preferences and dashboard
  http.get(`${API}/me/notification-preferences`, ({ request }) => {
    const g = guard(request);
    if ('error' in g) return g.error;
    return HttpResponse.json(preferencesOf(g.me));
  }),

  http.put(`${API}/me/notification-preferences`, async ({ request }) => {
    const g = guard(request);
    if ('error' in g) return g.error;
    const parsed = saveNotificationPreferencesSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const mine = odb.prefs.get(g.me.id) ?? {};
    for (const p of parsed.data.preferences) {
      mine[p.kind] = { inApp: p.inApp, email: p.email, whatsapp: p.whatsapp };
    }
    odb.prefs.set(g.me.id, mine);
    return HttpResponse.json(preferencesOf(g.me));
  }),

  http.get(`${API}/dashboard/summary`, ({ request }) => {
    const g = guard(request, 'reports.view');
    if ('error' in g) return g.error;
    const me = g.me;
    const n = (perm: string, value: number) => (has(me, perm) ? value : null);
    const mine = odb.tasks.filter((t) => t.assignee.id === me.id && isOpen(t.status));
    return HttpResponse.json({
      data: {
        generatedAt: new Date().toISOString(),
        today: new Date().toISOString().slice(0, 10),
        people: has(me, 'families.view') ? { families: 28, students: 41, teachers: 8 } : null,
        classesToday: has(me, 'sessions.view')
          ? { total: 46, scheduled: 18, running: 3, taken: 21, absent: 2, leave: 2 }
          : null,
        queues: {
          myTasks: n('tasks.view', mine.length),
          myOverdueTasks: n(
            'tasks.view',
            mine.filter((t) => t.dueAt && Date.parse(t.dueAt) < Date.now()).length,
          ),
          sessionRequests: n('session_requests.manage', 3),
          leaveRequests: n('attendance.manage', 1),
          proposedFines: n('fines.approve', 2),
          newLeads: n('leads.view', 5),
          trialsToday: n('leads.view', 2),
          openTickets: n('support.view', 4),
          openComplaints: n('support.view_restricted', 1),
          unreadAnnouncements: n(
            'announcements.view',
            odb.announcements.filter((a) => currentFor(a, me) && !a.readBy.has(me.id)).length,
          ),
        },
        finance:
          has(me, 'invoices.view') || has(me, 'payroll.approve')
            ? {
                overdueInvoices: [
                  { currency: 'USD', count: 6, amount: '540.00' },
                  { currency: 'GBP', count: 1, amount: '60.00' },
                ],
                receivedThisMonth: [
                  { currency: 'USD', amount: '16200.00' },
                  { currency: 'EGP', amount: '2500.00' },
                ],
                payrollAwaitingApproval: 1,
                ledgerPending: has(me, 'accounting.view') ? 2 : null,
              }
            : null,
      },
    });
  }),
];

function preferencesOf(me: MockUser) {
  const mine = odb.prefs.get(me.id) ?? {};
  return {
    data: NOTIFICATION_KINDS.map((kind) => ({
      kind,
      inApp: mine[kind]?.inApp ?? NOTIFICATION_DEFAULTS.in_app,
      email: mine[kind]?.email ?? NOTIFICATION_DEFAULTS.email,
      whatsapp: mine[kind]?.whatsapp ?? NOTIFICATION_DEFAULTS.whatsapp,
    })),
    channels: { in_app: true, email: true, whatsapp: false },
  };
}
