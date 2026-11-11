import { permissionsFor } from '@qarabic/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SettingsService } from '../src/settings/settings.service.js';
import { SUPPORT_SETTING_DEFAULTS } from '../src/support/settings-defaults.js';
import {
  clock,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  makeFamily,
  resetState,
  signedIn,
  signInAs,
  type Client,
  type TestContext,
} from './helpers.js';
import { grant } from './n4-helpers.js';

/*
 * Port of Laravel tests/Feature/Feedback/SupportS2Test.php (docs/32 §4–§6, D135): queues, SLA in
 * working hours, restricted complaints, the unified staff inbox (tickets + pending class requests),
 * the merged «طلباتي», the side panel and the queue settings. The reschedule auto-approval cases
 * are N2 (n2-session-requests); breach alerts wait for the notification centre.
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
  // Tuesday 2026-11-10 12:00 Cairo (10:00 UTC), inside working hours.
  clock(ctx).set('2026-11-10T10:00:00Z');
});

/** A parent with one child taught by a Cairo teacher, and one class on Thursday (`s2Family`). */
async function s2Family() {
  const family = await makeFamily(ctx, { timezone: 'Europe/London' });
  const student = await m2Student(ctx, 'Europe/London', family);
  const teacher = await m2Teacher(ctx, 'Africa/Cairo');
  const enrollment = await m2Enrollment(ctx, student, teacher);
  const session = await m2Session(ctx, enrollment, '2026-11-12T15:00:00Z');
  return { user: family.user, family, student, teacher, enrollment, session };
}

async function ticket(client: Client, body: Record<string, unknown>) {
  const res = await client.post('/feedback/tickets', {
    description: 'Please help me with this request',
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as {
    id: number;
    queue: string;
    visibility: string;
    slaDueAt: string;
    priority: string | null;
    channel: string;
  };
}

describe('routing (S2)', () => {
  it('routes each category to its queue and restricts teacher complaints', async () => {
    const { client } = await signedIn(ctx, 'parent');
    const cases: Array<[string, string | null, string, string]> = [
      ['classes', 'schedule_change', 'scheduling', 'normal'],
      ['teacher', 'teacher_change', 'scheduling', 'normal'],
      ['teacher', 'teacher_feedback', 'complaints', 'restricted'],
      ['billing', 'invoice_question', 'billing', 'normal'],
      ['technical', null, 'tech', 'normal'],
      ['suggestion', null, 'product', 'normal'],
      ['other', null, 'general', 'normal'],
    ];
    for (const [category, subcategory, queue, visibility] of cases) {
      const t = await ticket(client, { category, ...(subcategory ? { subcategory } : {}) });
      expect(t.queue, `${category}.${subcategory}`).toBe(queue);
      expect(t.visibility).toBe(visibility);
      expect(t.slaDueAt).not.toBeNull();
    }
  });

  it('follows the routing setting and re-routes on a category change', async () => {
    await ctx.app
      .get(SettingsService)
      .set(
        'support.queue_by_category',
        { ...SUPPORT_SETTING_DEFAULTS['support.queue_by_category'], other: 'billing' },
        null,
      );
    const parent = await signedIn(ctx, 'parent');
    const t = await ticket(parent.client, { category: 'other' });
    expect(t.queue).toBe('billing');
    const { client } = await signedIn(ctx, 'admin');
    const res = await client.patch(`/feedback/tickets/${t.id}`, { category: 'classes' });
    expect(res.body.data.queue).toBe('scheduling');
  });

  it('derives the family and teacher from the subject class', async () => {
    const f = await s2Family();
    const c = await signInAs(ctx, f.user);
    const t = await ticket(c, {
      category: 'classes',
      subcategory: 'session_issue',
      subjectType: 'session',
      subjectId: f.session.id,
    });
    const row = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.familyId).toBe(f.family.id);
    expect(row.teacherId).toBe(f.teacher.id);
  });
});

describe('SLA (S2)', () => {
  it('caps the deadline of a class-time item at the class start', async () => {
    const f = await s2Family();
    const soon = await m2Session(ctx, f.enrollment, '2026-11-10T12:00:00Z'); // in 2 hours
    const c = await signInAs(ctx, f.user);
    const a = await ticket(c, {
      category: 'classes',
      subcategory: 'session_issue',
      subjectType: 'session',
      subjectId: soon.id,
    });
    expect(a.slaDueAt).toBe('2026-11-10T12:00:00Z');
    expect(a.priority).toBe('p1');
    const b = await ticket(c, {
      category: 'classes',
      subcategory: 'session_issue',
      subjectType: 'session',
      subjectId: f.session.id,
    });
    expect(b.slaDueAt).toBe('2026-11-10T14:00:00Z'); // 12:00 Cairo + 4 h
    expect(b.priority).toBe('p2');
  });

  it('stops the clock on the first public answer from staff', async () => {
    const parent = await signedIn(ctx, 'parent');
    const t = await ticket(parent.client, { category: 'billing' });
    clock(ctx).set('2026-11-11T07:00:00Z'); // due Wednesday 12:00 Cairo (12 working hours)
    const { client } = await signedIn(ctx, 'billing');
    expect((await client.get(`/feedback/tickets/${t.id}`)).body.data.slaState).toBe('ok');
    expect(
      (
        await client.post(`/feedback/tickets/${t.id}/comments`, {
          body: 'Internal note',
          internal: true,
        })
      ).status,
    ).toBe(201);
    expect(
      (await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).firstResponseAt,
    ).toBeNull();
    await client.post(`/feedback/tickets/${t.id}/comments`, {
      body: 'We are checking the payment.',
    });
    expect((await client.get(`/feedback/tickets/${t.id}`)).body.data.slaState).toBe('met');
  });
});

describe('restricted complaints (S2, D135)', () => {
  it('never shows a complaint to the teacher it is about, and hides it without support.view_restricted', async () => {
    const f = await s2Family();
    const parent = await signInAs(ctx, f.user);
    const t = await ticket(parent, {
      category: 'teacher',
      subcategory: 'teacher_feedback',
      subjectType: 'session',
      subjectId: f.session.id,
      description: 'The teacher keeps arriving late',
    });
    expect((await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).teacherId).toBe(
      f.teacher.id,
    );
    // The reporter sees it, and in «طلباتي».
    expect((await parent.get(`/feedback/tickets/${t.id}`)).status).toBe(200);
    expect((await parent.get('/support/mine')).body.data[0].id).toBe(t.id);

    // The teacher: no, even with every support permission on their role.
    await grant(ctx, 'teacher', [
      'support.view',
      'support.handle',
      'support.manage',
      'support.view_restricted',
    ]);
    const teacher = await signInAs(ctx, f.teacher.user);
    expect((await teacher.get(`/feedback/tickets/${t.id}`)).status).toBe(404);
    const inbox = await teacher.get('/support/inbox?queue=complaints');
    expect(inbox.status).toBe(200);
    expect(inbox.body.data.map((i: { id: number }) => i.id)).not.toContain(t.id);
    expect(
      (await teacher.patch(`/feedback/tickets/${t.id}`, { status: 'in_progress' })).status,
    ).toBe(404);
    expect((await teacher.post(`/support/tickets/${t.id}/take`)).status).toBe(404);
    expect((await teacher.get('/support/summary')).body.data.queues.complaints.open).toBe(0);

    // Staff without support.view_restricted: not on the board, not in the inbox.
    const manager = await signedIn(ctx, 'manager');
    expect((await manager.client.get(`/feedback/tickets/${t.id}`)).status).toBe(404);
    const admin = await signedIn(ctx, 'admin');
    const adminInbox = await admin.client.get('/support/inbox?queue=complaints');
    expect(adminInbox.body.data.map((i: { id: number }) => i.id)).toContain(t.id);
    const sm = await signedIn(ctx, 'senior_manager');
    expect((await sm.client.get(`/feedback/tickets/${t.id}`)).status).toBe(200);
  });

  it('keeps restricted tickets off the triage board for reviewers without support.view_restricted', async () => {
    const parent = await signedIn(ctx, 'parent');
    const t = await ticket(parent.client, { category: 'teacher', subcategory: 'teacher_feedback' });
    await grant(ctx, 'manager', ['feedback.review']);
    const { client } = await signedIn(ctx, 'manager');
    const res = await client.get('/feedback/tickets?scope=all');
    expect(res.status).toBe(200);
    expect(res.body.data.map((x: { id: number }) => x.id)).not.toContain(t.id);
  });
});

describe('inbox (S2)', () => {
  it('lists pending class requests in the scheduling queue with the approve actions', async () => {
    const f = await s2Family();
    clock(ctx).set('2026-11-12T13:30:00Z'); // a late leave → pending
    const parent = await signInAs(ctx, f.user);
    const leave = await parent.post('/session-requests', {
      type: 'leave',
      sessionId: f.session.id,
      reason: 'Doctor',
    });
    expect(leave.status).toBe(201);
    expect(leave.body.data.status).toBe('pending');
    const requestId = leave.body.data.id as number;
    const t = await ticket(parent, { category: 'classes', subcategory: 'schedule_change' });
    await ticket(parent, { category: 'billing' });

    const monitor = await signedIn(ctx, 'monitor');
    const res = await monitor.client.get('/support/inbox');
    expect(res.status).toBe(200);
    expect(res.body.meta.queues).toEqual(['scheduling']);
    expect(res.body.data.map((i: { key: string }) => i.key).sort()).toEqual(
      [`request:${requestId}`, `ticket:${t.id}`].sort(),
    );
    expect(res.body.meta.counts.scheduling).toEqual({ open: 2, breached: 0, unassigned: 2 });
    const item = res.body.data.find((i: { kind: string }) => i.kind === 'session_request');
    expect(item.request.allowedActions).toEqual(['approve', 'reject']);
    expect(item.slaDueAt).toBe('2026-11-12T15:00:00Z'); // before the class
    expect(item.family.id).toBe(f.family.id);
    expect(item.teacher.id).toBe(f.teacher.id);

    expect((await monitor.client.get('/support/inbox?kind=ticket')).body.data).toHaveLength(1);
    expect((await monitor.client.get('/support/inbox?queue=billing')).status).toBe(403);
    expect(
      (await monitor.client.get(`/support/inbox?familyId=${f.family.id}`)).body.data,
    ).toHaveLength(2);
    // A priority or assignee filter leaves class requests out.
    expect((await monitor.client.get('/support/inbox?priority=p2')).body.data).toHaveLength(1);
    expect((await monitor.client.get('/support/inbox?assignee=me')).body.data).toHaveLength(0);

    // Billing sees only its queue, never class requests.
    const billing = await signedIn(ctx, 'billing');
    const b = await billing.client.get('/support/inbox');
    expect(b.body.meta.queues).toEqual(['billing']);
    expect([...new Set(b.body.data.map((i: { kind: string }) => i.kind))]).toEqual(['ticket']);
    // Parents have no inbox.
    expect((await parent.get('/support/inbox')).status).toBe(403);
  });

  it('puts breached items first and counts them for the dashboard tile', async () => {
    const parent = await signedIn(ctx, 'parent');
    const old = await ticket(parent.client, { category: 'classes' });
    clock(ctx).set('2026-11-10T16:30:00Z'); // 18:30 Cairo: the first one is 30 min late
    await ticket(parent.client, { category: 'classes' });

    const { client } = await signedIn(ctx, 'csr');
    const res = await client.get('/support/inbox?queue=scheduling');
    expect(res.body.data[0].id).toBe(old.id);
    expect(res.body.data[0].slaState).toBe('breached');
    const breached = await client.get('/support/inbox?breached=1');
    expect(breached.body.data.map((i: { id: number }) => i.id)).toEqual([old.id]);
    const summary = await client.get('/support/summary');
    expect(summary.body.data.breachedTotal).toBe(1);
    expect(summary.body.data.queues.scheduling.open).toBe(2);
    expect(summary.body.data.queues.general.open).toBe(0);
  });

  it('lets a queue member take, reply and change status, and assign only within the queue', async () => {
    const parent = await signedIn(ctx, 'parent');
    const t = await ticket(parent.client, { category: 'classes', subcategory: 'schedule_change' });
    const billingTicket = await ticket(parent.client, { category: 'billing' });
    const monitor = await signedIn(ctx, 'monitor');
    const csr = await signedIn(ctx, 'csr');
    const billing = await signedIn(ctx, 'billing');
    const m = monitor.client;

    const taken = await m.post(`/support/tickets/${t.id}/take`);
    expect(taken.status).toBe(200);
    expect(taken.body.data.assignee.id).toBe(monitor.user.id);
    expect(taken.body.data.can.manage).toBe(true);
    expect((await m.post(`/support/tickets/${billingTicket.id}/take`)).status).toBe(404);
    const progress = await m.patch(`/feedback/tickets/${t.id}`, {
      status: 'in_progress',
      note: 'Checking the teacher’s free times',
    });
    expect(progress.body.data.status).toBe('in_progress');
    // No PR for a support case.
    expect((await m.patch(`/feedback/tickets/${t.id}`, { status: 'fixed' })).status).toBe(200);
    const wrong = await m.patch(`/feedback/tickets/${t.id}`, { assigneeId: billing.user.id });
    expect(wrong.status).toBe(422);
    expect(wrong.body.errors).toHaveProperty('assigneeId');
    const ok = await m.patch(`/feedback/tickets/${t.id}`, { assigneeId: csr.user.id });
    expect(ok.body.data.assignee.id).toBe(csr.user.id);

    const names = (await m.get('/support/assignees?queue=scheduling')).body.data.map(
      (u: { id: number }) => u.id,
    );
    expect(names).toContain(monitor.user.id);
    expect(names).toContain(csr.user.id);
    expect(names).not.toContain(billing.user.id);
    expect((await m.get('/support/assignees?queue=billing')).status).toBe(422);
    // The reporter is told who handles it by first name; the status move is public.
    const mine = await parent.client.get(`/feedback/tickets/${t.id}`);
    expect(mine.body.data.handledBy).toBe(csr.user.name.split(' ')[0]);
    expect(mine.body.data.timeline.map((r: { kind: string }) => r.kind)).toEqual([
      'status',
      'status',
    ]);
  });

  it('shows the family and teacher in the side panel', async () => {
    const f = await s2Family();
    const { client } = await signedIn(ctx, 'csr');
    const res = await client.get(
      `/support/people?familyId=${f.family.id}&teacherId=${f.teacher.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.family).toMatchObject({
      id: f.family.id,
      children: [{ id: f.student.id }],
      pendingRequests: 0,
      timezone: 'Europe/London',
    });
    expect(res.body.data.teacher.timezone).toBe('Africa/Cairo');
    // Without families.view: same shape, no details.
    const accounts = await signedIn(ctx, 'accounts');
    const bare = await accounts.client.get(`/support/people?familyId=${f.family.id}`);
    expect(bare.body.data.family).toMatchObject({ id: f.family.id, status: null, children: [] });
  });
});

describe('«طلباتي» (S2)', () => {
  it('merges a parent’s tickets and class requests in one list, open first', async () => {
    const f = await s2Family();
    const parent = await signInAs(ctx, f.user);
    const closed = await ticket(parent, { category: 'other' });
    await ctx.prisma.ticket.update({
      where: { id: closed.id },
      data: { status: 'wont_fix', closedAt: new Date() },
    });
    clock(ctx).set('2026-11-12T13:30:00Z');
    const requestId = (
      await parent.post('/session-requests', {
        type: 'leave',
        sessionId: f.session.id,
        reason: 'Travel',
      })
    ).body.data.id as number;

    const res = await parent.get('/support/mine');
    expect(res.status).toBe(200);
    expect(res.body.data.map((i: { key: string }) => i.key)).toEqual([
      `request:${requestId}`,
      `ticket:${closed.id}`,
    ]);
    expect(res.body.data[0]).toMatchObject({ nextStep: 'awaiting_approval', requestType: 'leave' });
    expect(res.body.data[1].nextStep).toBeNull();
    expect(res.body.meta.open).toBe(1);
    const onlyClosed = await parent.get('/support/mine?status=closed');
    expect(onlyClosed.body.data).toHaveLength(1);
    expect(onlyClosed.body.meta.open).toBe(1);

    // Someone else's items never show.
    const other = await signedIn(ctx, 'parent');
    expect((await other.client.get('/support/mine')).body.data).toEqual([]);
  });

  it('shows a teacher only the class requests they filed', async () => {
    const f = await s2Family();
    clock(ctx).set('2026-11-12T13:30:00Z');
    const parent = await signInAs(ctx, f.user);
    await parent.post('/session-requests', {
      type: 'leave',
      sessionId: f.session.id,
      reason: 'Travel',
    });
    const teacher = await signInAs(ctx, f.teacher.user);
    expect((await teacher.get('/support/mine')).body.data).toEqual([]);
  });
});

describe('settings, channel and presets (S2)', () => {
  it('validates and saves the support settings', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const shown = await client.get('/settings/support');
    expect(shown.body.data['support.sla_hours'].scheduling).toBe(4);
    const bad = async (body: object, key: string) => {
      const res = await client.put('/settings/support', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.errors, JSON.stringify(body)).toHaveProperty([key]);
    };
    await bad({ 'support.queue_members': { scheduling: ['nobody'] } }, 'support.queue_members');
    await bad({ 'support.queue_by_category': { classes: 'nowhere' } }, 'support.queue_by_category');
    await bad(
      { 'support.queue_by_category': { 'billing.teacher_change': 'billing' } },
      'support.queue_by_category',
    );
    await bad(
      {
        'support.working_hours': {
          timezone: 'Africa/Cairo',
          days: [1, 2],
          start: '22:00',
          end: '10:00',
        },
      },
      'support.working_hours',
    );
    await bad({ 'support.unknown': 1 }, 'support.unknown');
    const saved = await client.put('/settings/support', {
      'support.sla_hours': {
        scheduling: 2,
        billing: 12,
        complaints: 12,
        tech: 12,
        product: 60,
        general: 12,
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data['support.sla_hours'].scheduling).toBe(2);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'support_settings_updated' } })).toBe(
      1,
    );

    const monitor = await signedIn(ctx, 'monitor');
    expect(
      (await monitor.client.put('/settings/support', { 'support.restricted_queues': [] })).status,
    ).toBe(403);
  });

  it('records the channel for staff filing on behalf, and refuses it from parents', async () => {
    const f = await s2Family();
    const csr = await signedIn(ctx, 'csr');
    const t = await ticket(csr.client, {
      category: 'billing',
      channel: 'phone',
      familyId: f.family.id,
    });
    expect(t.channel).toBe('phone');
    expect((await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).familyId).toBe(
      f.family.id,
    );
    const parent = await signInAs(ctx, f.user);
    const res = await parent.post('/feedback/tickets', {
      category: 'billing',
      channel: 'phone',
      description: 'Please call me back today',
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('channel');
  });

  it('has the support permissions in the presets', () => {
    expect(permissionsFor('senior_manager')).toEqual(
      expect.arrayContaining([
        'support.view',
        'support.handle',
        'support.manage',
        'support.view_restricted',
      ]),
    );
    expect(permissionsFor('monitor')).toEqual(
      expect.arrayContaining(['support.view', 'support.handle']),
    );
    expect(permissionsFor('monitor')).not.toContain('support.view_restricted');
    expect(permissionsFor('parent')).not.toContain('support.view');
    expect(permissionsFor('teacher')).not.toContain('support.view');
  });
});
