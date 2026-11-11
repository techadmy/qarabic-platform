import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionJobs } from '../src/sessions/jobs.js';
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

/* Port of Laravel tests/Feature/M2/SessionRequestsTest.php (D46, D135, docs/14 §3.4). */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let teacher: Awaited<ReturnType<typeof m2Teacher>>;
let family: Awaited<ReturnType<typeof makeFamily>>;
let enrollment: Awaited<ReturnType<typeof m2Enrollment>>;
let session: Awaited<ReturnType<typeof m2Session>>;
let monitor: Client;
let monitorId: number;

beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-10T10:00:00Z');
  teacher = await m2Teacher(ctx);
  family = await makeFamily(ctx, { timezone: 'Europe/London' });
  enrollment = await m2Enrollment(ctx, await m2Student(ctx, 'Europe/London', family), teacher);
  session = await m2Session(ctx, enrollment, '2026-11-10T15:00:00Z');
  const signed = await signedIn(ctx, 'monitor');
  monitor = signed.client;
  monitorId = signed.user.id;
});

const req = (o: Record<string, unknown> = {}) => ({
  type: 'leave',
  sessionId: session.id,
  reason: 'Doctor appointment',
  ...o,
});
const stage = async (id = session.id) =>
  (await ctx.prisma.classSession.findUniqueOrThrow({ where: { id } })).stage;

describe('session requests (SessionRequestsTest)', () => {
  it('auto-approves a leave notified at least 2 hours before', async () => {
    const asParent = await signInAs(ctx, family.user);
    const res = await asParent.post('/session-requests', req());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'auto_approved',
      resultSessionId: session.id,
      requestedBy: { role: 'parent' },
    });
    expect(await stage()).toBe('leave');
    const last = await ctx.prisma.sessionEvent.findFirstOrThrow({
      where: { sessionId: session.id },
      orderBy: { id: 'desc' },
    });
    expect((last.payload as { requestId?: number }).requestId).toBe(res.body.data.id);
  });

  it('sends a late leave to the approvers, who approve it', async () => {
    clock(ctx).set('2026-11-10T13:30:00Z');
    const asParent = await signInAs(ctx, family.user);
    const created = await asParent.post('/session-requests', req());
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'pending', allowedActions: ['cancel'] });
    expect(created.body.data.dueAt).toBe('2026-11-10T15:00:00Z');
    const dup = await asParent.post('/session-requests', req()); // one pending per type and class
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('conflict');

    const counts = await monitor.get('/session-requests?countOnly=1');
    expect(counts.body.data).toMatchObject({ pending: 1, byType: { leave: 1, extra: 0 } });
    const pending = await monitor.get('/session-requests?status=pending');
    expect(pending.body.data[0].allowedActions).toEqual(['approve', 'reject']);
    expect(pending.body.meta.counts).toMatchObject({ all: 1, pending: 1 });

    const id = created.body.data.id as number;
    const ok = await monitor.post(`/session-requests/${id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'approved', decidedBy: { id: monitorId } });
    expect(await stage()).toBe('leave');
    expect((await monitor.post(`/session-requests/${id}/approve`)).status).toBe(409);
  });

  it('rejects with a required note, and lets the requester cancel a pending request', async () => {
    clock(ctx).set('2026-11-10T13:30:00Z');
    const asParent = await signInAs(ctx, family.user);
    const id = (await asParent.post('/session-requests', req())).body.data.id as number;
    expect((await asParent.post(`/session-requests/${id}/reject`, { note: 'x' })).status).toBe(403);

    const noNote = await monitor.post(`/session-requests/${id}/reject`);
    expect(noNote.status).toBe(422);
    expect(noNote.body.errors.note).toBeDefined();
    const rejected = await monitor.post(`/session-requests/${id}/reject`, {
      note: 'Too late, will be absent',
    });
    expect(rejected.body.data.status).toBe('rejected');
    expect(await stage()).toBe('scheduled');

    const id2 = (await asParent.post('/session-requests', req())).body.data.id as number;
    const asTeacher = await signInAs(ctx, teacher.user);
    expect((await asTeacher.post(`/session-requests/${id2}/cancel`)).status).toBe(403);
    const cancelled = await asParent.post(`/session-requests/${id2}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');
  });

  it('books a make-up for a leave class within the window, keeping the original as leave', async () => {
    const asParent = await signInAs(ctx, family.user);
    expect((await asParent.post('/session-requests', req())).status).toBe(201);

    const tooLate = await asParent.post(
      '/session-requests',
      req({ type: 'reschedule', proposedStartsAt: '2026-11-30T15:00:00Z' }),
    );
    expect(tooLate.status).toBe(422);
    expect(tooLate.body.errors.proposedStartsAt).toBeDefined();
    const created = await asParent.post(
      '/session-requests',
      req({ type: 'reschedule', proposedStartsAt: '2026-11-12T15:00:00Z' }),
    );
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('pending');

    const approved = await monitor.post(`/session-requests/${created.body.data.id}/approve`, {
      acknowledgeWarnings: ['outside_work_hours'],
    });
    expect(approved.status).toBe(200);
    const made = await ctx.prisma.classSession.findUniqueOrThrow({
      where: { id: approved.body.data.resultSessionId },
    });
    expect([made.kind, made.originSessionId, made.source, made.startsAt.toISOString()]).toEqual([
      'rescheduled',
      session.id,
      'request',
      '2026-11-12T15:00:00.000Z',
    ]);
    expect(await stage()).toBe('leave');
  });

  it('moves a scheduled class on an approved advance (invariant 7)', async () => {
    const asTeacher = await signInAs(ctx, teacher.user);
    const later = await m2Session(ctx, enrollment, '2026-11-17T15:00:00Z');
    const created = await asTeacher.post(
      '/session-requests',
      req({ type: 'advance', sessionId: later.id, proposedStartsAt: '2026-11-16T15:00:00Z' }),
    );
    expect(created.status).toBe(201);

    const approved = await monitor.post(`/session-requests/${created.body.data.id}/approve`);
    const newId = approved.body.data.resultSessionId as number;
    const moved = await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: later.id } });
    expect([moved.stage, moved.stageReason]).toEqual(['moved_out', 'advanced']);
    const made = await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: newId } });
    expect([made.kind, made.originSessionId]).toEqual(['advance', later.id]);
  });

  it('rolls everything back when the approved time conflicts (409)', async () => {
    const later = await m2Session(ctx, enrollment, '2026-11-17T15:00:00Z');
    await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), teacher),
      '2026-11-18T15:00:00Z',
    );
    const asParent = await signInAs(ctx, family.user);
    const id = (
      await asParent.post(
        '/session-requests',
        req({ type: 'reschedule', sessionId: later.id, proposedStartsAt: '2026-11-18T15:15:00Z' }),
      )
    ).body.data.id as number;

    const clash = await monitor.post(`/session-requests/${id}/approve`);
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('schedule_conflict');
    expect(await stage(later.id)).toBe('scheduled');
    expect((await ctx.prisma.sessionRequest.findUniqueOrThrow({ where: { id } })).status).toBe(
      'pending',
    );

    // the approver changes the time in the approve call
    const ok = await monitor.post(`/session-requests/${id}/approve`, {
      startsAt: '2026-11-18T17:00:00Z',
      acknowledgeWarnings: ['outside_work_hours'],
    });
    expect(ok.status).toBe(200);
    expect(await stage(later.id)).toBe('moved_out');
  });

  it('gives an extra class for an absent class, requested by staff only, approved on creation', async () => {
    const absent = await m2Session(ctx, enrollment, '2026-11-09T15:00:00Z', {
      stage: 'absent',
      activatedAt: '2026-11-09T15:00:00Z',
    });
    const asParent = await signInAs(ctx, family.user);
    const body = req({
      type: 'extra',
      sessionId: absent.id,
      proposedStartsAt: '2026-11-11T15:00:00Z',
    });
    expect((await asParent.post('/session-requests', body)).status).toBe(403);

    const res = await monitor.post('/session-requests', body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'approved', decidedBy: { id: monitorId } });
    const extra = await ctx.prisma.classSession.findFirstOrThrow({ where: { kind: 'extra' } });
    expect(extra.originSessionId).toBe(absent.id);
  });

  it('auto-approves a reschedule into the teacher’s work hours at least 12 hours ahead (D135)', async () => {
    await ctx.prisma.teacherWorkHour.create({
      data: {
        teacherId: teacher.id,
        weekday: 4,
        localStartTime: '14:00',
        localEndTime: '22:00',
        timezone: 'Africa/Cairo',
      },
    });
    const asParent = await signInAs(ctx, family.user);
    // Thursday 12 Nov 15:00 UTC = 17:00 Cairo, inside the hours, more than 12 h ahead
    const res = await asParent.post(
      '/session-requests',
      req({ type: 'reschedule', proposedStartsAt: '2026-11-12T15:00:00Z' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('auto_approved');
    expect(await stage()).toBe('moved_out');
  });

  it('scopes the inbox and blocks requests on other families', async () => {
    clock(ctx).set('2026-11-10T13:30:00Z');
    const asParent = await signInAs(ctx, family.user);
    expect((await asParent.post('/session-requests', req())).status).toBe(201);
    const foreign = await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), await m2Teacher(ctx)),
      '2026-11-11T15:00:00Z',
    );
    expect((await asParent.post('/session-requests', req({ sessionId: foreign.id }))).status).toBe(
      404,
    );

    const stranger = await signInAs(ctx, (await m2Teacher(ctx)).user);
    expect((await stranger.get('/session-requests')).body.data).toHaveLength(0);
    const asTeacher = await signInAs(ctx, teacher.user);
    const mine = await asTeacher.get('/session-requests');
    expect(mine.body.data).toHaveLength(1);
    expect(Object.keys(mine.body.data[0])).toEqual(
      expect.arrayContaining([
        'id',
        'type',
        'status',
        'session',
        'student',
        'requestedBy',
        'reason',
        'notifiedAt',
        'proposedStartsAt',
        'proposedTeacherId',
        'decidedBy',
        'decidedAt',
        'decisionNote',
        'resultSessionId',
        'allowedActions',
        'createdAt',
      ]),
    );
    expect(mine.body.data[0].session).toMatchObject({ id: session.id, stage: 'scheduled' });
    expect((await asTeacher.post(`/session-requests/${mine.body.data[0].id}/approve`)).status).toBe(
      403,
    );
  });

  it('expires pending requests when their class starts', async () => {
    clock(ctx).set('2026-11-10T13:30:00Z');
    const asParent = await signInAs(ctx, family.user);
    const id = (await asParent.post('/session-requests', req())).body.data.id as number;

    clock(ctx).set('2026-11-10T15:00:01Z');
    expect(await ctx.app.get(SessionJobs).expireRequests()).toBe(1);
    expect((await ctx.prisma.sessionRequest.findUniqueOrThrow({ where: { id } })).status).toBe(
      'expired',
    );
  });

  it('shows pending requests on the session and in attention', async () => {
    clock(ctx).set('2026-11-10T13:30:00Z');
    const asParent = await signInAs(ctx, family.user);
    expect((await asParent.post('/session-requests', req())).status).toBe(201);

    const res = await monitor.get(`/sessions/${session.id}`);
    expect(res.body.data.pendingRequests[0].type).toBe('leave');
    expect(res.body.data.attention).toEqual(['pending_request']);
    expect(res.body.data.requests[0].status).toBe('pending');
    expect(res.body.data.requests[0]).not.toHaveProperty('session');
  });
});
