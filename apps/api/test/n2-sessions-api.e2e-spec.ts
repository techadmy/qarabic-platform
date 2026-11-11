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
  type TestContext,
} from './helpers.js';

/* Port of Laravel tests/Feature/M2/SessionsApiTest.php (docs/14 §8.1–8.3). */

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
let other: Awaited<ReturnType<typeof m2Session>>;

beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-10T14:55:00Z');
  teacher = await m2Teacher(ctx);
  family = await makeFamily(ctx, { timezone: 'Europe/London' });
  enrollment = await m2Enrollment(ctx, await m2Student(ctx, 'Europe/London', family), teacher);
  session = await m2Session(ctx, enrollment, '2026-11-10T15:00:00Z');
  other = await m2Session(
    ctx,
    await m2Enrollment(ctx, await m2Student(ctx), await m2Teacher(ctx)),
    '2026-11-10T15:00:00Z',
  );
});

describe('sessions API (SessionsApiTest)', () => {
  it('requires authentication and the sessions.view permission', async () => {
    const anon = await request(ctx.app.getHttpServer()).get('/api/v1/sessions');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('unauthenticated');
    const { client } = await signedIn(ctx, 'billing');
    const res = await client.get('/sessions');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  it('lists sessions with the §8.1 shape for staff', async () => {
    const { client } = await signedIn(ctx, 'monitor');
    const res = await client.get('/sessions?date=2026-11-10&tz=Africa/Cairo');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      [
        'id',
        'kind',
        'stage',
        'stageReason',
        'startsAt',
        'endsAt',
        'durationMinutes',
        'occurrenceDate',
        'source',
        'isDetached',
        'student',
        'teacher',
        'course',
        'enrollmentId',
        'scheduleSlotId',
        'originSessionId',
        'times',
        'latenessMinutes',
        'zoom',
        'evidence',
        'report',
        'attention',
        'pendingRequests',
        'allowedActions',
        'upcomingActions',
        'needsReview',
        'reviewReason',
        'lockVersion',
        'updatedAt',
      ].sort(),
    );
    expect(res.body.data[0]).toMatchObject({
      startsAt: '2026-11-10T15:00:00Z',
      student: { timezone: 'Europe/London' },
      teacher: { timezone: 'Africa/Cairo' },
    });
    expect(res.body.meta).toMatchObject({ page: 1, total: 2, counts: { all: 2, scheduled: 2 } });
  });

  it('scopes rows: a teacher sees own classes, a parent own children', async () => {
    const asTeacher = await signInAs(ctx, teacher.user);
    const mine = await asTeacher.get('/sessions');
    expect(mine.body.data.map((s: { id: number }) => s.id)).toEqual([session.id]);
    expect((await asTeacher.get(`/sessions/${other.id}`)).status).toBe(404);

    const asParent = await signInAs(ctx, family.user);
    const kids = await asParent.get('/sessions');
    expect(kids.body.data).toHaveLength(1);
    expect(kids.body.data[0].allowedActions).toEqual([]);
    expect(kids.body.data[0].teacher).not.toHaveProperty('phone');
    expect((await asParent.get(`/sessions/${other.id}`)).status).toBe(404);
  });

  it('shows a session with events, report and requests', async () => {
    const asTeacher = await signInAs(ctx, teacher.user);
    expect(
      (
        await asTeacher.post(`/sessions/${session.id}/transitions`, {
          action: 'activate',
          expectedStage: 'scheduled',
        })
      ).status,
    ).toBe(200);
    const res = await asTeacher.get(`/sessions/${session.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ stage: 'activated', lessonReport: null, requests: [] });
    expect(res.body.data.events[0]).toMatchObject({
      type: 'activated',
      actor: { id: teacher.user.id, role: 'teacher' },
    });
  });

  it('runs the teacher flow through the transitions endpoint', async () => {
    const asTeacher = await signInAs(ctx, teacher.user);
    const url = `/sessions/${session.id}/transitions`;
    const activated = await asTeacher.post(url, { action: 'activate', expectedStage: 'scheduled' });
    expect(activated.status).toBe(200);
    expect(activated.body.data.stage).toBe('activated');
    expect(activated.body.data.allowedActions).toEqual([
      'undo_activate',
      'start',
      'mark_declined',
      'mark_leave',
    ]);

    clock(ctx).set('2026-11-10T15:19:59Z'); // 25 minutes from activation (14:55)
    const early = await asTeacher.post(url, { action: 'end', expectedStage: 'activated' });
    expect(early.status).toBe(422);
    expect(early.body.code).toBe('outside_window');
    expect(early.body.errors.availableFrom).toEqual(['2026-11-10T15:20:00Z']);

    clock(ctx).set('2026-11-10T15:26:00Z');
    const ended = await asTeacher.post(url, { action: 'end', expectedStage: 'activated' });
    expect(ended.status).toBe(200);
    expect(ended.body.data.stage).toBe('ended');
  });

  it('answers 409 stale_session with the fresh session, and 422 on bad input', async () => {
    const asTeacher = await signInAs(ctx, teacher.user);
    const url = `/sessions/${session.id}/transitions`;
    const missing = await asTeacher.post(url, { action: 'activate' });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('validation_failed');
    expect(missing.body.errors.expectedStage).toBeDefined();
    expect((await asTeacher.post(url, { action: 'fly', expectedStage: 'scheduled' })).status).toBe(
      422,
    );

    await ctx.prisma.classSession.update({
      where: { id: session.id },
      data: { stage: 'cancelled', stageReason: 'admin' },
    });
    const stale = await asTeacher.post(url, { action: 'activate', expectedStage: 'scheduled' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_session');
    expect(stale.body.data.stage).toBe('cancelled');
  });

  it('forbids transitions to users who cannot conduct the class', async () => {
    const asParent = await signInAs(ctx, family.user);
    expect(
      (
        await asParent.post(`/sessions/${session.id}/transitions`, {
          action: 'activate',
          expectedStage: 'scheduled',
        })
      ).status,
    ).toBe(403);
    const asOther = await signInAs(ctx, (await m2Teacher(ctx)).user);
    expect(
      (
        await asOther.post(`/sessions/${session.id}/transitions`, {
          action: 'activate',
          expectedStage: 'scheduled',
        })
      ).status,
    ).toBe(404);
  });

  it('creates a one-off class with conflict checks and warning acknowledgement', async () => {
    const { client } = await signedIn(ctx, 'monitor');
    const body = {
      enrollmentId: enrollment.id,
      kind: 'extra',
      startsAt: '2026-11-10T15:15:00Z',
      durationMinutes: 30,
    };
    const clash = await client.post('/sessions', body);
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('schedule_conflict');
    expect(clash.body.data.conflicts[0]).toMatchObject({
      code: 'teacher_overlap',
      with: { type: 'session', id: session.id },
    });

    const past = { ...body, startsAt: '2026-11-09T15:00:00Z' };
    const warn = await client.post('/sessions', past);
    expect(warn.status).toBe(422);
    expect(warn.body.code).toBe('warnings_not_acknowledged');
    expect(warn.body.data.warnings[0].code).toBe('past_time');
    const ok = await client.post('/sessions', { ...past, acknowledgeWarnings: ['past_time'] });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ kind: 'extra', source: 'manual' });

    const asTeacher = await signInAs(ctx, teacher.user);
    expect((await asTeacher.post('/sessions', body)).status).toBe(403);
  });

  it('shifts a class (PATCH) and marks it detached', async () => {
    const { client } = await signedIn(ctx, 'monitor');
    const moved = await client.patch(`/sessions/${session.id}`, {
      startsAt: '2026-11-10T17:00:00Z',
      expectedStage: 'scheduled',
    });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ startsAt: '2026-11-10T17:00:00Z', isDetached: true });
    const events = await ctx.prisma.sessionEvent.findMany({ where: { sessionId: session.id } });
    expect(events.map((e) => e.type)).toEqual(['time_changed']);

    const stale = await client.patch(`/sessions/${session.id}`, {
      startsAt: '2026-11-10T15:00:00Z',
      expectedStage: 'activated',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_session');
  });

  it('tells when time-guarded actions open, shows the teacher phone to staff and placeholders for missing courses', async () => {
    clock(ctx).set('2026-11-10T14:00:00Z');
    const asTeacher = await signInAs(ctx, teacher.user);
    const before = await asTeacher.get(`/sessions/${session.id}`);
    expect(before.body.data.upcomingActions).toEqual([
      { action: 'activate', availableAt: '2026-11-10T14:50:00Z' },
    ]);
    expect(before.body.data.teacher).not.toHaveProperty('phone');

    clock(ctx).set('2026-11-10T15:00:00Z');
    const activated = await asTeacher.post(`/sessions/${session.id}/transitions`, {
      action: 'activate',
      expectedStage: 'scheduled',
    });
    expect(activated.body.data.upcomingActions).toEqual([
      { action: 'end', availableAt: '2026-11-10T15:25:00Z' },
      { action: 'mark_absent', availableAt: '2026-11-10T15:25:00Z' },
    ]);

    await ctx.prisma.user.update({
      where: { id: teacher.user.id },
      data: { phone: '+201000000000' },
    });
    await ctx.prisma.classSession.update({ where: { id: other.id }, data: { courseId: null } });
    const { client } = await signedIn(ctx, 'monitor');
    expect((await client.get(`/sessions/${session.id}`)).body.data.teacher.phone).toBe(
      '+201000000000',
    );
    expect((await client.get(`/sessions/${other.id}`)).body.data.course).toEqual({
      id: 0,
      nameAr: '—',
      nameEn: '—',
    });
  });

  it('serves perPage=300 to a teacher (My day / My week) and rejects more than 500', async () => {
    const asTeacher = await signInAs(ctx, teacher.user);
    expect((await asTeacher.get('/sessions?perPage=300')).body.meta.perPage).toBe(300);
    expect((await asTeacher.get('/sessions?perPage=500')).status).toBe(200);
    const big = await asTeacher.get('/sessions?perPage=501');
    expect(big.status).toBe(422);
    expect(big.body.errors.perPage).toBeDefined();
  });

  it('filters by stage list and counts per stage', async () => {
    await ctx.prisma.classSession.update({
      where: { id: other.id },
      data: { stage: 'cancelled', stageReason: 'admin' },
    });
    const { client } = await signedIn(ctx, 'monitor');
    const res = await client.get('/sessions?stage=cancelled,leave');
    expect(res.body.data.map((s: { id: number }) => s.id)).toEqual([other.id]);
    expect(res.body.meta.counts).toMatchObject({ all: 2, scheduled: 1, cancelled: 1 });
  });
});
