import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AttendanceService } from '../src/payroll/attendance.service.js';
import { createTestApp, resetState, signInAs, type TestContext } from './helpers.js';
import { m6At, m6Enrollment, m6Session, m6Teacher, userWithRole } from './payroll-helpers.js';

/*
| Port of Laravel tests/Feature/M6/AttendanceLeaveTest.php (D94): check-in/out on the server clock
| in the person's own zone; staff mark days with a reason; leave requests write attendance on
| approval; only unpaid leave and absences deduct. Plus DST / midnight cases and the N5 shift check.
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
});

const monthly = {
  salaryType: 'monthly',
  monthlySalary: '30000.00',
  hourlyRate: '0',
  currency: 'EGP',
} as const;

async function karachiTeacher() {
  const teacher = await m6Teacher(ctx, monthly, 'Asia/Karachi');
  return { teacher, client: await signInAs(ctx, teacher.user) };
}

describe('attendance check-in / check-out (D94)', () => {
  it('checks in once per local day and checks out with worked minutes', async () => {
    const { client } = await karachiTeacher();
    m6At(ctx, '2026-11-09T20:30:00Z'); // 01:30 on 10 Nov in Karachi (UTC+5)

    const first = await client.post('/attendance/check-in');
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      workDate: '2026-11-10',
      timezone: 'Asia/Karachi',
      status: 'present',
      checkInAt: '2026-11-09T20:30:00Z',
      source: 'self',
    });
    const again = await client.post('/attendance/check-in');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_checked_in');

    m6At(ctx, '2026-11-10T04:45:00Z');
    const today = await client.get('/attendance/today');
    expect(today.body.data).toMatchObject({ date: '2026-11-10', onLeave: false });
    expect(today.body.data.record.checkOutAt).toBeNull();
    const out = await client.post('/attendance/check-out');
    expect(out.status).toBe(200);
    expect(out.body.data.workedMinutes).toBe(495);
    const twice = await client.post('/attendance/check-out');
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('not_checked_in');
  });

  it('counts real minutes over the autumn DST change (New York) and keeps the evening work date', async () => {
    const teacher = await m6Teacher(ctx, {}, 'America/New_York');
    const client = await signInAs(ctx, teacher.user);
    m6At(ctx, '2026-11-01T03:30:00Z'); // 23:30 EDT on 31 Oct
    const res = await client.post('/attendance/check-in');
    expect(res.body.data.workDate).toBe('2026-10-31');
    m6At(ctx, '2026-11-01T07:30:00Z'); // 02:30 EST: 3 h on the wall clock, 4 h of real time
    expect((await client.post('/attendance/check-out')).body.data.workedMinutes).toBe(240);
  });

  it('counts real minutes over the spring DST change (London) across midnight', async () => {
    const teacher = await m6Teacher(ctx, {}, 'Europe/London');
    const client = await signInAs(ctx, teacher.user);
    m6At(ctx, '2026-03-28T23:30:00Z'); // 23:30 GMT on 28 Mar
    expect((await client.post('/attendance/check-in')).body.data.workDate).toBe('2026-03-28');
    m6At(ctx, '2026-03-29T02:30:00Z'); // 03:30 BST: 4 h on the wall clock, 3 h of real time
    expect((await client.post('/attendance/check-out')).body.data.workedMinutes).toBe(180);
    // The next local day starts a new record.
    m6At(ctx, '2026-03-29T08:00:00Z');
    expect((await client.post('/attendance/check-in')).body.data.workDate).toBe('2026-03-29');
  });

  it('uses the person’s own zone for staff without a teacher record, else the academy zone', async () => {
    const { user, client } = await userWithRole(ctx, 'csr');
    await ctx.prisma.user.update({ where: { id: user.id }, data: { timezone: 'Asia/Tokyo' } });
    m6At(ctx, '2026-11-15T16:00:00Z'); // 01:00 on 16 Nov in Tokyo, 18:00 on 15 Nov in Cairo
    expect((await client.post('/attendance/check-in')).body.data).toMatchObject({
      workDate: '2026-11-16',
      timezone: 'Asia/Tokyo',
    });
  });

  it('does not close a shift opened more than 24 hours ago', async () => {
    const { client } = await karachiTeacher();
    m6At(ctx, '2026-11-10T05:00:00Z');
    await client.post('/attendance/check-in');
    m6At(ctx, '2026-11-11T05:01:00Z');
    const res = await client.post('/attendance/check-out');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_checked_in');
  });

  it('tells the CRM who is on shift (checked in, not out, no approved leave)', async () => {
    const { teacher, client } = await karachiTeacher();
    const svc = ctx.app.get(AttendanceService);
    m6At(ctx, '2026-11-10T05:00:00Z');
    expect(await svc.isOnShift(teacher.userId)).toBe(false);
    await client.post('/attendance/check-in');
    expect(await svc.isOnShift(teacher.userId)).toBe(true);
    expect(await svc.isOnShift(teacher.userId, new Date('2026-11-10T04:59:00Z'))).toBe(false);
    m6At(ctx, '2026-11-10T09:00:00Z');
    await client.post('/attendance/check-out');
    expect(await svc.isOnShift(teacher.userId)).toBe(false);
    // Still on shift at an instant inside the closed shift.
    expect(await svc.isOnShift(teacher.userId, new Date('2026-11-10T06:00:00Z'))).toBe(true);
    // An approved leave that day wins.
    await ctx.prisma.leaveRequest.create({
      data: {
        userId: teacher.userId,
        startsOn: new Date('2026-11-10T00:00:00Z'),
        endsOn: new Date('2026-11-10T00:00:00Z'),
        days: 1,
        leaveType: 'paid',
        reason: 'test',
        status: 'approved',
      },
    });
    expect(await svc.isOnShift(teacher.userId, new Date('2026-11-10T06:00:00Z'))).toBe(false);
  });
});

describe('attendance marking and scope', () => {
  it('lets staff mark a day with a reason and shows each person only their own days', async () => {
    const { teacher, client: teacherClient } = await karachiTeacher();
    m6At(ctx, '2026-11-15T08:00:00Z');
    const { client: monitor } = await userWithRole(ctx, 'monitor');

    expect(
      (await monitor.put(`/attendance/${teacher.userId}/2026-11-03`, { status: 'absent' })).status,
    ).toBe(422);
    const marked = await monitor.put(`/attendance/${teacher.userId}/2026-11-03`, {
      status: 'absent',
      note: 'No show',
      reason: 'Did not come or call',
    });
    expect(marked.status).toBe(200);
    expect(marked.body.data).toMatchObject({ status: 'absent', deductible: true, source: 'staff' });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'attendance_marked' },
    });
    expect(audit.reason).toBe('Did not come or call');

    const { user: other } = await userWithRole(ctx, 'csr');
    await ctx.prisma.staffAttendance.create({
      data: {
        userId: other.id,
        workDate: new Date('2026-11-04T00:00:00Z'),
        status: 'present',
        source: 'self',
      },
    });

    const all = await monitor.get('/attendance?month=2026-11');
    expect(all.body.data).toHaveLength(2);
    expect(all.body.meta.scope).toBe('all');

    const own = await teacherClient.get(`/attendance?month=2026-11&userId=${other.id}`);
    expect(own.status).toBe(200);
    expect(own.body.data).toHaveLength(1);
    expect(own.body.data[0].user.id).toBe(teacher.userId);
    expect(own.body.meta.scope).toBe('own');
    expect(own.body.meta.summary[0].deductibleDays).toBe(1);
    expect(
      (
        await teacherClient.put(`/attendance/${teacher.userId}/2026-11-05`, {
          status: 'present',
          reason: 'me me',
        })
      ).status,
    ).toBe(403);
  });

  it('answers 404 for an unknown person or an impossible date', async () => {
    const { client: manager } = await userWithRole(ctx, 'manager');
    const { user } = await userWithRole(ctx, 'csr');
    const body = { status: 'present', reason: 'correction' };
    expect((await manager.put(`/attendance/999999/2026-11-03`, body)).status).toBe(404);
    expect((await manager.put(`/attendance/${user.id}/2026-02-30`, body)).status).toBe(404);
    expect((await manager.put(`/attendance/${user.id}/yesterday`, body)).status).toBe(404);
  });
});

describe('leave requests', () => {
  it('runs a leave request: request, overlap, approve into attendance, unpaid days deduct', async () => {
    const { teacher, client } = await karachiTeacher();
    m6At(ctx, '2026-11-15T08:00:00Z');
    const e = await m6Enrollment(ctx, teacher);
    const cls = await m6Session(ctx, e, '2026-11-18T10:00:00Z', 'scheduled');

    const created = await client.post('/leave-requests', {
      startsOn: '2026-11-17',
      endsOn: '2026-11-19',
      leaveType: 'unpaid',
      reason: 'Family matter',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      days: 3,
      status: 'pending',
      can: { decide: false, cancel: true },
    });
    const id = created.body.data.id;
    const overlap = await client.post('/leave-requests', {
      startsOn: '2026-11-19',
      endsOn: '2026-11-20',
      leaveType: 'paid',
      reason: 'Overlap',
    });
    expect(overlap.status).toBe(422);
    expect(overlap.body.code).toBe('leave_overlap');
    expect((await client.post(`/leave-requests/${id}/approve`)).status).toBe(403);

    const { client: manager } = await userWithRole(ctx, 'manager');
    const approved = await manager.post(`/leave-requests/${id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('approved');
    expect(approved.body.data.affectedSessions[0].id).toBe(cls.id);
    expect(
      await ctx.prisma.staffAttendance.count({
        where: { userId: teacher.userId, status: 'leave', paidLeave: false },
      }),
    ).toBe(3);

    const { client: accounts } = await userWithRole(ctx, 'accounts');
    expect((await accounts.post('/payroll/runs', { period: '2026-11' })).status).toBe(201);
    const list = await manager.get('/leave-requests?status=approved');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta.counts).toMatchObject({ all: 1, approved: 1 });

    // 30,000 × 3 / 30 = 3,000 deducted.
    const runId = (await accounts.get('/payroll/runs')).body.data[0].id;
    const run = await accounts.get(`/payroll/runs/${runId}`);
    expect(run.body.data.payslips[0]).toMatchObject({ net: '27000.00', deductionDays: 3 });

    // Cancelling the approved leave (manager, reason) removes the days and the deduction.
    const cancelled = await manager.post(`/leave-requests/${id}/cancel`, { note: 'Plans changed' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect((await accounts.get(`/payroll/runs/${runId}`)).body.data.payslips[0].net).toBe(
      '30000.00',
    );
  });

  it('keeps a paid (sick) leave without deduction and refuses check-in on a leave day', async () => {
    const { teacher, client } = await karachiTeacher();
    m6At(ctx, '2026-11-15T08:00:00Z'); // 13:00 in Karachi
    const id = (
      await client.post('/leave-requests', {
        startsOn: '2026-11-15',
        endsOn: '2026-11-15',
        leaveType: 'sick',
        reason: 'Fever',
      })
    ).body.data.id;
    const { client: monitor } = await userWithRole(ctx, 'monitor');
    expect((await monitor.post(`/leave-requests/${id}/approve`, { note: 'Get well' })).status).toBe(
      200,
    );

    const day = await ctx.prisma.staffAttendance.findFirstOrThrow({
      where: { userId: teacher.userId },
    });
    expect(day.status === 'absent' || (day.status === 'leave' && !day.paidLeave)).toBe(false);
    const res = await client.post('/attendance/check-in');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('on_leave');
    expect((await client.get('/attendance/today')).body.data.onLeave).toBe(true);
  });

  it('keeps a worked day when a leave over it is approved', async () => {
    const { teacher, client } = await karachiTeacher();
    m6At(ctx, '2026-11-15T05:00:00Z');
    await client.post('/attendance/check-in');
    const id = (
      await client.post('/leave-requests', {
        startsOn: '2026-11-15',
        endsOn: '2026-11-16',
        leaveType: 'unpaid',
        reason: 'Going home early',
      })
    ).body.data.id;
    const { client: manager } = await userWithRole(ctx, 'manager');
    await manager.post(`/leave-requests/${id}/approve`);
    const rows = await ctx.prisma.staffAttendance.findMany({
      where: { userId: teacher.userId },
      orderBy: { workDate: 'asc' },
    });
    expect(rows.map((r) => r.status)).toEqual(['present', 'leave']);
  });

  it('lets the requester withdraw only a pending request', async () => {
    const { client } = await karachiTeacher();
    m6At(ctx, '2026-11-15T08:00:00Z');
    const id = (
      await client.post('/leave-requests', {
        startsOn: '2026-11-20',
        endsOn: '2026-11-21',
        leaveType: 'paid',
        reason: 'Trip',
      })
    ).body.data.id;
    const withdrawn = await client.post(`/leave-requests/${id}/cancel`, { note: 'Not needed' });
    expect(withdrawn.body.data.status).toBe('cancelled');

    const { user: other, client: otherClient } = await userWithRole(ctx, 'csr');
    const theirs = (
      await otherClient.post('/leave-requests', {
        startsOn: '2026-11-20',
        endsOn: '2026-11-20',
        leaveType: 'paid',
        reason: 'Mine',
      })
    ).body.data.id;
    expect((await client.get(`/leave-requests/${theirs}`)).status).toBe(404);
    expect((await client.post(`/leave-requests/${theirs}/cancel`, { note: 'x x x' })).status).toBe(
      404,
    );
    const forOther = await client.post('/leave-requests', {
      userId: other.id,
      startsOn: '2026-11-22',
      endsOn: '2026-11-22',
      leaveType: 'paid',
      reason: 'For someone',
    });
    expect(forOther.status).toBe(403);
    // Own list only.
    expect(
      (await client.get('/leave-requests')).body.data.map((l: { id: number }) => l.id),
    ).toEqual([id]);
  });

  it('validates the dates and the longest leave', async () => {
    const { client } = await karachiTeacher();
    const backwards = await client.post('/leave-requests', {
      startsOn: '2026-11-20',
      endsOn: '2026-11-19',
      leaveType: 'paid',
      reason: 'Backwards',
    });
    expect(backwards.status).toBe(422);
    expect(backwards.body.errors).toHaveProperty('endsOn');
    const long = await client.post('/leave-requests', {
      startsOn: '2026-11-01',
      endsOn: '2026-12-02',
      leaveType: 'paid',
      reason: 'Too long',
    });
    expect(long.status).toBe(422);
    expect(long.body.errors).toHaveProperty('endsOn');
  });

  it('needs a reason to reject and lists pending requests first', async () => {
    const { client } = await karachiTeacher();
    m6At(ctx, '2026-11-15T08:00:00Z');
    const a = (
      await client.post('/leave-requests', {
        startsOn: '2026-11-25',
        endsOn: '2026-11-25',
        leaveType: 'paid',
        reason: 'One',
      })
    ).body.data.id;
    const b = (
      await client.post('/leave-requests', {
        startsOn: '2026-11-26',
        endsOn: '2026-11-26',
        leaveType: 'paid',
        reason: 'Two',
      })
    ).body.data.id;
    const { client: manager } = await userWithRole(ctx, 'manager');
    expect((await manager.post(`/leave-requests/${b}/reject`, {})).status).toBe(422);
    const rejected = await manager.post(`/leave-requests/${b}/reject`, { note: 'Exams week' });
    expect(rejected.body.data).toMatchObject({ status: 'rejected', decisionNote: 'Exams week' });
    expect((await manager.post(`/leave-requests/${b}/approve`)).body.code).toBe(
      'invalid_leave_status',
    );
    const list = await manager.get('/leave-requests');
    expect(list.body.data.map((l: { id: number }) => l.id)).toEqual([a, b]);
    expect(list.body.meta.counts).toMatchObject({ all: 2, pending: 1, rejected: 1 });
  });
});
