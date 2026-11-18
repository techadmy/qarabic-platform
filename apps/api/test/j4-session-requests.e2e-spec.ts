import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

/*
| Bugs found by QA journey J4 (docs/31):
| 1. P0-4 / D142: parents and teachers never get a staff member's name (or id) from
|    /session-requests, only the role; nor the reason or decision note of a request someone else made.
| 2. A parent or teacher cannot backdate a leave's `notifiedAt` into the «enough notice»
|    auto-approval; staff may record an earlier time, and it is audited.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let teacher: Awaited<ReturnType<typeof m2Teacher>>;
let family: Awaited<ReturnType<typeof makeFamily>>;
let session: Awaited<ReturnType<typeof m2Session>>;
let monitor: Client;
let monitorId: number;
let parent: Client;
let asTeacher: Client;

beforeEach(async () => {
  await resetState(ctx);
  // The class is at 15:00; leave notice is 2 hours, so from 13:00 a leave waits for a person.
  clock(ctx).set('2026-11-10T13:30:00Z');
  teacher = await m2Teacher(ctx);
  family = await makeFamily(ctx, { timezone: 'Europe/London' });
  const enrollment = await m2Enrollment(
    ctx,
    await m2Student(ctx, 'Europe/London', family),
    teacher,
  );
  session = await m2Session(ctx, enrollment, '2026-11-10T15:00:00Z');
  const signed = await signedIn(ctx, 'monitor');
  monitor = signed.client;
  monitorId = signed.user.id;
  parent = await signInAs(ctx, family.user);
  asTeacher = await signInAs(ctx, teacher.user);
});

const leave = (o: Record<string, unknown> = {}) => ({
  type: 'leave',
  sessionId: session.id,
  reason: 'Doctor appointment',
  ...o,
});
const listed = async (c: Client) => {
  const res = await c.get('/session-requests');
  expect(res.status).toBe(200);
  return res.body.data as Array<Record<string, unknown>>;
};

describe('staff names by role (P0-4)', () => {
  it('a request staff filed for the family: parent and teacher see the role only', async () => {
    const res = await monitor.post(
      '/session-requests',
      leave({ reason: 'Mother called the office' }),
    );
    expect(res.status).toBe(201);
    const monitorName = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: monitorId } }))
      .name;

    for (const [who, c] of [
      ['parent', parent],
      ['teacher', asTeacher],
    ] as const) {
      const [row] = await listed(c);
      expect(row, who).toMatchObject({
        requestedBy: { id: null, name: null, role: 'monitor' },
        decidedBy: { id: null, name: null },
        reason: '',
        decisionNote: null,
      });
      expect(JSON.stringify(row), who).not.toContain(monitorName);
      const one = await c.get(`/session-requests/${row!.id as number}`);
      expect(one.body.data.requestedBy, who).toEqual({ id: null, name: null, role: 'monitor' });
    }

    // Staff still see who filed and decided it.
    const [row] = await listed(monitor);
    expect(row).toMatchObject({
      requestedBy: { id: monitorId, name: monitorName, role: 'monitor' },
      decidedBy: { id: monitorId, name: monitorName },
      reason: 'Mother called the office',
    });
    const { client: manager } = await signedIn(ctx, 'manager');
    expect((await listed(manager))[0]).toMatchObject({ requestedBy: { name: monitorName } });
  });

  it('the parent’s own request: their own name and note, but the approver by role only', async () => {
    const created = await parent.post('/session-requests', leave());
    expect(created.body.data).toMatchObject({ status: 'pending' });
    const id = created.body.data.id as number;
    const rejected = await monitor.post(`/session-requests/${id}/reject`, {
      note: 'Too late, will be absent',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.decidedBy).toMatchObject({ id: monitorId });

    const [mine] = await listed(parent);
    expect(mine).toMatchObject({
      requestedBy: { id: family.user.id, role: 'parent' },
      reason: 'Doctor appointment',
      decidedBy: { id: null, name: null },
      decisionNote: 'Too late, will be absent',
    });
    expect((mine!.requestedBy as { name: string | null }).name).not.toBeNull();

    // The teacher sees the family's request without its text.
    const [theirs] = await listed(asTeacher);
    expect(theirs).toMatchObject({ reason: '', decisionNote: null, decidedBy: { name: null } });
  });

  it('401 without a session; 403 for a role without the inbox', async () => {
    expect((await request(ctx.app.getHttpServer()).get('/api/v1/session-requests')).status).toBe(
      401,
    );
    const { client: billing } = await signedIn(ctx, 'billing');
    expect((await billing.get('/session-requests')).status).toBe(403);
  });
});

describe('leave notice cannot be backdated (J4)', () => {
  const backdated = () => leave({ notifiedAt: '2026-11-10T09:00:00Z' });

  it('a parent’s past notifiedAt is ignored: the late leave waits for a person', async () => {
    const res = await parent.post('/session-requests', backdated());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'pending',
      notifiedAt: '2026-11-10T13:30:00Z',
    });
    const s = await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(s.stage).toBe('scheduled');
  });

  it('a teacher’s past notifiedAt is ignored too', async () => {
    const res = await asTeacher.post('/session-requests', backdated());
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
    expect(res.body.data.notifiedAt).toBe('2026-11-10T13:30:00Z');
  });

  it('a parent who really gave enough notice is still auto-approved', async () => {
    clock(ctx).set('2026-11-10T12:00:00Z');
    const res = await parent.post('/session-requests', leave());
    expect(res.body.data).toMatchObject({
      status: 'auto_approved',
      notifiedAt: '2026-11-10T12:00:00Z',
    });
  });

  it('staff may record an earlier notified time: auto-approved, and the time is audited', async () => {
    const { client: csr, user } = await signedIn(ctx, 'csr');
    const res = await csr.post('/session-requests', backdated());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'auto_approved',
      notifiedAt: '2026-11-10T09:00:00Z',
    });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { subjectType: 'session_request', subjectId: res.body.data.id, action: 'created' },
    });
    expect(audit.actorId).toBe(user.id);
    expect(audit.after).toMatchObject({ notifiedAt: '2026-11-10T09:00:00.000Z' });
  });
});
