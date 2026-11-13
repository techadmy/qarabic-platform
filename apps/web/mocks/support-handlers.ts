import {
  categoryType,
  confirmTicketSchema,
  createTicketCommentSchema,
  createTicketSchema,
  isSubcategoryOf,
  NOTE_REQUIRED_STATUSES,
  PRIORITY_REQUIRED_STATUSES,
  SLA_DUE_SOON_MINUTES,
  TICKET_PRIORITIES,
  TICKET_QUEUES,
  TICKET_STATUSES,
  TICKET_TRANSITIONS,
  updateSupportSettingsSchema,
  updateTicketSchema,
  type InboxItemDto,
  type MyRequestItemDto,
  type NextStep,
  type SlaState,
  type TicketAttachmentDto,
  type TicketCommentDto,
  type TicketDetailDto,
  type TicketDto,
  type TicketQueue,
  type TicketStatus,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import type { MockUser } from './data';
import { MOCK_USERS } from './data';
import { db as people } from './people-db';
import { sdb } from './schedule-db';
import {
  isParent,
  isTeacher,
  ownFamilyId,
  ownTeacherId,
  paginate,
  presentRequest,
  presentSession,
  queryOf,
  seesRequest,
  seesSession,
} from './schedule-handlers';
import { apiError, guard, guardAny, notFound, validationFailed } from './session';
import {
  isClosed,
  pixelBlob,
  supdb,
  type AttachmentRow,
  type CommentRow,
  type TicketRow,
} from './support-db';
import { tdb } from './teaching-db';

/**
 * MSW handlers for the N4 support centre (apps/api README N4): `/feedback/…`, `/support/…`,
 * `/settings/support` and `/parent/home`, with the same visibility and lifecycle rules: a reporter
 * sees their own tickets, `feedback.review` all, queue members their queues; restricted tickets
 * need `support.view_restricted` and are never shown to the teacher they are about.
 */
const API = '*/api/v1';
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const ANY = [
  'feedback.view',
  'feedback.request',
  'feedback.review',
  'feedback.manage',
  'support.view',
  'support.handle',
];
const has = (me: MockUser, p: string) => me.permissions.includes(p);
const PR = updateTicketSchema.shape.prUrl;

// ------------------------------------------------------------------ policy

function visibleQueues(me: MockUser): TicketQueue[] {
  if (!has(me, 'support.view')) return [];
  if (has(me, 'support.manage')) return [...TICKET_QUEUES];
  const role = me.role?.name ?? '';
  const members = supdb.settings['support.queue_members'];
  return TICKET_QUEUES.filter((q) => (members[q] ?? []).includes(role));
}
const restrictedOk = (me: MockUser, t: TicketRow) =>
  t.visibility !== 'restricted' ||
  (has(me, 'support.view_restricted') &&
    (t.teacherId === null || t.teacherId !== ownTeacherId(me)));
const owns = (me: MockUser, t: TicketRow) => t.reporter?.id === me.id;
const staffView = (me: MockUser, t: TicketRow) =>
  restrictedOk(me, t) && (has(me, 'feedback.review') || visibleQueues(me).includes(t.queue));
const sees = (me: MockUser, t: TicketRow) => owns(me, t) || staffView(me, t);
const canManage = (me: MockUser, t: TicketRow) =>
  restrictedOk(me, t) &&
  (has(me, 'feedback.manage') ||
    (has(me, 'support.handle') && visibleQueues(me).includes(t.queue)));

function slaState(t: TicketRow, now = Date.now()): SlaState {
  if (!t.slaDueAt || isClosed(t.status)) return 'none';
  if (t.firstResponseAt) return 'met';
  const due = Date.parse(t.slaDueAt);
  if (now > due) return 'breached';
  return due - now <= SLA_DUE_SOON_MINUTES * MIN ? 'due_soon' : 'ok';
}

// ------------------------------------------------------------------ presenters

function attachmentDto(a: AttachmentRow): TicketAttachmentDto {
  return {
    id: a.id,
    source: a.source,
    mime: a.mime,
    size: a.size,
    name: a.name,
    commentId: a.commentId,
    available: true,
    url: `/api/v1/feedback/attachments/${a.id}`,
    createdAt: a.createdAt,
  };
}

const familyName = (id: number | null) =>
  id === null ? null : (people.families.find((f) => f.id === id)?.parentName ?? null);
const teacherName = (id: number | null) =>
  id === null ? null : (people.teachers.find((t) => t.id === id)?.name ?? null);

function ticketDto(t: TicketRow, me: MockUser): TicketDto {
  const mine = owns(me, t);
  const data: TicketDto = {
    id: t.id,
    number: `#${t.id}`,
    channel: t.channel,
    type: t.type,
    category: t.category,
    subcategory: t.subcategory,
    subject: t.subjectType && t.subjectId ? { type: t.subjectType, id: t.subjectId } : null,
    status: t.status,
    priority: t.priority,
    title: t.title,
    area: t.area,
    resolution: t.resolution,
    reporter: t.reporter,
    isMine: mine,
    hasUpdate:
      mine &&
      t.lastPublicAt !== null &&
      (t.reporterSeenAt === null || t.lastPublicAt > t.reporterSeenAt),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    lastPublicAt: t.lastPublicAt,
    closedAt: t.closedAt,
    attachmentsCount: supdb.attachments.filter((a) => a.ticketId === t.id).length,
    queue: t.queue,
    visibility: t.visibility,
    slaDueAt: t.slaDueAt,
    slaState: slaState(t),
    firstResponseAt: t.firstResponseAt,
    handledBy: t.assignee ? (t.assignee.name.split(/\s+/)[0] ?? null) : null,
    request: null,
  };
  if (staffView(me, t)) {
    Object.assign(data, {
      assignee: t.assignee,
      prUrl: t.prUrl,
      duplicateOfId: t.duplicateOfId,
      triagedAt: t.triagedAt,
      fixedAt: t.fixedAt,
      verifiedAt: t.verifiedAt,
      hasContactPhone: false,
      family: t.familyId ? { id: t.familyId, name: familyName(t.familyId) } : null,
      teacher: t.teacherId ? { id: t.teacherId, name: teacherName(t.teacherId) } : null,
    });
  }
  return data;
}

function detailDto(t: TicketRow, me: MockUser): TicketDetailDto {
  const staff = staffView(me, t);
  const manage = canManage(me, t);
  const rows = supdb.comments.filter((c) => c.ticketId === t.id && (staff || !c.internal));
  const ids = new Set(rows.map((c) => c.id));
  const files = supdb.attachments.filter(
    (a) => a.ticketId === t.id && (a.commentId === null || ids.has(a.commentId)),
  );
  const timeline: TicketCommentDto[] = rows.map((c) => ({
    id: c.id,
    kind: c.kind,
    body: c.body,
    internal: c.internal,
    meta: staff
      ? c.meta
      : Object.fromEntries(Object.entries(c.meta).filter(([k]) => ['from', 'to'].includes(k))),
    author: c.author,
    authorLabel: c.authorLabel,
    byReporter: !!c.author && c.author.id === t.reporter?.id,
    attachments: files.filter((a) => a.commentId === c.id).map(attachmentDto),
    createdAt: c.createdAt,
  }));
  const context = staff
    ? t.context
    : Object.fromEntries(
        Object.entries(t.context).filter(([k]) => k !== 'recentErrors' && k !== 'userAgent'),
      );
  return {
    ...ticketDto(t, me),
    description: t.description,
    context,
    timeline,
    attachments: files.map(attachmentDto),
    can: {
      manage,
      comment: manage || (owns(me, t) && !isClosed(t.status)),
      commentInternal: manage,
      confirm: owns(me, t) && t.status === 'fixed',
      nextStatuses: manage ? [...TICKET_TRANSITIONS[t.status]] : [],
    },
  };
}

function nextStep(status: TicketStatus): NextStep | null {
  if (status === 'new' || status === 'triaged') return 'awaiting_team';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'needs_info') return 'reply_needed';
  if (status === 'fixed') return 'confirm_fix';
  return null;
}

// ------------------------------------------------------------------ writes

function touchTicket(t: TicketRow, publicChange: boolean) {
  const now = iso(Date.now());
  t.updatedAt = now;
  if (publicChange) t.lastPublicAt = now;
}

function addComment(
  t: TicketRow,
  me: MockUser | null,
  o: {
    kind?: CommentRow['kind'];
    body?: string | null;
    internal?: boolean;
    meta?: Record<string, unknown>;
  },
): number {
  const row: CommentRow = {
    id: supdb.nextId.comment++,
    ticketId: t.id,
    kind: o.kind ?? 'comment',
    body: o.body ?? null,
    internal: o.internal ?? false,
    meta: o.meta ?? {},
    author: me ? { id: me.id, name: me.name } : null,
    authorLabel: null,
    createdAt: iso(Date.now()),
  };
  supdb.comments.push(row);
  return row.id;
}

const fieldError = (field: string, message: string) =>
  apiError(422, 'validation_failed', 'The given data was invalid.', { [field]: [message] });

async function readInput(
  request: Request,
): Promise<{ body: Record<string, unknown>; files: File[] }> {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('multipart/form-data')) {
    const form = await request.formData();
    const body: Record<string, unknown> = {};
    const files: File[] = [];
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') body[k] = v;
      else files.push(v);
    }
    return { body, files };
  }
  try {
    return { body: (await request.json()) as Record<string, unknown>, files: [] };
  } catch {
    return { body: {}, files: [] };
  }
}

function storeFiles(t: TicketRow, files: File[], commentId: number | null) {
  for (const f of files) {
    supdb.attachments.push({
      id: supdb.nextId.attachment++,
      ticketId: t.id,
      commentId,
      source: f.name === 'screenshot.png' && commentId === null ? 'screenshot' : 'upload',
      mime: f.type || 'image/png',
      size: f.size,
      name: f.name,
      blob: f,
      createdAt: iso(Date.now()),
    });
  }
}

function routeOf(category: string, subcategory: string | null): TicketQueue {
  const map = supdb.settings['support.queue_by_category'];
  return (subcategory && map[`${category}.${subcategory}`]) || map[category] || 'general';
}

function subjectInScope(me: MockUser, type: string, id: number): boolean {
  if (type === 'invoice') return !isTeacher(me) && !isParent(me) ? true : false;
  if (type === 'session') {
    const s = sdb.sessions.find((x) => x.id === id && !x.deleted);
    return !!s && seesSession(me, s);
  }
  const student = people.students.find((x) => x.id === id);
  if (!student) return false;
  if (isParent(me)) return student.familyId === ownFamilyId(me);
  if (isTeacher(me)) return student.teacher?.id === ownTeacherId(me);
  return true;
}

function listTickets(me: MockUser, scope: 'mine' | 'all') {
  return supdb.tickets.filter((t) =>
    scope === 'mine'
      ? owns(me, t)
      : sees(me, t) && (has(me, 'feedback.review') || staffView(me, t)),
  );
}

const statusMatch = (t: TicketRow, s: string) =>
  s === 'open' ? !isClosed(t.status) : s === 'closed' ? isClosed(t.status) : t.status === s;

// ------------------------------------------------------------------ handlers

export const supportHandlers: HttpHandler[] = [
  http.get(`${API}/feedback/summary`, ({ request }) => {
    const g = guardAny(request, ...ANY);
    if ('error' in g) return g.error;
    const mine = supdb.tickets.filter((t) => owns(g.me, t)).map((t) => ticketDto(t, g.me));
    return HttpResponse.json({
      data: {
        mineUpdates: mine.filter((t) => t.hasUpdate).length,
        triageNew: has(g.me, 'feedback.review')
          ? supdb.tickets.filter((t) => t.status === 'new' && sees(g.me, t)).length
          : null,
      },
    });
  }),

  http.get(`${API}/feedback/assignees`, ({ request }) => {
    const g = guard(request, 'feedback.manage');
    if ('error' in g) return g.error;
    return HttpResponse.json({
      data: MOCK_USERS.filter((u) => has(u, 'feedback.manage')).map((u) => ({
        id: u.id,
        name: u.name,
      })),
    });
  }),

  http.get(`${API}/feedback/tickets`, ({ request }) => {
    const g = guardAny(request, ...ANY);
    if ('error' in g) return g.error;
    const q = queryOf(request);
    const scope = q.scope === 'mine' || !has(g.me, 'feedback.review') ? 'mine' : 'all';
    if (q.scope === 'all' && !has(g.me, 'feedback.review'))
      return apiError(403, 'forbidden', 'Forbidden.');
    let rows = listTickets(g.me, scope);
    const list = (k: string) => (q[k] ? q[k]!.split(',') : null);
    const priority = list('priority');
    if (priority) rows = rows.filter((t) => priority.includes(t.priority ?? 'none'));
    const category = list('category');
    if (category) rows = rows.filter((t) => category.includes(t.category));
    if (q.channel) rows = rows.filter((t) => t.channel === q.channel);
    if (q.assigneeId === 'none') rows = rows.filter((t) => !t.assignee);
    if (q.q) {
      const term = q.q.replace(/^#/, '').toLowerCase();
      rows = rows.filter(
        (t) =>
          String(t.id) === term ||
          t.title.toLowerCase().includes(term) ||
          t.description.toLowerCase().includes(term),
      );
    }
    const counts: Record<string, number> = { all: rows.length };
    for (const s of [...TICKET_STATUSES, 'open', 'closed']) {
      counts[s] = rows.filter((t) => statusMatch(t, s)).length;
    }
    const status = list('status');
    if (status) rows = rows.filter((t) => status.some((s) => statusMatch(t, s)));
    const order = (t: TicketRow) => (t.priority ? TICKET_PRIORITIES.indexOf(t.priority) : 9);
    rows = [...rows].sort((a, b) =>
      q.sort === 'priority'
        ? order(a) - order(b) || b.createdAt.localeCompare(a.createdAt)
        : q.sort === 'updated'
          ? b.updatedAt.localeCompare(a.updatedAt)
          : b.createdAt.localeCompare(a.createdAt),
    );
    const page = paginate(rows, Number(q.page) || 1, Number(q.perPage) || 25, counts);
    return HttpResponse.json({
      data: page.data.map((t) => ticketDto(t, g.me)),
      meta: { ...page.meta, scope },
    });
  }),

  http.post(`${API}/feedback/tickets`, async ({ request }) => {
    const g = guard(request, 'feedback.request');
    if ('error' in g) return g.error;
    const { body, files } = await readInput(request);
    const parsed = createTicketSchema.safeParse(body);
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    const category = input.category ?? (input.type === 'bug' ? 'technical' : 'suggestion');
    if (input.subcategory && !isSubcategoryOf(category, input.subcategory)) {
      return fieldError('subcategory', 'The selected subcategory is invalid.');
    }
    if ((input.subjectType && !input.subjectId) || (!input.subjectType && input.subjectId)) {
      return fieldError('subjectId', 'The subject is incomplete.');
    }
    if (
      input.subjectType &&
      input.subjectId &&
      !subjectInScope(g.me, input.subjectType, input.subjectId)
    ) {
      return fieldError('subjectId', 'The selected subject is invalid.');
    }
    const staff = !isParent(g.me) && !isTeacher(g.me);
    if ((input.channel || input.familyId) && !staff) {
      return fieldError('channel', 'Only staff may file on someone’s behalf.');
    }
    const session =
      input.subjectType === 'session' ? sdb.sessions.find((s) => s.id === input.subjectId) : null;
    const student =
      input.subjectType === 'student'
        ? people.students.find((s) => s.id === input.subjectId)
        : session
          ? people.students.find((s) => s.id === session.studentId)
          : null;
    const familyId =
      input.familyId ?? student?.familyId ?? (isParent(g.me) ? ownFamilyId(g.me) : null);
    let queue = routeOf(category, input.subcategory ?? null);
    const complaint = category === 'teacher' && input.subcategory === 'teacher_feedback';
    if (complaint) queue = 'complaints';
    const restricted = supdb.settings['support.restricted_queues'].includes(queue);
    const now = Date.now();
    const hours = supdb.settings['support.sla_hours'][queue] ?? 12;
    const text = input.description.trim();
    const t: TicketRow = {
      id: supdb.nextId.ticket++,
      channel: input.channel ?? 'in_app',
      type: input.category ? categoryType(input.category) : (input.type ?? 'feature'),
      category,
      subcategory: input.subcategory ?? null,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      status: 'new',
      priority:
        category === 'technical' || category === 'suggestion' ? null : complaint ? 'p1' : 'p2',
      title: (text.split('\n')[0] ?? text).slice(0, 120),
      description: text,
      area: typeof input.context?.area === 'string' ? (input.context.area as string) : null,
      resolution: null,
      reporter: { id: g.me.id, name: g.me.name, role: g.me.role?.name ?? null },
      familyId,
      teacherId:
        session?.teacherId ?? student?.teacher?.id ?? (isTeacher(g.me) ? ownTeacherId(g.me) : null),
      queue,
      visibility: restricted ? 'restricted' : 'normal',
      slaDueAt: iso(now + hours * 60 * MIN),
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
      createdAt: iso(now),
      updatedAt: iso(now),
      context: input.context ?? {},
    };
    supdb.tickets.push(t);
    storeFiles(t, files, null);
    return HttpResponse.json({ data: detailDto(t, g.me) }, { status: 201 });
  }),

  http.get(`${API}/feedback/tickets/:id`, ({ request, params }) => {
    const g = guardAny(request, ...ANY);
    if ('error' in g) return g.error;
    const t = supdb.tickets.find((x) => x.id === Number(params.id));
    if (!t || !sees(g.me, t)) return notFound();
    return HttpResponse.json({ data: detailDto(t, g.me) });
  }),

  http.patch(`${API}/feedback/tickets/:id`, async ({ request, params }) => {
    const g = guardAny(request, 'feedback.manage', 'support.handle');
    if ('error' in g) return g.error;
    const t = supdb.tickets.find((x) => x.id === Number(params.id));
    if (!t || !sees(g.me, t)) return notFound();
    if (!canManage(g.me, t)) return apiError(403, 'forbidden', 'Forbidden.');
    const parsed = updateTicketSchema.safeParse(await readInput(request).then((r) => r.body));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const p = parsed.data;
    if (p.status && p.status !== t.status) {
      if (!TICKET_TRANSITIONS[t.status].includes(p.status)) {
        return fieldError('status', 'This status change is not allowed.');
      }
      if ((NOTE_REQUIRED_STATUSES as readonly string[]).includes(p.status) && !p.note?.trim()) {
        return fieldError('note', 'A note to the reporter is required.');
      }
      const priority = p.priority !== undefined ? p.priority : t.priority;
      if ((PRIORITY_REQUIRED_STATUSES as readonly string[]).includes(p.status) && !priority) {
        return fieldError('priority', 'Set a priority first.');
      }
      const category = p.category ?? t.category;
      const pr = p.prUrl !== undefined ? p.prUrl : t.prUrl;
      if (p.status === 'fixed' && category === 'technical' && !pr) {
        return fieldError('prUrl', 'A technical fix needs its pull request.');
      }
    }
    if (p.prUrl && !PR.safeParse(p.prUrl).success) return fieldError('prUrl', 'Invalid link.');
    const now = iso(Date.now());
    if (p.priority !== undefined && p.priority !== t.priority) {
      addComment(t, g.me, { kind: 'priority', meta: { from: t.priority, to: p.priority } });
      t.priority = p.priority;
    }
    if (p.category && p.category !== t.category) {
      addComment(t, g.me, {
        kind: 'system',
        meta: { field: 'category', from: t.category, to: p.category },
      });
      t.category = p.category;
      t.type = categoryType(p.category);
      t.subcategory = null;
      t.queue = routeOf(p.category, null);
    }
    if (p.assigneeId !== undefined) {
      const who = p.assigneeId === null ? null : MOCK_USERS.find((u) => u.id === p.assigneeId);
      if (p.assigneeId !== null && (!who || !canManage(who, t))) {
        return fieldError('assigneeId', 'This person cannot handle the queue.');
      }
      if ((who?.id ?? null) !== (t.assignee?.id ?? null)) {
        addComment(t, g.me, {
          kind: 'assignment',
          internal: true,
          meta: { to: who?.id ?? null, toName: who?.name ?? null },
        });
        t.assignee = who ? { id: who.id, name: who.name } : null;
      }
    }
    if (p.area !== undefined) t.area = p.area;
    if (p.prUrl !== undefined) t.prUrl = p.prUrl;
    if (p.resolution !== undefined) t.resolution = p.resolution;
    if (p.title) t.title = p.title;
    if (p.status && p.status !== t.status) {
      addComment(t, g.me, {
        kind: 'status',
        body: p.note?.trim() || null,
        meta: { from: t.status, to: p.status },
      });
      t.status = p.status;
      if (p.status === 'triaged') t.triagedAt = now;
      if (p.status === 'fixed') t.fixedAt = now;
      if (p.status === 'verified') t.verifiedAt = now;
      t.closedAt = isClosed(p.status) ? now : null;
      t.firstResponseAt ??= now;
      if (p.status === 'fixed' && p.note === undefined && t.resolution === null)
        t.resolution = null;
      touchTicket(t, true);
    } else if (p.note?.trim()) {
      addComment(t, g.me, { body: p.note.trim(), internal: true });
      touchTicket(t, false);
    } else {
      touchTicket(t, false);
    }
    return HttpResponse.json({ data: detailDto(t, g.me) });
  }),

  http.post(`${API}/feedback/tickets/:id/comments`, async ({ request, params }) => {
    const g = guardAny(request, ...ANY);
    if ('error' in g) return g.error;
    const t = supdb.tickets.find((x) => x.id === Number(params.id));
    if (!t || !sees(g.me, t)) return notFound();
    const manage = canManage(g.me, t);
    if (!manage && !owns(g.me, t)) return apiError(403, 'forbidden', 'Forbidden.');
    const { body, files } = await readInput(request);
    const parsed = createTicketCommentSchema.safeParse(body);
    if (!parsed.success) return validationFailed(parsed.error.issues);
    if (!manage && isClosed(t.status)) {
      return fieldError('body', 'This request is closed. Open a new one if you need help.');
    }
    const internal = manage && parsed.data.internal === true;
    const id = addComment(t, g.me, { body: parsed.data.body, internal });
    storeFiles(t, files, id);
    if (!internal) {
      if (manage && !owns(g.me, t)) t.firstResponseAt ??= iso(Date.now());
      if (owns(g.me, t) && t.status === 'needs_info') {
        addComment(t, g.me, {
          kind: 'status',
          meta: { from: 'needs_info', to: 'triaged', byReporter: true },
        });
        t.status = 'triaged';
      }
      touchTicket(t, !owns(g.me, t));
      if (owns(g.me, t)) t.reporterSeenAt = t.updatedAt;
    } else {
      touchTicket(t, false);
    }
    const dto = detailDto(t, g.me).timeline.find((c) => c.id === id)!;
    return HttpResponse.json({ data: dto }, { status: 201 });
  }),

  http.post(`${API}/feedback/tickets/:id/confirm`, async ({ request, params }) => {
    const g = guard(request, 'feedback.request');
    if ('error' in g) return g.error;
    const t = supdb.tickets.find((x) => x.id === Number(params.id));
    if (!t || !sees(g.me, t)) return notFound();
    if (!owns(g.me, t) || t.status !== 'fixed') return apiError(403, 'forbidden', 'Forbidden.');
    const parsed = confirmTicketSchema.safeParse(await readInput(request).then((r) => r.body));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const to: TicketStatus = parsed.data.resolved ? 'verified' : 'triaged';
    addComment(t, g.me, {
      kind: 'status',
      body: parsed.data.body ?? null,
      meta: { from: 'fixed', to, byReporter: true },
    });
    t.status = to;
    const now = iso(Date.now());
    if (to === 'verified') {
      t.verifiedAt = now;
      t.closedAt = now;
    }
    t.updatedAt = now;
    t.reporterSeenAt = now;
    return HttpResponse.json({ data: detailDto(t, g.me) });
  }),

  http.post(`${API}/feedback/tickets/:id/seen`, ({ request, params }) => {
    const g = guard(request, 'feedback.request');
    if ('error' in g) return g.error;
    const t = supdb.tickets.find((x) => x.id === Number(params.id));
    if (!t || !owns(g.me, t)) return notFound();
    t.reporterSeenAt = iso(Date.now());
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${API}/feedback/attachments/:id`, ({ request, params }) => {
    const g = guardAny(request, ...ANY);
    if ('error' in g) return g.error;
    const a = supdb.attachments.find((x) => x.id === Number(params.id));
    const t = a && supdb.tickets.find((x) => x.id === a.ticketId);
    if (!a || !t || !sees(g.me, t)) return notFound();
    return new HttpResponse(a.blob ?? pixelBlob(), {
      headers: { 'Content-Type': a.mime, 'X-Content-Type-Options': 'nosniff' },
    });
  }),

  // ------------------------------------------------------------------ inbox
  http.get(`${API}/support/inbox`, ({ request }) => {
    const g = guard(request, 'support.view');
    if ('error' in g) return g.error;
    const q = queryOf(request);
    const queues = visibleQueues(g.me);
    const now = Date.now();
    const status = q.status ?? 'open';
    const tickets = supdb.tickets.filter((t) => queues.includes(t.queue) && staffView(g.me, t));
    const requests =
      has(g.me, 'session_requests.view') && queues.includes('scheduling')
        ? sdb.requests.filter((r) => r.status === 'pending' && seesRequest(g.me, r))
        : [];
    const counts: Partial<
      Record<TicketQueue, { open: number; breached: number; unassigned: number }>
    > = {};
    for (const queue of queues) {
      const open = tickets.filter((t) => t.queue === queue && !isClosed(t.status));
      const pending = queue === 'scheduling' ? requests.length : 0;
      counts[queue] = {
        open: open.length + pending,
        breached: open.filter((t) => slaState(t, now) === 'breached').length,
        unassigned: open.filter((t) => !t.assignee).length + pending,
      };
    }
    const term = q.q?.replace(/^#/, '').toLowerCase();
    let items: InboxItemDto[] = [];
    if (q.kind !== 'session_request') {
      items.push(
        ...tickets
          .filter((t) => !q.queue || t.queue === q.queue)
          .filter((t) => statusMatch(t, status === 'all' ? 'all' : status) || status === 'all')
          .filter((t) => !q.category || q.category.split(',').includes(t.category))
          .filter((t) => !q.priority || q.priority.split(',').includes(t.priority ?? 'none'))
          .filter((t) => q.breached !== '1' || slaState(t, now) === 'breached')
          .filter((t) => !q.familyId || t.familyId === Number(q.familyId))
          .filter(
            (t) =>
              !q.assignee ||
              (q.assignee === 'me'
                ? t.assignee?.id === g.me.id
                : q.assignee === 'none'
                  ? !t.assignee
                  : t.assignee?.id === Number(q.assignee)),
          )
          .filter(
            (t) =>
              !term ||
              String(t.id) === term ||
              t.title.toLowerCase().includes(term) ||
              (familyName(t.familyId) ?? '').toLowerCase().includes(term),
          )
          .map((t) => ({
            kind: 'ticket' as const,
            key: `ticket:${t.id}`,
            id: t.id,
            queue: t.queue,
            slaDueAt: t.slaDueAt,
            slaState: slaState(t, now),
            family: t.familyId ? { id: t.familyId, name: familyName(t.familyId) } : null,
            teacher: t.teacherId ? { id: t.teacherId, name: teacherName(t.teacherId) } : null,
            open: !isClosed(t.status),
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            ticket: ticketDto(t, g.me),
            request: null,
          })),
      );
    }
    const requestFilterOk =
      q.kind !== 'ticket' &&
      (!q.queue || q.queue === 'scheduling') &&
      (status === 'open' || status === 'all') &&
      !q.priority &&
      !q.assignee &&
      q.breached !== '1' &&
      (!q.category || q.category.split(',').includes('classes'));
    if (requestFilterOk) {
      for (const r of requests) {
        const s = sdb.sessions.find((x) => x.id === r.sessionId)!;
        const student = people.students.find((x) => x.id === s.studentId);
        if (q.familyId && student?.familyId !== Number(q.familyId)) continue;
        if (term && !(student?.name ?? '').toLowerCase().includes(term)) continue;
        items.push({
          kind: 'session_request',
          key: `request:${r.id}`,
          id: r.id,
          queue: 'scheduling',
          slaDueAt: s.startsAt,
          slaState: Date.parse(s.startsAt) < now ? 'breached' : 'ok',
          family: student ? { id: student.familyId, name: familyName(student.familyId) } : null,
          teacher: { id: s.teacherId, name: teacherName(s.teacherId) },
          open: true,
          createdAt: r.createdAt,
          updatedAt: r.createdAt,
          ticket: null,
          request: presentRequest(r, g.me),
        });
      }
    }
    const rank = (i: InboxItemDto) =>
      i.slaState === 'breached' ? 0 : i.slaState === 'met' || i.slaState === 'none' ? 2 : 1;
    items = items.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.slaDueAt ?? '9999').localeCompare(b.slaDueAt ?? '9999') ||
        b.createdAt.localeCompare(a.createdAt),
    );
    const page = Number(q.page) || 1;
    const perPage = Number(q.perPage) || 25;
    return HttpResponse.json({
      data: items.slice((page - 1) * perPage, page * perPage),
      meta: {
        page,
        perPage,
        total: items.length,
        lastPage: Math.max(1, Math.ceil(items.length / perPage)),
        queues,
        counts,
      },
    });
  }),

  http.get(`${API}/support/summary`, ({ request }) => {
    const g = guard(request, 'support.view');
    if ('error' in g) return g.error;
    const queues = visibleQueues(g.me);
    const open = supdb.tickets.filter(
      (t) => queues.includes(t.queue) && staffView(g.me, t) && !isClosed(t.status),
    );
    const summary: Partial<
      Record<TicketQueue, { open: number; breached: number; unassigned: number }>
    > = {};
    for (const q of queues) {
      const rows = open.filter((t) => t.queue === q);
      summary[q] = {
        open: rows.length,
        breached: rows.filter((t) => slaState(t) === 'breached').length,
        unassigned: rows.filter((t) => !t.assignee).length,
      };
    }
    return HttpResponse.json({
      data: {
        openTotal: open.length,
        breachedTotal: open.filter((t) => slaState(t) === 'breached').length,
        unassignedTotal: open.filter((t) => !t.assignee).length,
        queues: summary,
      },
    });
  }),

  http.get(`${API}/support/assignees`, ({ request }) => {
    const g = guardAny(request, 'support.handle', 'support.manage');
    if ('error' in g) return g.error;
    const queue = queryOf(request).queue as TicketQueue;
    if (!visibleQueues(g.me).includes(queue))
      return fieldError('queue', 'The selected queue is invalid.');
    const members = supdb.settings['support.queue_members'][queue] ?? [];
    return HttpResponse.json({
      data: MOCK_USERS.filter(
        (u) =>
          has(u, 'support.manage') ||
          (has(u, 'support.handle') && members.includes(u.role?.name ?? '')),
      ).map((u) => ({ id: u.id, name: u.name })),
    });
  }),

  http.get(`${API}/support/people`, ({ request }) => {
    const g = guard(request, 'support.view');
    if ('error' in g) return g.error;
    const q = queryOf(request);
    const f = q.familyId ? people.families.find((x) => x.id === Number(q.familyId)) : null;
    const tr = q.teacherId ? people.teachers.find((x) => x.id === Number(q.teacherId)) : null;
    const details = has(g.me, 'families.view');
    return HttpResponse.json({
      data: {
        family: f
          ? {
              id: f.id,
              name: f.parentName,
              status: details ? f.status.value : null,
              timezone: details ? f.timezone : null,
              children: details
                ? people.students
                    .filter((s) => s.familyId === f.id)
                    .map((s) => ({ id: s.id, name: s.name }))
                : [],
              openTickets: supdb.tickets.filter((t) => t.familyId === f.id && !isClosed(t.status))
                .length,
              pendingRequests: sdb.requests.filter((r) => {
                const s = sdb.sessions.find((x) => x.id === r.sessionId);
                const st = s && people.students.find((x) => x.id === s.studentId);
                return r.status === 'pending' && st?.familyId === f.id;
              }).length,
            }
          : null,
        teacher: tr ? { id: tr.id, name: tr.name, timezone: tr.timezone } : null,
      },
    });
  }),

  http.post(`${API}/support/tickets/:id/take`, ({ request, params }) => {
    const g = guardAny(request, 'support.handle', 'support.manage');
    if ('error' in g) return g.error;
    const t = supdb.tickets.find((x) => x.id === Number(params.id));
    if (!t || !sees(g.me, t)) return notFound();
    if (!canManage(g.me, t)) return apiError(403, 'forbidden', 'Forbidden.');
    if (t.assignee?.id !== g.me.id) {
      addComment(t, g.me, {
        kind: 'assignment',
        internal: true,
        meta: { to: g.me.id, toName: g.me.name },
      });
      t.assignee = { id: g.me.id, name: g.me.name };
      touchTicket(t, false);
    }
    return HttpResponse.json({ data: detailDto(t, g.me) });
  }),

  http.get(`${API}/support/mine`, ({ request }) => {
    const g = guardAny(request, 'feedback.request', 'session_requests.request');
    if ('error' in g) return g.error;
    const q = queryOf(request);
    const items: MyRequestItemDto[] = [];
    for (const t of supdb.tickets.filter((x) => owns(g.me, x))) {
      const dto = ticketDto(t, g.me);
      items.push({
        kind: 'ticket',
        key: `ticket:${t.id}`,
        id: t.id,
        title: t.title,
        status: t.status,
        open: !isClosed(t.status),
        category: t.category,
        requestType: null,
        nextStep: nextStep(t.status),
        slaDueAt: dto.slaState === 'met' ? null : t.slaDueAt,
        hasUpdate: dto.hasUpdate,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        ticket: dto,
        request: null,
      });
    }
    const familyId = ownFamilyId(g.me);
    for (const r of sdb.requests) {
      const s = sdb.sessions.find((x) => x.id === r.sessionId);
      const st = s && people.students.find((x) => x.id === s.studentId);
      const mine = isParent(g.me) ? st?.familyId === familyId : r.requestedBy.id === g.me.id;
      if (!mine) continue;
      items.push({
        kind: 'session_request',
        key: `request:${r.id}`,
        id: r.id,
        title: st?.name ?? null,
        status: r.status,
        open: r.status === 'pending',
        category: 'classes',
        requestType: r.type,
        nextStep: r.status === 'pending' ? 'awaiting_approval' : null,
        slaDueAt: null,
        hasUpdate: false,
        createdAt: r.createdAt,
        updatedAt: r.decidedAt ?? r.createdAt,
        ticket: null,
        request: presentRequest(r, g.me),
      });
    }
    const openCount = items.filter((i) => i.open).length;
    const rows = items
      .filter((i) => (q.status === 'open' ? i.open : q.status === 'closed' ? !i.open : true))
      .sort((a, b) => Number(b.open) - Number(a.open) || b.updatedAt.localeCompare(a.updatedAt));
    const page = Number(q.page) || 1;
    const perPage = Number(q.perPage) || 25;
    return HttpResponse.json({
      data: rows.slice((page - 1) * perPage, page * perPage),
      meta: {
        page,
        perPage,
        total: rows.length,
        lastPage: Math.max(1, Math.ceil(rows.length / perPage)),
        open: openCount,
      },
    });
  }),

  // ------------------------------------------------------------------ settings, parent home
  http.get(`${API}/settings/support`, ({ request }) => {
    const g = guard(request, 'settings.view');
    if ('error' in g) return g.error;
    return HttpResponse.json({ data: supdb.settings });
  }),

  http.put(`${API}/settings/support`, async ({ request }) => {
    const g = guard(request, 'settings.manage');
    if ('error' in g) return g.error;
    const parsed = updateSupportSettingsSchema.safeParse(
      await readInput(request).then((r) => r.body),
    );
    if (!parsed.success) return validationFailed(parsed.error.issues);
    supdb.settings = { ...supdb.settings, ...(parsed.data as Partial<typeof supdb.settings>) };
    return HttpResponse.json({ data: supdb.settings });
  }),

  http.get(`${API}/parent/home`, ({ request }) => {
    const g = guard(request, 'families.view');
    if ('error' in g) return g.error;
    if (!isParent(g.me)) return apiError(403, 'forbidden', 'Forbidden.');
    const familyId = ownFamilyId(g.me);
    const family = people.families.find((f) => f.id === familyId);
    if (!family) return apiError(403, 'forbidden', 'Forbidden.');
    const now = Date.now();
    const kids = people.students
      .filter((s) => s.familyId === family.id && !s.archive)
      .sort((a, b) => a.name.localeCompare(b.name));
    const live = ['scheduled', 'activated', 'in_progress'];
    const endOf = (s: { startsAt: string; durationMinutes: number }) =>
      Date.parse(s.startsAt) + s.durationMinutes * MIN;
    const sessions = sdb.sessions
      .filter((s) => !s.deleted && kids.some((k) => k.id === s.studentId))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id - b.id);
    const upcoming = sessions
      .filter(
        (s) =>
          live.includes(s.stage) && endOf(s) > now && Date.parse(s.startsAt) < now + 7 * 1440 * MIN,
      )
      .slice(0, 20);
    const settingsRating = sdb.settings['reports.parent_sees_rating'];
    const reports = kids.flatMap((k) =>
      sessions
        .filter((s) => s.studentId === k.id && tdb.reports.has(s.id))
        .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
        .slice(0, 3)
        .map((s) => {
          const r = tdb.reports.get(s.id)!;
          const teacher = people.teachers.find((t) => t.id === s.teacherId);
          return {
            sessionId: s.id,
            reportId: r.id,
            student: { id: k.id, name: k.name },
            startsAt: s.startsAt,
            teacher: teacher ? { id: teacher.id, name: teacher.name } : null,
            summary: r.summary,
            homework: r.homework,
            tajweedNotes: r.tajweedNotes,
            ...(settingsRating ? { rating: r.rating } : {}),
            submittedAt: r.submittedAt,
            hifz: r.hifz,
          };
        }),
    );
    reports.sort((a, b) => b.startsAt.localeCompare(a.startsAt) || b.reportId - a.reportId);
    const tickets = supdb.tickets.filter((t) => owns(g.me, t));
    return HttpResponse.json({
      data: {
        family: {
          id: family.id,
          name: family.parentName,
          timezone: family.timezone,
          status: family.status.value,
        },
        children: kids.map((k) => {
          const next = sessions.find(
            (s) => s.studentId === k.id && live.includes(s.stage) && endOf(s) > now,
          );
          const teacher = k.teacher ? people.teachers.find((t) => t.id === k.teacher!.id) : null;
          return {
            id: k.id,
            name: k.name,
            status: k.status.value === 'inactive' ? 'inactive' : 'active',
            course: k.regularCourse,
            teacher: teacher
              ? { id: teacher.id, name: teacher.name, timezone: teacher.timezone }
              : null,
            nextClass: next
              ? {
                  id: next.id,
                  startsAt: next.startsAt,
                  endsAt: iso(endOf(next)),
                  stage: next.stage,
                }
              : null,
          };
        }),
        upcomingClasses: upcoming.map((s) => presentSession(s, g.me)),
        requests: {
          pendingClassRequests: sdb.requests.filter(
            (r) => r.status === 'pending' && sessions.some((s) => s.id === r.sessionId),
          ).length,
          openTickets: tickets.filter((t) => !isClosed(t.status)).length,
          ticketUpdates: tickets.filter((t) => ticketDto(t, g.me).hasUpdate).length,
        },
        recentReports: reports,
      },
    });
  }),
];
