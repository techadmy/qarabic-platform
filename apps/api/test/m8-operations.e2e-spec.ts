import { permissionsFor } from '@qarabic/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OperationsJobs } from '../src/operations/jobs.js';
import {
  clock,
  createUser,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';

/*
| M8 operations (docs/09 M16–M18): tasks (given / issued / all), templates, announcements,
| notification preferences + the centre (in-app, email by preference), class reminders behind
| their switch, and the dashboard numbers by permission.
*/

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-15T08:00:00Z');
});

async function staff(role: string, name?: string) {
  const user = await createUser(ctx, role, name ? { name } : {});
  return { user, client: await signInAs(ctx, user) };
}

const bell = (userId: number) =>
  ctx.prisma.notification.findMany({ where: { userId }, orderBy: { id: 'asc' } });

describe('role matrix', () => {
  it('gives tasks.oversee to admin, senior manager and manager only', () => {
    for (const role of ['senior_manager', 'manager'] as const) {
      expect(permissionsFor(role)).toContain('tasks.oversee');
    }
    for (const role of ['monitor', 'csr', 'billing', 'accounts'] as const) {
      expect(permissionsFor(role)).toEqual(expect.arrayContaining(['tasks.view', 'tasks.manage']));
      expect(permissionsFor(role)).not.toContain('tasks.oversee');
    }
    expect(permissionsFor('admin')).toContain('tasks.oversee');
    expect(permissionsFor('teacher')).not.toContain('tasks.view');
  });
});

describe('tasks', () => {
  it('issue → notice → submit → awaiting → complete; boxes and scope', async () => {
    const csr = await staff('csr', 'Issuer');
    const monitor = await staff('monitor', 'Doer');
    const other = await staff('billing');

    const created = await csr.client.post('/tasks', {
      title: 'Call the family about the schedule',
      description: 'They asked for Sunday.',
      assigneeId: monitor.user.id,
      priority: 'high',
      dueAt: '2026-11-16T10:00:00Z',
      subjectType: 'family',
      subjectId: 12,
    });
    expect(created.status).toBe(201);
    const task = created.body.data;
    expect(task).toMatchObject({
      status: 'pending',
      priority: 'high',
      assignee: { id: monitor.user.id },
      createdBy: { id: csr.user.id },
      overdue: false,
      can: { submit: false, complete: true, close: true, edit: true },
    });
    expect(task.events.map((e: { kind: string }) => e.kind)).toEqual(['created']);
    expect((await bell(monitor.user.id)).map((n) => [n.kind, n.event])).toEqual([
      ['task', 'assigned'],
    ]);

    const given = await monitor.client.get('/tasks?box=given');
    expect(given.body.meta.total).toBe(1);
    expect(given.body.data[0].can).toMatchObject({ submit: true, complete: false });
    expect((await csr.client.get('/tasks?box=issued')).body.meta.total).toBe(1);
    expect((await other.client.get(`/tasks/${task.id}`)).status).toBe(404);
    expect((await other.client.get('/tasks?box=all')).status).toBe(403);

    // The assignee cannot complete; the issuer cannot submit.
    expect((await monitor.client.post(`/tasks/${task.id}/complete`, {})).status).toBe(403);
    expect((await csr.client.post(`/tasks/${task.id}/submit`, {})).status).toBe(403);

    const submitted = await monitor.client.post(`/tasks/${task.id}/submit`, {
      note: 'Done, Sunday 5pm.',
    });
    expect(submitted.body.data.status).toBe('awaiting');
    expect((await monitor.client.post(`/tasks/${task.id}/submit`, {})).status).toBe(409);
    expect((await bell(csr.user.id)).map((n) => n.event)).toEqual(['submitted']);

    const done = await csr.client.post(`/tasks/${task.id}/complete`, {});
    expect(done.body.data).toMatchObject({
      status: 'completed',
      can: { reopen: true, close: false },
    });
    expect(
      (await csr.client.post(`/tasks/${task.id}/close`, { reason: 'Not needed' })).status,
    ).toBe(409);

    const reopened = await csr.client.post(`/tasks/${task.id}/reopen`, {
      reason: 'They changed their mind',
    });
    expect(reopened.body.data.status).toBe('pending');
    expect(reopened.body.data.events.map((e: { kind: string }) => e.kind)).toEqual([
      'created',
      'status',
      'status',
      'status',
    ]);

    const counts = (await csr.client.get('/tasks?box=issued&status=open')).body.meta.counts;
    expect(counts).toMatchObject({ all: 1, pending: 1 });
  });

  it('own task completes on submit; reassign, comments, close, overdue, oversee and the timeline is append-only', async () => {
    const manager = await staff('manager', 'Boss');
    const a = await staff('csr', 'A');
    const b = await staff('monitor', 'B');
    const own = (await a.client.post('/tasks', { title: 'Tidy my notes', assigneeId: a.user.id }))
      .body.data;
    expect((await a.client.post(`/tasks/${own.id}/submit`, {})).body.data.status).toBe('completed');
    expect(await bell(a.user.id)).toEqual([]);

    const t = (
      await a.client.post('/tasks', {
        title: 'Check the invoice',
        assigneeId: b.user.id,
        dueAt: '2026-11-14T10:00:00Z',
      })
    ).body.data;
    expect(t.overdue).toBe(true);
    expect((await b.client.get('/tasks?box=given&overdue=1')).body.meta.total).toBe(1);

    // The assignee hands it on; the new assignee is notified.
    const moved = await b.client.post(`/tasks/${t.id}/reassign`, {
      assigneeId: manager.user.id,
      note: 'Yours',
    });
    expect(moved.body.data.assignee.id).toBe(manager.user.id);
    expect((await b.client.get(`/tasks/${t.id}`)).status).toBe(404);
    expect((await bell(manager.user.id)).map((n) => n.event)).toEqual(['assigned']);
    expect(
      (await a.client.post(`/tasks/${t.id}/reassign`, { assigneeId: manager.user.id })).status,
    ).toBe(422);

    const parent = await createUser(ctx, 'parent');
    const bad = await a.client.post(`/tasks/${t.id}/reassign`, { assigneeId: parent.id });
    expect(bad.body.code).toBe('assignee_invalid');

    const commented = await manager.client.post(`/tasks/${t.id}/comments`, { body: 'On it' });
    expect(commented.status).toBe(201);
    expect(commented.body.data.comments).toBe(1);
    expect((await bell(a.user.id)).map((n) => n.event)).toEqual(['commented']);

    // Oversee: a manager sees and acts on every task.
    const third = (await a.client.post('/tasks', { title: 'Third', assigneeId: b.user.id })).body
      .data;
    expect((await manager.client.get('/tasks?box=all')).body.meta.total).toBe(3);
    const closed = await manager.client.post(`/tasks/${third.id}/close`, {
      reason: 'Duplicate task',
    });
    expect(closed.body.data).toMatchObject({ status: 'closed', closeReason: 'Duplicate task' });
    expect((await manager.client.post(`/tasks/${third.id}/close`, { reason: 'x' })).status).toBe(
      422,
    );
    // Undo of close (D31): the issuer reopens it; the assignee cannot.
    expect(
      (await b.client.post(`/tasks/${third.id}/reopen`, { reason: 'Not a duplicate' })).status,
    ).toBe(403);
    const undone = await a.client.post(`/tasks/${third.id}/reopen`, { reason: 'Not a duplicate' });
    expect(undone.body.data).toMatchObject({
      status: 'pending',
      closedAt: null,
      closeReason: null,
    });

    const edited = await a.client.patch(`/tasks/${t.id}`, { title: 'Check the December invoice' });
    expect(edited.body.data.title).toBe('Check the December invoice');
    expect((await manager.client.patch(`/tasks/${t.id}`, { priority: 'low' })).status).toBe(200);

    await expect(ctx.prisma.taskEvent.deleteMany({})).rejects.toThrow(/append-only/);
  });

  it('templates: managers edit them, everyone with tasks.manage picks them; due date from the template', async () => {
    const manager = await staff('manager');
    const csr = await staff('csr');
    expect((await csr.client.post('/task-templates', { title: 'Welcome call' })).status).toBe(403);
    const tpl = (
      await manager.client.post('/task-templates', {
        title: 'Welcome call',
        priority: 'high',
        dueInDays: 2,
      })
    ).body.data;
    expect((await csr.client.get('/task-templates')).body.data).toHaveLength(1);
    const task = (
      await csr.client.post('/tasks', {
        title: 'Welcome call',
        assigneeId: csr.user.id,
        templateId: tpl.id,
      })
    ).body.data;
    expect(task.dueAt).toBe('2026-11-17T08:00:00.000Z');
    await manager.client.put(`/task-templates/${tpl.id}`, {
      title: 'Welcome call',
      isActive: false,
    });
    expect((await csr.client.get('/task-templates')).body.data).toHaveLength(0);
    expect((await manager.client.get('/task-templates?all=1')).body.data).toHaveLength(1);
  });

  it('due-soon job notifies the assignee once', async () => {
    const a = await staff('csr');
    const b = await staff('monitor');
    await a.client.post('/tasks', {
      title: 'Soon',
      assigneeId: b.user.id,
      dueAt: '2026-11-15T08:30:00Z',
    });
    await a.client.post('/tasks', {
      title: 'Later',
      assigneeId: b.user.id,
      dueAt: '2026-11-20T08:30:00Z',
    });
    const jobs = ctx.app.get(OperationsJobs);
    expect((await jobs.tick()).dueSoon).toBe(1);
    expect((await jobs.tick()).dueSoon).toBe(0);
    expect((await bell(b.user.id)).map((n) => n.event)).toEqual([
      'assigned',
      'assigned',
      'due_soon',
    ]);
  });

  it('403 without the permission (teacher, parent)', async () => {
    for (const role of ['teacher', 'parent']) {
      const { client } = await signedIn(ctx, role);
      expect((await client.get('/tasks')).status).toBe(403);
      expect((await client.post('/tasks', {})).status).toBe(403);
      expect((await client.get('/task-templates')).status).toBe(403);
    }
  });
});

describe('announcements', () => {
  it('draft → publish to roles → bell → read; others never see it', async () => {
    const admin = await staff('admin');
    const teacher = await m2Teacher(ctx);
    const teacherClient = await signInAs(
      ctx,
      await ctx.prisma.user.findUniqueOrThrow({ where: { id: teacher.userId } }),
    );
    const csr = await staff('csr');

    expect((await csr.client.post('/announcements', { title: 'x', body: 'y' })).status).toBe(403);
    const draft = await admin.client.post('/announcements', {
      title: 'Ramadan timetable',
      body: 'Classes move one hour later during Ramadan.',
      audience: ['teacher'],
      pinned: true,
    });
    expect(draft.status).toBe(201);
    const id = draft.body.data.id;
    expect(draft.body.data).toMatchObject({ status: 'draft', readCount: 0 });
    expect((await teacherClient.get(`/announcements/${id}`)).status).toBe(404);
    expect(
      (
        await admin.client.post('/announcements', {
          title: 'Bad',
          body: 'Unknown role',
          audience: ['wizard'],
        })
      ).body.code,
    ).toBe('audience_invalid');

    expect((await admin.client.post(`/announcements/${id}/publish`)).body.data.status).toBe(
      'published',
    );
    expect((await admin.client.post(`/announcements/${id}/publish`)).status).toBe(409);
    expect((await bell(teacher.userId)).map((n) => [n.kind, n.event])).toEqual([
      ['announcement', 'published'],
    ]);
    expect(await bell(csr.user.id)).toEqual([]);

    const list = await teacherClient.get('/announcements?unread=1');
    expect(list.body.data.map((a: { id: number }) => a.id)).toEqual([id]);
    expect((await csr.client.get('/announcements')).body.data).toEqual([]);
    expect((await csr.client.get(`/announcements/${id}`)).status).toBe(404);
    expect((await teacherClient.get('/announcements?scope=manage')).status).toBe(403);

    expect((await teacherClient.post(`/announcements/${id}/read`)).body.data.read).toBe(true);
    expect((await teacherClient.get('/announcements?unread=1')).body.data).toEqual([]);
    const managed = await admin.client.get('/announcements?scope=manage');
    expect(managed.body.data[0].readCount).toBe(1);
    expect(managed.body.meta.counts).toMatchObject({ all: 1, published: 1 });

    // Expired or archived ones disappear for readers.
    clock(ctx).set('2026-11-20T08:00:00Z');
    await admin.client.patch(`/announcements/${id}`, { expiresAt: '2026-11-19T00:00:00Z' });
    expect((await teacherClient.get('/announcements')).body.data).toEqual([]);
    await admin.client.post(`/announcements/${id}/archive`);
    expect((await admin.client.patch(`/announcements/${id}`, { title: 'Again' })).status).toBe(409);

    // Undo of archive (D31): back to published; only from archived; managers only; audited.
    expect((await csr.client.post(`/announcements/${id}/unarchive`)).status).toBe(403);
    expect((await teacherClient.post(`/announcements/${id}/unarchive`)).status).toBe(403);
    const restored = await admin.client.post(`/announcements/${id}/unarchive`);
    expect(restored.status).toBe(200);
    expect(restored.body.data.status).toBe('published');
    expect((await admin.client.post(`/announcements/${id}/unarchive`)).status).toBe(409);
    expect((await admin.client.post('/announcements/9999/unarchive')).status).toBe(404);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'announcement_unarchived', subjectId: id },
      }),
    ).toBe(1);
    const draftOnly = (
      await admin.client.post('/announcements', { title: 'Never sent', body: 'Draft' })
    ).body.data.id;
    await admin.client.post(`/announcements/${draftOnly}/archive`);
    expect(
      (await admin.client.post(`/announcements/${draftOnly}/unarchive`)).body.data.status,
    ).toBe('draft');
  });
});

describe('notification centre', () => {
  it('per-kind preferences: default in-app only; email by choice; off in-app = no bell row', async () => {
    const a = await staff('csr');
    const b = await staff('monitor');
    const prefs = await b.client.get('/me/notification-preferences');
    // `push` is off while PUSH_DRIVER is `none` (the default).
    expect(prefs.body.channels).toEqual({
      in_app: true,
      email: true,
      push: false,
      whatsapp: false,
    });
    expect(prefs.body.data.find((p: { kind: string }) => p.kind === 'task')).toEqual({
      kind: 'task',
      inApp: true,
      email: false,
      push: true,
      whatsapp: false,
    });

    await a.client.post('/tasks', { title: 'No email by default', assigneeId: b.user.id });
    expect(ctx.mailer.sent.filter((m) => m.to === b.user.email)).toEqual([]);

    const saved = await b.client.put('/me/notification-preferences', {
      preferences: [{ kind: 'task', inApp: false, email: true, whatsapp: false }],
    });
    expect(saved.body.data.find((p: { kind: string }) => p.kind === 'task')).toMatchObject({
      inApp: false,
      email: true,
    });
    await a.client.post('/tasks', { title: 'Email only', assigneeId: b.user.id });
    expect(ctx.mailer.sent.filter((m) => m.to === b.user.email).map((m) => m.kind)).toEqual([
      'task_assigned',
    ]);
    expect((await bell(b.user.id)).length).toBe(1);

    expect(
      (
        await b.client.put('/me/notification-preferences', {
          preferences: [{ kind: 'nope', inApp: true, email: true, whatsapp: true }],
        })
      ).status,
    ).toBe(422);
  });

  it('class reminders: off by default; when on, the teacher once, the family only with its own switch', async () => {
    const teacher = await m2Teacher(ctx);
    const student = await m2Student(ctx, 'Europe/London');
    const enrollment = await m2Enrollment(ctx, student, teacher);
    await m2Session(ctx, enrollment, '2026-11-15T08:20:00Z');
    await m2Session(ctx, enrollment, '2026-11-15T10:00:00Z');
    const jobs = ctx.app.get(OperationsJobs);
    expect((await jobs.tick()).reminders).toBe(0);

    await ctx.prisma.appSetting.create({
      data: { key: 'notifications.class_reminders', value: true },
    });
    expect((await jobs.tick()).reminders).toBe(1);
    expect((await jobs.tick()).reminders).toBe(0);
    expect((await bell(teacher.userId)).map((n) => n.kind)).toEqual(['class_reminder']);
    const family = await ctx.prisma.family.findUniqueOrThrow({ where: { id: student.familyId } });
    expect(await bell(family.userId)).toEqual([]);
  });
});

describe('dashboard', () => {
  it('shows only the numbers the viewer may see', async () => {
    const admin = await staff('admin');
    const csr = await staff('csr');
    const accounts = await staff('accounts');
    await csr.client.post('/tasks', {
      title: 'Mine',
      assigneeId: csr.user.id,
      dueAt: '2026-11-14T00:00:00Z',
    });

    const all = (await admin.client.get('/dashboard/summary')).body.data;
    expect(all.today).toBe('2026-11-15');
    expect(all.people).toEqual({ families: 0, students: 0, teachers: 0 });
    expect(all.classesToday).toEqual({});
    expect(all.queues).toMatchObject({
      myTasks: 0,
      sessionRequests: 0,
      leaveRequests: 0,
      openComplaints: 0,
    });
    expect(all.finance).toMatchObject({
      overdueInvoices: [],
      payrollAwaitingApproval: 0,
      ledgerPending: 0,
    });

    const c = (await csr.client.get('/dashboard/summary')).body.data;
    expect(c.queues).toMatchObject({
      myTasks: 1,
      myOverdueTasks: 1,
      leaveRequests: null,
      proposedFines: null,
      openComplaints: null,
    });
    expect(c.finance).toBeNull();

    const acc = (await accounts.client.get('/dashboard/summary')).body.data;
    expect(acc.people).toBeNull();
    expect(acc.finance.ledgerPending).toBe(0);

    for (const role of ['teacher', 'parent']) {
      const { client } = await signedIn(ctx, role);
      expect((await client.get('/dashboard/summary')).status).toBe(403);
    }
  });
});
