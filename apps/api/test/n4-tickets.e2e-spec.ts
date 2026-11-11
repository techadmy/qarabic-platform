import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FileStorage } from '../src/support/storage.js';
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
  type TestContext,
} from './helpers.js';
import { fbTicket, PNG } from './n4-helpers.js';

/*
 * Port of Laravel tests/Feature/Feedback/TicketApiTest.php, TicketTypesTest.php and
 * SupportCategoryTest.php (docs/22, docs/32 S1, D99, D121): report a problem with a screenshot and
 * a sanitised context; reporters see only their own tickets (others → 404); triage with
 * feedback.review / feedback.manage; categories, subcategories and subjects in the reporter's scope.
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
  clock(ctx).set('2026-11-10T10:00:00Z');
});

const ROLES = [
  'admin',
  'senior_manager',
  'manager',
  'monitor',
  'csr',
  'billing',
  'accounts',
  'teacher',
  'parent',
];

describe('tickets (TicketApiTest)', () => {
  it('lets every role report a problem', async () => {
    for (const role of ROLES) {
      const { client } = await signedIn(ctx, role);
      const res = await client.post('/feedback/tickets', {
        description: 'Something is not right here',
      });
      expect(res.status, role).toBe(201);
      expect(res.body.data.status, role).toBe('new');
    }
  });

  it('creates a ticket with a screenshot, uploads and a sanitised context', async () => {
    const { client, user } = await signedIn(ctx, 'monitor');
    const res = await client.upload(
      '/feedback/tickets',
      {
        type: 'bug',
        description: 'The board shows yesterday\nSteps: open Today at 9pm Cairo',
        context: JSON.stringify({
          pageUrl: '/monitor/today?tab=late&token=secret123&email=a@b.c',
          area: 'sessions',
          appVersion: 'abc1234',
          userAgent: 'Mozilla/5.0',
          timeZone: 'Africa/Cairo',
          password: 'never-stored',
          recentErrors: [
            {
              method: 'get',
              path: '/api/v1/sessions/board?date=2026-11-09',
              status: 500,
              requestId: 'req-1',
            },
          ],
        }),
      },
      [
        ['screenshot', PNG, 'shot.png'],
        ['attachments', PNG, 'extra.jpg'],
      ],
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      title: 'The board shows yesterday',
      type: 'bug',
      category: 'technical',
      queue: 'tech',
      reporter: { id: user.id, role: 'monitor' },
    });
    expect(res.body.data.attachments).toHaveLength(2);

    const ticket = await ctx.prisma.ticket.findFirstOrThrow();
    const context = ticket.context as Record<string, unknown>;
    expect(ticket.area).toBe('sessions');
    expect(context.pageUrl).toBe('/monitor/today?tab=late');
    expect(context).not.toHaveProperty('password');
    expect(context.recentErrors).toEqual([
      { method: 'GET', path: '/api/v1/sessions/board', status: 500, requestId: 'req-1' },
    ]);
    expect(ticket.reporterRole).toBe('monitor');

    const shot = await ctx.prisma.ticketAttachment.findFirstOrThrow({
      where: { source: 'screenshot' },
    });
    expect(shot.storageKey.startsWith(`tickets/${ticket.id}/`)).toBe(true);
    expect(shot.storageKey.endsWith('.png')).toBe(true);
    expect(shot.mime).toBe('image/png');
    expect(await ctx.app.get(FileStorage).get(shot.storageKey)).toEqual(PNG);
    // The client's ".jpg" name does not decide the type: the bytes are a PNG.
    const extra = await ctx.prisma.ticketAttachment.findFirstOrThrow({
      where: { source: 'upload' },
    });
    expect(extra.mime).toBe('image/png');
    expect(extra.originalName).toBe('extra.jpg');
    // Personal fields are not copied into the audit log.
    const log = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { subjectType: 'ticket', subjectId: ticket.id },
    });
    expect(JSON.stringify(log.after)).not.toContain('board shows');
  });

  it('rejects non-images, SVG, oversized and too many files', async () => {
    const { client } = await signedIn(ctx, 'teacher');
    const base = { description: 'Upload validation case' };
    const pdf = await client.upload('/feedback/tickets', base, [
      ['screenshot', Buffer.from('%PDF-1.7 fake'), 'x.pdf'],
    ]);
    expect(pdf.status).toBe(422);
    expect(pdf.body.errors).toHaveProperty('screenshot');
    const svg = await client.upload('/feedback/tickets', base, [
      ['screenshot', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'x.png'],
    ]);
    expect(svg.status).toBe(422);
    expect(svg.body.errors).toHaveProperty('screenshot');
    const big = Buffer.concat([PNG, Buffer.alloc(6000 * 1024)]);
    const oversized = await client.upload('/feedback/tickets', base, [
      ['screenshot', big, 'big.png'],
    ]);
    expect(oversized.status).toBe(422);
    expect(oversized.body.errors).toHaveProperty('screenshot');
    const many = await client.upload(
      '/feedback/tickets',
      base,
      [1, 2, 3, 4].map((i) => ['attachments', PNG, `a${i}.png`] as [string, Buffer, string]),
    );
    expect(many.status).toBe(422);
    expect(many.body.errors).toHaveProperty('attachments');
    const short = await client.post('/feedback/tickets', { description: 'short' });
    expect(short.status).toBe(422);
    expect(short.body.errors).toHaveProperty('description');
    expect(await ctx.prisma.ticket.count()).toBe(0);
    expect(await ctx.prisma.ticketAttachment.count()).toBe(0);
  });

  it('shows reporters only their own tickets and hides others as 404', async () => {
    const alice = await signedIn(ctx, 'parent');
    const bob = await signedIn(ctx, 'teacher');
    const mine = await fbTicket(ctx, alice.user);
    const theirs = await fbTicket(ctx, bob.user);
    const c = alice.client;

    const list = await c.get('/feedback/tickets');
    expect(list.status).toBe(200);
    expect(list.body.data.map((t: { id: number }) => t.id)).toEqual([mine.id]);
    expect(list.body.meta.scope).toBe('mine');
    expect((await c.get('/feedback/tickets?scope=all')).status).toBe(403);
    expect((await c.get(`/feedback/tickets/${theirs.id}`)).status).toBe(404);
    expect((await c.post(`/feedback/tickets/${theirs.id}/comments`, { body: 'hi' })).status).toBe(
      404,
    );
    expect((await c.patch(`/feedback/tickets/${mine.id}`, { priority: 'p0' })).status).toBe(403);
    expect((await c.get('/feedback/tickets/999999')).status).toBe(404);

    const own = await c.get(`/feedback/tickets/${mine.id}`);
    expect(own.status).toBe(200);
    expect(own.body.data).not.toHaveProperty('prUrl');
    expect(own.body.data).not.toHaveProperty('assignee');
    expect(own.body.data.context).not.toHaveProperty('recentErrors');
    expect(own.body.data.can.manage).toBe(false);
  });

  it('requires a session and the permission', async () => {
    const anon = await signedIn(ctx, null);
    expect(
      (await anon.client.post('/feedback/tickets', { description: 'No role at all here' })).status,
    ).toBe(403);
    const { client } = await signedIn(ctx, 'parent');
    await client.post('/auth/logout');
    expect((await client.get('/feedback/tickets')).status).toBe(401);
  });

  it('lists all tickets for triagers with filters, search and status counts', async () => {
    const t1 = await fbTicket(ctx, (await signedIn(ctx, 'monitor')).user, {
      priority: 'p1',
      status: 'triaged',
    });
    const t2 = await fbTicket(
      ctx,
      (await signedIn(ctx, 'parent')).user,
      {},
      'Invoice total looks wrong',
    );
    const t3 = await fbTicket(ctx, (await signedIn(ctx, 'teacher')).user, {
      type: 'feature',
      status: 'wont_fix',
      closedAt: new Date(),
    });
    const { client } = await signedIn(ctx, 'senior_manager');

    const all = await client.get('/feedback/tickets');
    expect(all.body.meta.scope).toBe('all');
    expect(all.body.data).toHaveLength(3);
    expect(all.body.meta.counts).toMatchObject({ all: 3, new: 1, triaged: 1, wont_fix: 1 });
    expect(all.body.data[0].id).toBe(t2.id); // untriaged first
    expect(all.body.data[2].id).toBe(t3.id); // closed last
    const ids = async (qs: string): Promise<number[]> =>
      ((await client.get(`/feedback/tickets?${qs}`)).body.data as Array<{ id: number }>).map(
        (t) => t.id,
      );
    expect(await ids('status=open')).toHaveLength(2);
    expect(await ids('priority=p1')).toEqual([t1.id]);
    expect(await ids('type=feature')).toEqual([t3.id]);
    expect(await ids('q=invoice')).toEqual([t2.id]);
    expect((await ids(`q=%23${t3.id}`))[0]).toBe(t3.id);
    expect(await ids('assigneeId=none')).toHaveLength(3);
    const detail = await client.get(`/feedback/tickets/${t1.id}`);
    expect(detail.body.data.can.manage).toBe(true);
    expect(detail.body.data.context.area).toBe('sessions');
  });

  it('applies the lifecycle rules', async () => {
    const reporter = await signedIn(ctx, 'monitor');
    const ticket = await fbTicket(ctx, reporter.user);
    const admin = await signedIn(ctx, 'admin');
    const url = `/feedback/tickets/${ticket.id}`;
    const err = async (body: object, field: string) => {
      const res = await admin.client.patch(url, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.errors, JSON.stringify(body)).toHaveProperty(field);
    };

    await err({ status: 'triaged' }, 'priority');
    await err({ status: 'fixed' }, 'status'); // new → fixed is not allowed
    await err({ status: 'needs_info' }, 'note');

    const triaged = await admin.client.patch(url, {
      priority: 'p1',
      status: 'triaged',
      area: 'sessions',
      assigneeId: admin.user.id,
    });
    expect(triaged.status).toBe(200);
    expect(triaged.body.data).toMatchObject({
      status: 'triaged',
      priority: 'p1',
      assignee: { id: admin.user.id },
    });
    // The monitor does not handle the tech queue.
    await err({ assigneeId: reporter.user.id }, 'assigneeId');

    expect(
      (await admin.client.patch(url, { status: 'needs_info', note: 'Which child?' })).status,
    ).toBe(200);
    // The reporter's answer moves it back to triaged; `internal` is ignored for them.
    const answer = await reporter.client.post(`${url}/comments`, {
      body: 'Ahmed, the younger one',
      internal: true,
    });
    expect(answer.status).toBe(201);
    expect(answer.body.data.internal).toBe(false);
    expect((await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe(
      'triaged',
    );

    expect((await admin.client.patch(url, { status: 'in_progress' })).status).toBe(200);
    await err({ status: 'fixed' }, 'prUrl');
    await err({ prUrl: 'https://evil.example.com/pull/1' }, 'prUrl');
    const fixed = await admin.client.patch(url, {
      status: 'fixed',
      prUrl: 'https://github.com/qarabicacademy/qarabic-backend/pull/30',
      resolution: 'The board now uses your time zone.',
    });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data).toMatchObject({
      status: 'fixed',
      prUrl: 'https://github.com/qarabicacademy/qarabic-backend/pull/30',
    });
    const fresh = await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(fresh.triagedAt).not.toBeNull();
    expect(fresh.fixedAt).not.toBeNull();
    expect(fresh.closedAt).toBeNull();
    // Every status change is in the audit log with its note.
    const logs = await ctx.prisma.auditLog.findMany({
      where: { subjectType: 'ticket', subjectId: ticket.id, action: 'status_changed' },
    });
    expect(logs.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps internal comments and assignment away from the reporter', async () => {
    const reporter = await signedIn(ctx, 'teacher');
    const ticket = await fbTicket(ctx, reporter.user, { priority: 'p2', status: 'triaged' });
    const admin = await signedIn(ctx, 'admin');
    const url = `/feedback/tickets/${ticket.id}`;
    expect(
      (
        await admin.client.post(`${url}/comments`, {
          body: 'Root cause: cached query',
          internal: true,
        })
      ).status,
    ).toBe(201);
    expect((await admin.client.patch(url, { assigneeId: admin.user.id })).status).toBe(200);
    clock(ctx).set('2026-11-10T10:01:00Z');
    expect(
      (await admin.client.post(`${url}/comments`, { body: 'Thanks, we are on it' })).status,
    ).toBe(201);

    const mine = await reporter.client.get(url);
    const timeline = mine.body.data.timeline as Array<{ body: string | null; kind: string }>;
    expect(timeline.map((r) => r.body).filter(Boolean)).toEqual(['Thanks, we are on it']);
    expect(timeline.map((r) => r.kind)).not.toContain('assignment');
    expect(mine.body.data).not.toHaveProperty('assignee');
    expect(mine.body.data.handledBy).toBe(admin.user.name.split(' ')[0]);
    expect(mine.body.data.hasUpdate).toBe(true);
    expect((await reporter.client.get('/feedback/summary')).body.data).toEqual({
      mineUpdates: 1,
      triageNew: null,
    });
    expect((await reporter.client.post(`${url}/seen`)).status).toBe(204);
    expect((await reporter.client.get('/feedback/summary')).body.data.mineUpdates).toBe(0);
  });

  it('lets the reporter confirm a fix or reopen it with what still happens', async () => {
    const reporter = await signedIn(ctx, 'parent');
    const fixed = {
      priority: 'p1' as const,
      status: 'fixed' as const,
      prUrl: 'https://github.com/qarabicacademy/qarabic-backend/pull/31',
    };
    const a = await fbTicket(ctx, reporter.user, fixed);
    const b = await fbTicket(ctx, reporter.user, fixed);
    const c = await fbTicket(ctx, reporter.user, { priority: 'p1', status: 'triaged' });
    const r = reporter.client;

    const ok = await r.post(`/feedback/tickets/${a.id}/confirm`, { resolved: true });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('verified');
    expect(
      (await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: a.id } })).closedAt,
    ).not.toBeNull();
    const noBody = await r.post(`/feedback/tickets/${b.id}/confirm`, { resolved: false });
    expect(noBody.status).toBe(422);
    expect(noBody.body.errors).toHaveProperty('body');
    const again = await r.post(`/feedback/tickets/${b.id}/confirm`, {
      resolved: false,
      body: 'Still shows yesterday',
    });
    expect(again.body.data.status).toBe('triaged');
    expect((await r.post(`/feedback/tickets/${c.id}/confirm`, { resolved: true })).status).toBe(
      422,
    );

    // Closed: the reporter can no longer reply; somebody else cannot confirm.
    const late = await r.post(`/feedback/tickets/${a.id}/comments`, { body: 'one more thing' });
    expect(late.status).toBe(422);
    expect(late.body.errors).toHaveProperty('body');
    const other = await signedIn(ctx, 'parent');
    expect(
      (await other.client.post(`/feedback/tickets/${b.id}/confirm`, { resolved: true })).status,
    ).toBe(404);
  });

  it('streams attachments only to the reporter and triagers, never without a session', async () => {
    const reporter = await signedIn(ctx, 'teacher');
    const created = await reporter.client.upload(
      '/feedback/tickets',
      { description: 'Screenshot attached here' },
      [['screenshot', PNG, 's.png']],
    );
    expect(created.status).toBe(201);
    const id = created.body.data.attachments[0].id as number;
    expect(created.body.data.attachments[0].url).toBe(`/api/v1/feedback/attachments/${id}`);

    const own = await reporter.client.download(`/feedback/attachments/${id}`);
    expect(own.status).toBe(200);
    expect(own.headers['x-content-type-options']).toBe('nosniff');
    expect(own.headers['content-type']).toBe('image/png');
    expect(own.headers['content-security-policy']).toContain('sandbox');
    expect(own.headers['cache-control']).toBe('private, max-age=300');
    expect(own.body).toEqual(PNG);
    const stranger = await signedIn(ctx, 'teacher');
    expect((await stranger.client.download(`/feedback/attachments/${id}`)).status).toBe(404);
    expect(
      (await (await signedIn(ctx, 'admin')).client.download(`/feedback/attachments/${id}`)).status,
    ).toBe(200);
    await reporter.client.post('/auth/logout');
    expect((await reporter.client.download(`/feedback/attachments/${id}`)).status).toBe(401);
    // A pruned file answers 410.
    await ctx.prisma.ticketAttachment.update({ where: { id }, data: { prunedAt: new Date() } });
    const admin = await signedIn(ctx, 'admin');
    expect((await admin.client.download(`/feedback/attachments/${id}`)).status).toBe(410);
  });

  it('keeps files of internal notes away from the reporter', async () => {
    const reporter = await signedIn(ctx, 'parent');
    const ticket = await fbTicket(ctx, reporter.user, { priority: 'p2', status: 'triaged' });
    const admin = await signedIn(ctx, 'admin');
    const note = await admin.client.upload(
      `/feedback/tickets/${ticket.id}/comments`,
      { body: 'Server log attached', internal: 'true' },
      [['attachments', PNG, 'log.png']],
    );
    expect(note.status).toBe(201);
    const fileId = note.body.data.attachments[0].id as number;
    expect((await reporter.client.download(`/feedback/attachments/${fileId}`)).status).toBe(404);
    const seen = await reporter.client.get(`/feedback/tickets/${ticket.id}`);
    expect(seen.body.data.attachments).toEqual([]);
    expect((await admin.client.download(`/feedback/attachments/${fileId}`)).status).toBe(200);
  });

  it('rate-limits ticket creation per user (10 an hour)', async () => {
    const { client } = await signedIn(ctx, 'csr');
    for (let i = 1; i <= 10; i++) {
      expect(
        (await client.post('/feedback/tickets', { description: `Report text number ${i}` })).status,
      ).toBe(201);
    }
    expect(
      (await client.post('/feedback/tickets', { description: 'One report too many' })).status,
    ).toBe(429);
    // Another user is not affected.
    const other = await signedIn(ctx, 'csr');
    expect(
      (await other.client.post('/feedback/tickets', { description: 'Another person here' })).status,
    ).toBe(201);
  });

  it('lists the people a ticket can be assigned to', async () => {
    const admin = await signedIn(ctx, 'admin');
    const sm = await signedIn(ctx, 'senior_manager');
    const monitor = await signedIn(ctx, 'monitor');
    const res = await admin.client.get('/feedback/assignees');
    expect(res.status).toBe(200);
    expect(res.body.data.map((u: { id: number }) => u.id).sort()).toEqual(
      [admin.user.id, sm.user.id].sort(),
    );
    expect((await monitor.client.get('/feedback/assignees')).status).toBe(403);
  });
});

describe('ticket types (TicketTypesTest, D121)', () => {
  it('accepts bug and feature and rejects the retired types', async () => {
    const { client } = await signedIn(ctx, 'teacher');
    const feature = await client.post('/feedback/tickets', {
      type: 'feature',
      description: 'Let me print the weekly schedule',
    });
    expect(feature.body.data.type).toBe('feature');
    const bug = await client.post('/feedback/tickets', {
      description: 'The board shows the wrong time',
    });
    expect(bug.body.data.type).toBe('bug');
    for (const old of ['improvement', 'question']) {
      const res = await client.post('/feedback/tickets', {
        type: old,
        description: 'Something long enough',
      });
      expect(res.status).toBe(422);
      expect(res.body.errors).toHaveProperty('type');
    }
  });

  it('needs a PR link before a technical feature request is marked fixed', async () => {
    const ticket = await fbTicket(ctx, (await signedIn(ctx, 'teacher')).user, { type: 'feature' });
    const { client } = await signedIn(ctx, 'admin');
    const url = `/feedback/tickets/${ticket.id}`;
    expect((await client.patch(url, { priority: 'p3', status: 'triaged' })).status).toBe(200);
    const res = await client.patch(url, { status: 'fixed' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('prUrl');
    const ok = await client.patch(url, {
      status: 'fixed',
      prUrl: 'https://github.com/qarabicacademy/qarabic-app/pull/7',
    });
    expect(ok.body.data.status).toBe('fixed');
  });
});

/** A parent with one child, an enrollment and one upcoming class (Laravel `supportFamily`). */
async function supportFamily() {
  const family = await makeFamily(ctx, { timezone: 'Europe/London' });
  const student = await m2Student(ctx, 'Europe/London', family);
  const teacher = await m2Teacher(ctx);
  const enrollment = await m2Enrollment(ctx, student, teacher);
  const session = await m2Session(ctx, enrollment, '2026-12-01T16:00:00Z');
  return { user: family.user, family, student, teacher, session };
}

describe('support categories (SupportCategoryTest, docs/32 S1)', () => {
  const body = { description: 'I would like some help with this please' };

  it('creates a ticket with each category and keeps type in step', async () => {
    const { client } = await signedIn(ctx, 'parent');
    const cases: Array<[string, string, string | null]> = [
      ['classes', 'feature', 'schedule_change'],
      ['teacher', 'feature', 'teacher_change'],
      ['billing', 'feature', 'subscription_change'],
      ['technical', 'bug', null],
      ['suggestion', 'feature', null],
      ['other', 'feature', null],
    ];
    for (const [category, type, subcategory] of cases) {
      const res = await client.post('/feedback/tickets', {
        ...body,
        category,
        ...(subcategory ? { subcategory } : {}),
      });
      expect(res.status, category).toBe(201);
      expect(res.body.data).toMatchObject({ category, subcategory, type, subject: null });
    }
  });

  it('derives the category from the legacy type for old clients', async () => {
    const { client } = await signedIn(ctx, 'teacher');
    const bug = await client.post('/feedback/tickets', {
      description: 'The board shows the wrong time',
    });
    expect(bug.body.data).toMatchObject({ type: 'bug', category: 'technical' });
    const feature = await client.post('/feedback/tickets', {
      type: 'feature',
      description: 'Let me print the weekly schedule',
    });
    expect(feature.body.data.category).toBe('suggestion');
  });

  it('rejects an unknown category and a subcategory outside its category', async () => {
    const { client } = await signedIn(ctx, 'parent');
    const err = async (extra: object, field: string) => {
      const res = await client.post('/feedback/tickets', { ...body, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(422);
      expect(res.body.errors, JSON.stringify(extra)).toHaveProperty(field);
    };
    await err({ category: 'complaint' }, 'category');
    await err({ category: 'billing', subcategory: 'teacher_change' }, 'subcategory');
    await err({ category: 'technical', subcategory: 'schedule_change' }, 'subcategory');
    await err({ category: 'classes', subjectType: 'session' }, 'subjectId');
  });

  it('links a family ticket to its own class and child', async () => {
    const f = await supportFamily();
    const c = await signInAs(ctx, f.user);
    const cls = await c.post('/feedback/tickets', {
      category: 'classes',
      subcategory: 'session_issue',
      subjectType: 'session',
      subjectId: f.session.id,
      description: 'The teacher did not join this class',
    });
    expect(cls.status).toBe(201);
    expect(cls.body.data.subject).toEqual({ type: 'session', id: f.session.id });
    const child = await c.post('/feedback/tickets', {
      category: 'teacher',
      subcategory: 'progress_question',
      subjectType: 'student',
      subjectId: f.student.id,
      description: 'How is my son doing with his memorisation?',
    });
    expect(child.body.data.subject.type).toBe('student');
    // Invoices arrive with billing: until then no invoice can be linked.
    const invoice = await c.post('/feedback/tickets', {
      category: 'billing',
      subcategory: 'invoice_question',
      subjectType: 'invoice',
      subjectId: 1,
      description: 'I paid this invoice but it still shows unpaid',
    });
    expect(invoice.status).toBe(422);
    expect(invoice.body.errors).toHaveProperty('subjectId');
  });

  it('rejects a subject outside the reporter scope', async () => {
    const mine = await supportFamily();
    const other = await supportFamily();
    const base = { category: 'classes', description: 'Something long enough to send' };
    const asParent = await signInAs(ctx, mine.user);
    for (const [subjectType, subjectId] of [
      ['session', other.session.id],
      ['student', other.student.id],
      ['session', 999999],
    ] as const) {
      const res = await asParent.post('/feedback/tickets', { ...base, subjectType, subjectId });
      expect(res.status, `${subjectType} ${subjectId}`).toBe(422);
      expect(res.body.errors).toHaveProperty('subjectId');
    }
    // A teacher: their own class yes, another teacher's class and any invoice no.
    const asTeacher = await signInAs(ctx, mine.teacher.user);
    expect(
      (
        await asTeacher.post('/feedback/tickets', {
          ...base,
          subjectType: 'session',
          subjectId: mine.session.id,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await asTeacher.post('/feedback/tickets', {
          ...base,
          subjectType: 'session',
          subjectId: other.session.id,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await asTeacher.post('/feedback/tickets', {
          ...base,
          category: 'billing',
          subjectType: 'invoice',
          subjectId: 1,
        })
      ).status,
    ).toBe(422);
    expect(await ctx.prisma.ticket.count()).toBe(1);
  });

  it('filters the triage list by category and lets triage re-categorise', async () => {
    const reporter = (await signedIn(ctx, 'parent')).user;
    const tech = await fbTicket(ctx, reporter);
    const billing = await fbTicket(ctx, reporter, {}, 'Billing question text', {
      category: 'billing',
    });
    const classes = await fbTicket(ctx, reporter, {}, 'Classes question text', {
      category: 'classes',
    });
    const { client } = await signedIn(ctx, 'admin');
    const ids = async (qs: string): Promise<number[]> =>
      ((await client.get(`/feedback/tickets?${qs}`)).body.data as Array<{ id: number }>).map(
        (t) => t.id,
      );
    expect(await ids('category=billing')).toEqual([billing.id]);
    expect((await ids('category=billing&category=classes')).sort()).toEqual(
      [billing.id, classes.id].sort(),
    );
    const bad = await client.get('/feedback/tickets?category=nope');
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toHaveProperty('category.0');

    const recat = await client.patch(`/feedback/tickets/${tech.id}`, { category: 'billing' });
    expect(recat.body.data).toMatchObject({
      category: 'billing',
      type: 'feature',
      queue: 'billing',
    });
    const retype = await client.patch(`/feedback/tickets/${billing.id}`, { type: 'bug' });
    expect(retype.body.data.category).toBe('technical');
  });

  it('keeps the reporter list scoped when filtering by category', async () => {
    const me = await signedIn(ctx, 'parent');
    const mine = await fbTicket(ctx, me.user, {}, 'Billing question text', { category: 'billing' });
    await fbTicket(ctx, (await signedIn(ctx, 'parent')).user, {}, 'Billing question text', {
      category: 'billing',
    });
    const res = await me.client.get('/feedback/tickets?category=billing');
    expect(res.body.data.map((t: { id: number }) => t.id)).toEqual([mine.id]);
  });
});
