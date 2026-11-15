import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AvailabilityChangesService } from '../src/schedule/availability-changes.js';
import {
  type Client,
  clock,
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
| A1 (docs/42 §4, D148; B131 = staff approval): a teacher's own work-hours or block change waits
| for staff with schedule.manage, who see the booked classes it would leave outside the hours.
| Staff edits apply at once. Approved work hours apply from their date (hourly job).
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let monitor: Client;
let teacher: Awaited<ReturnType<typeof m2Teacher>>;
let teacherClient: Client;

beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-09T06:00:00Z'); // Monday, 08:00 in Cairo
  monitor = (await signedIn(ctx, 'monitor')).client;
  teacher = await m2Teacher(ctx, 'Africa/Cairo');
  await ctx.prisma.teacherWorkHour.create({
    data: {
      teacherId: teacher.id,
      weekday: 2,
      localStartTime: '09:00',
      localEndTime: '17:00',
      timezone: 'Africa/Cairo',
    },
  });
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: teacher.userId } });
  teacherClient = await signInAs(ctx, user);
});

/** Tuesdays 09:00–12:00 only (was 09:00–17:00). */
const NARROWER = { workHours: [{ weekday: 2, localStartTime: '09:00', localEndTime: '12:00' }] };

const hours = async () =>
  (await ctx.prisma.teacherWorkHour.findMany({ where: { teacherId: teacher.id } })).map(
    (w) => `${w.weekday} ${w.localStartTime}-${w.localEndTime}`,
  );

describe('a teacher’s own work-hours change waits for approval', () => {
  it('202 with a pending change listing the booked classes it would leave outside', async () => {
    const student = await m2Student(ctx);
    const e = await m2Enrollment(ctx, student, teacher);
    // Tue 10 Nov, Cairo (UTC+2): 10:00 stays inside; 14:00 falls outside the new hours.
    await m2Session(ctx, e, '2026-11-10T08:00:00Z');
    const outside = await m2Session(ctx, e, '2026-11-10T12:00:00Z');

    const res = await teacherClient.put(`/teachers/${teacher.id}/work-hours`, {
      ...NARROWER,
      requestNote: 'Afternoons are for my studies now',
    });
    expect(res.status).toBe(202);
    expect(res.body.pending).toBe(true);
    expect(res.body.data).toMatchObject({
      kind: 'work_hours',
      status: 'pending',
      effectiveFrom: '2026-11-09',
      note: 'Afternoons are for my studies now',
      can: { approve: false, reject: false, withdraw: true },
    });
    expect(res.body.data.affected.map((a: { id: number }) => a.id)).toEqual([outside.id]);
    expect(await hours()).toEqual(['2 09:00-17:00']); // unchanged until approved

    const mine = await teacherClient.get('/availability-changes');
    expect(mine.body.data).toHaveLength(1);
    // The teacher cannot approve their own change.
    const own = await teacherClient.post(`/availability-changes/${res.body.data.id}/approve`, {});
    expect(own.status).toBe(403);

    // Staff see it with the decision buttons, and approve: in force today.
    const seen = await monitor.get(`/availability-changes/${res.body.data.id}`);
    expect(seen.body.data.can).toEqual({ approve: true, reject: true, withdraw: false });
    const ok = await monitor.post(`/availability-changes/${res.body.data.id}/approve`, {
      note: 'Fine; the 14:00 class moves to Wednesday',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({
      status: 'applied',
      decidedBy: { id: expect.any(Number) },
    });
    expect(await hours()).toEqual(['2 09:00-12:00']);

    const audit = await ctx.prisma.auditLog.findMany({
      where: { subjectType: 'teacher', subjectId: teacher.id },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'availability_change_requested',
      'availability_change_approved',
      'work_hours_replaced',
    ]);
  });

  it('a later effective date: approved now, applied by the hourly job on that day', async () => {
    const res = await teacherClient.put(`/teachers/${teacher.id}/work-hours`, {
      ...NARROWER,
      effectiveFrom: '2026-11-16',
    });
    const id = res.body.data.id as number;
    const ok = await monitor.post(`/availability-changes/${id}/approve`, {});
    expect(ok.body.data).toMatchObject({ status: 'approved', effectiveFrom: '2026-11-16' });
    expect(await hours()).toEqual(['2 09:00-17:00']);

    const job = ctx.app.get(AvailabilityChangesService);
    expect(await job.applyDue()).toBe(0);
    clock(ctx).set('2026-11-15T22:30:00Z'); // 16 Nov 00:30 in Cairo
    expect(await job.applyDue()).toBe(1);
    expect(await hours()).toEqual(['2 09:00-12:00']);
    expect((await monitor.get(`/availability-changes/${id}`)).body.data.status).toBe('applied');
  });

  it('reject needs a reason; the teacher may withdraw a pending change; a newer one replaces it', async () => {
    const first = (await teacherClient.put(`/teachers/${teacher.id}/work-hours`, NARROWER)).body
      .data.id as number;
    const second = (await teacherClient.put(`/teachers/${teacher.id}/work-hours`, NARROWER)).body
      .data.id as number;
    expect((await monitor.get(`/availability-changes/${first}`)).body.data.status).toBe(
      'withdrawn',
    );
    expect((await monitor.post(`/availability-changes/${second}/reject`, {})).status).toBe(422);
    const no = await monitor.post(`/availability-changes/${second}/reject`, {
      reason: 'We need you in the afternoons',
    });
    expect(no.body.data).toMatchObject({
      status: 'rejected',
      decisionReason: 'We need you in the afternoons',
    });
    expect(await hours()).toEqual(['2 09:00-17:00']);
    expect((await monitor.post(`/availability-changes/${second}/approve`, {})).status).toBe(409);

    const third = (await teacherClient.put(`/teachers/${teacher.id}/work-hours`, NARROWER)).body
      .data.id as number;
    const back = await teacherClient.post(`/availability-changes/${third}/withdraw`);
    expect(back.body.data.status).toBe('withdrawn');
  });

  it('nobody decides their own request (self_decision)', async () => {
    const self = await signedIn(ctx, 'monitor');
    const change = await ctx.prisma.availabilityChange.create({
      data: {
        teacherId: teacher.id,
        kind: 'work_hours',
        payload: NARROWER,
        effectiveFrom: new Date('2026-11-09T00:00:00Z'),
        requestedById: self.user.id,
      },
    });
    const res = await self.client.post(`/availability-changes/${change.id}/approve`, {});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('self_decision');
  });
});

describe('blocks and staff edits', () => {
  it('a teacher’s new block waits for approval; staff edits apply at once', async () => {
    const block = {
      kind: 'one_off',
      reason: 'other',
      startsAt: '2026-11-12T10:00:00Z',
      endsAt: '2026-11-12T12:00:00Z',
    };
    const req = await teacherClient.post(`/teachers/${teacher.id}/blocks`, block);
    expect(req.status).toBe(202);
    expect(await ctx.prisma.teacherBlock.count()).toBe(0);
    await monitor.post(`/availability-changes/${req.body.data.id}/approve`, {});
    expect(await ctx.prisma.teacherBlock.count()).toBe(1);

    const direct = await monitor.put(`/teachers/${teacher.id}/work-hours`, NARROWER);
    expect(direct.status).toBe(200);
    expect(await hours()).toEqual(['2 09:00-12:00']);
    const staffBlock = await monitor.post(`/teachers/${teacher.id}/blocks`, block);
    expect(staffBlock.status).toBe(201);
    expect(await ctx.prisma.availabilityChange.count()).toBe(1);
  });

  it('another teacher gets 404; a parent and billing 403; no session 401', async () => {
    const other = await m2Teacher(ctx);
    const otherUser = await ctx.prisma.user.findUniqueOrThrow({ where: { id: other.userId } });
    const otherClient = await signInAs(ctx, otherUser);
    expect((await otherClient.put(`/teachers/${teacher.id}/work-hours`, NARROWER)).status).toBe(
      404,
    );
    const pending = await teacherClient.put(`/teachers/${teacher.id}/work-hours`, NARROWER);
    expect((await otherClient.get(`/availability-changes/${pending.body.data.id}`)).status).toBe(
      404,
    );
    expect((await otherClient.get('/availability-changes')).body.data).toEqual([]);
    for (const role of ['parent', 'billing']) {
      const { client } = await signedIn(ctx, role);
      expect((await client.get('/availability-changes')).status, role).toBe(403);
    }
    expect(
      (await request(ctx.app.getHttpServer()).get('/api/v1/availability-changes')).status,
    ).toBe(401);
  });
});
