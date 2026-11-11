import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clock,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Slot,
  m2Student,
  m2Teacher,
  makeFamily,
  resetState,
  signedIn,
  signInAs,
  type Client,
  type TestContext,
} from './helpers.js';

/* Port of Laravel tests/Feature/M2/SchedulingApiTest.php (docs/14 §8.2 Scheduling). */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let teacher: Awaited<ReturnType<typeof m2Teacher>>;
let family: Awaited<ReturnType<typeof makeFamily>>;
let student: Awaited<ReturnType<typeof m2Student>>;
let monitor: Client;

beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-09T08:00:00Z'); // Monday
  teacher = await m2Teacher(ctx, 'Africa/Cairo');
  family = await makeFamily(ctx, { timezone: 'Europe/London' });
  student = await m2Student(ctx, 'Europe/London', family);
  monitor = (await signedIn(ctx, 'monitor')).client;
});

const payload = (o: Record<string, unknown> = {}) => ({
  studentId: student.id,
  courseId: student.regularCourseId,
  teacherId: teacher.id,
  kind: 'regular',
  startsOn: '2026-11-09',
  meetingMode: 'external',
  externalMeetingUrl: 'https://meet.example.test/abc',
  slots: [
    { weekday: 1, localStartTime: '17:00' },
    { weekday: 3, localStartTime: '17:00' },
  ],
  acknowledgeWarnings: ['dst_shift'],
  ...o,
});

describe('scheduling API (SchedulingApiTest)', () => {
  it('creates an enrollment with slots in the family zone', async () => {
    const res = await monitor.post('/enrollments', payload());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ timezone: 'Europe/London', status: 'active' });
    expect(res.body.data.slots).toHaveLength(2);
    expect(res.body.data.slots[0]).toMatchObject({
      localStartTime: '17:00',
      teacherLocal: { time: '19:00', variesWithDst: true },
    });
    expect(await ctx.prisma.scheduleSlot.count()).toBe(2);
    // the re-sync after the write generated the horizon
    expect(await ctx.prisma.classSession.count()).toBeGreaterThan(0);
    const history = await ctx.prisma.statusChange.findMany({
      where: { subjectType: 'enrollment' },
    });
    expect(history.map((h) => h.toStatus)).toEqual(['active']);
  });

  it('asks to acknowledge the DST warning, and blocks two overlapping slots in one payload', async () => {
    const warn = await monitor.post('/enrollments', payload({ acknowledgeWarnings: [] }));
    expect(warn.status).toBe(422);
    expect(warn.body.code).toBe('warnings_not_acknowledged');
    expect(warn.body.data.warnings[0].code).toBe('dst_shift');

    const clash = await monitor.post(
      '/enrollments',
      payload({
        slots: [
          { weekday: 1, localStartTime: '17:00' },
          { weekday: 1, localStartTime: '17:15' },
        ],
      }),
    );
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('schedule_conflict');
    expect(await ctx.prisma.enrollment.count()).toBe(0);
    expect(await ctx.prisma.scheduleSlot.count()).toBe(0);
  });

  it('refuses a second live enrollment in the same course', async () => {
    expect((await monitor.post('/enrollments', payload())).status).toBe(201);
    const again = await monitor.post('/enrollments', payload({ slots: [] }));
    expect(again.status).toBe(422);
    expect(again.body.errors.courseId).toBeDefined();
  });

  it('refuses a Zoom enrollment while Zoom is not configured, and an external one without an https link', async () => {
    const zoom = await monitor.post(
      '/enrollments',
      payload({ meetingMode: 'zoom', externalMeetingUrl: null }),
    );
    expect(zoom.status).toBe(422);
    expect(zoom.body.errors.meetingMode).toBeDefined();
    expect(
      (await monitor.post('/enrollments', payload({ externalMeetingUrl: null }))).body.errors,
    ).toHaveProperty('externalMeetingUrl');
    expect(
      (
        await monitor.post(
          '/enrollments',
          payload({ externalMeetingUrl: 'http://meet.example.test/x' }),
        )
      ).body.errors,
    ).toHaveProperty('externalMeetingUrl');
  });

  it('versions a slot instead of editing it, and reports touched classes', async () => {
    const id = (await monitor.post('/enrollments', payload())).body.data.id as number;
    const slot = await ctx.prisma.scheduleSlot.findFirstOrThrow({
      where: { enrollmentId: id, weekday: 1 },
    });
    const e = await ctx.prisma.enrollment.findUniqueOrThrow({ where: { id } });
    const manual = await m2Session(ctx, e, '2026-11-30T17:00:00Z', { isDetached: true });

    const res = await monitor.patch(`/schedule-slots/${slot.id}`, {
      localStartTime: '18:00',
      effectiveFrom: '2026-11-23',
      acknowledgeWarnings: ['dst_shift'],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ localStartTime: '18:00', validFrom: '2026-11-23' });
    expect(res.body.affectedManualSessions[0].id).toBe(manual.id);
    const closed = await ctx.prisma.scheduleSlot.findUniqueOrThrow({ where: { id: slot.id } });
    expect(closed.validTo?.toISOString().slice(0, 10)).toBe('2026-11-22');
    expect(await ctx.prisma.scheduleSlot.count({ where: { enrollmentId: id } })).toBe(3);
  });

  it('changes the teacher from a date by versioning every slot', async () => {
    const id = (await monitor.post('/enrollments', payload())).body.data.id as number;
    const fresh = await m2Teacher(ctx, 'Africa/Cairo');
    const res = await monitor.patch(`/enrollments/${id}`, {
      teacherId: fresh.id,
      effectiveFrom: '2026-11-16',
      acknowledgeWarnings: ['dst_shift'],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.teacher.id).toBe(fresh.id);
    expect(res.body.affectedManualSessions).toEqual([]);
    expect(
      await ctx.prisma.scheduleSlot.count({ where: { teacherId: fresh.id, validTo: null } }),
    ).toBe(2);
    expect(
      await ctx.prisma.scheduleSlot.count({
        where: { teacherId: teacher.id, validTo: new Date('2026-11-15T00:00:00Z') },
      }),
    ).toBe(2);
  });

  it('pauses, resumes and ends an enrollment, with its status history', async () => {
    const id = (await monitor.post('/enrollments', payload())).body.data.id as number;
    const paused = await monitor.post(`/enrollments/${id}/pause`, { reason: 'family_suspended' });
    expect(paused.status).toBe(200);
    expect(paused.body.data).toMatchObject({ status: 'paused', pausedReason: 'family_suspended' });
    expect((await monitor.post(`/enrollments/${id}/resume`)).body.data.status).toBe('active');
    expect(
      (await monitor.post(`/enrollments/${id}/end`, { endsOn: '2026-11-30' })).body.data.status,
    ).toBe('ended');
    expect(
      await ctx.prisma.scheduleSlot.count({ where: { enrollmentId: id, validTo: null } }),
    ).toBe(0);
    const late = await monitor.post(`/enrollments/${id}/slots`, {
      weekday: 5,
      localStartTime: '10:00',
    });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('conflict');
    const history = await ctx.prisma.statusChange.findMany({
      where: { subjectType: 'enrollment', subjectId: id },
      orderBy: { id: 'asc' },
    });
    expect(history.map((h) => h.toStatus)).toEqual(['active', 'paused', 'active', 'ended']);
    expect((await monitor.post(`/enrollments/${id}/resume`)).status).toBe(409);
  });

  it('adds a slot with conflict checks', async () => {
    const id = (await monitor.post('/enrollments', payload())).body.data.id as number;
    expect(
      (await monitor.post(`/enrollments/${id}/slots`, { weekday: 1, localStartTime: '17:15' }))
        .status,
    ).toBe(409);
    const ok = await monitor.post(`/enrollments/${id}/slots`, {
      weekday: 5,
      localStartTime: '10:00',
      acknowledgeWarnings: ['dst_shift', 'package_mismatch'],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.weekday).toBe(5);
  });

  it('scopes enrollments to the teacher and the family', async () => {
    expect((await monitor.post('/enrollments', payload())).status).toBe(201);
    await m2Enrollment(ctx, await m2Student(ctx), await m2Teacher(ctx));

    const asTeacher = await signInAs(ctx, teacher.user);
    const mine = await asTeacher.get('/enrollments');
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).not.toHaveProperty('notes');
    expect(mine.body.data[0]).not.toHaveProperty('externalMeetingUrl');
    expect((await asTeacher.post('/enrollments', payload())).status).toBe(403);
    const otherId = (
      await ctx.prisma.enrollment.findFirstOrThrow({ where: { teacherId: { not: teacher.id } } })
    ).id;
    expect((await asTeacher.get(`/enrollments/${otherId}`)).status).toBe(404);

    const asParent = await signInAs(ctx, family.user);
    const children = await asParent.get('/enrollments');
    expect(children.status).toBe(200);
    expect(children.body.data).toHaveLength(1);
    expect((await asParent.get(`/enrollments/${otherId}`)).status).toBe(404);
  });

  it('dry-runs a slot or a class with /schedule/check', async () => {
    const e = await m2Enrollment(ctx, student, teacher);
    await m2Slot(ctx, e, 1, '17:00');

    const slot = await monitor.post('/schedule/check', {
      studentId: student.id,
      teacherId: teacher.id,
      weekday: 1,
      localStartTime: '17:15',
      durationMinutes: 30,
      timezone: 'Europe/London',
    });
    expect(slot.status).toBe(200);
    expect(slot.body.data.conflicts[0]).toMatchObject({
      code: 'teacher_overlap',
      severity: 'hard',
    });

    const single = await monitor.post('/schedule/check', {
      enrollmentId: e.id,
      startsAt: '2026-11-10T09:00:00Z',
      durationMinutes: 30,
    });
    expect(single.body.data.conflicts).toEqual([]);

    const asParent = await signInAs(ctx, family.user);
    expect(
      (
        await asParent.post('/schedule/check', {
          enrollmentId: e.id,
          startsAt: '2026-11-10T09:00:00Z',
          durationMinutes: 30,
        })
      ).status,
    ).toBe(403);
  });

  it('manages teacher blocks and work hours, and shows the timetable', async () => {
    const recurring = await monitor.post(`/teachers/${teacher.id}/blocks`, {
      kind: 'recurring',
      reason: 'other_job',
      weekday: 2,
      localStartTime: '09:00',
      durationMinutes: 240,
    });
    expect(recurring.status).toBe(201);
    expect(recurring.body.data.timezone).toBe('Africa/Cairo');
    const oneOff = await monitor.post(`/teachers/${teacher.id}/blocks`, {
      kind: 'one_off',
      reason: 'leave',
      startsAt: '2026-11-20T00:00:00Z',
      endsAt: '2026-11-22T00:00:00Z',
    });
    expect(oneOff.status).toBe(201);
    expect(
      (await monitor.delete(`/teachers/${teacher.id}/blocks/${oneOff.body.data.id}`)).status,
    ).toBe(204);
    expect(await ctx.prisma.teacherBlock.count()).toBe(1);
    const missing = await monitor.post(`/teachers/${teacher.id}/blocks`, {
      kind: 'recurring',
      reason: 'break',
    });
    expect(missing.status).toBe(422);
    expect(Object.keys(missing.body.errors).sort()).toEqual([
      'durationMinutes',
      'localStartTime',
      'weekday',
    ]);

    const hours = await monitor.put(`/teachers/${teacher.id}/work-hours`, {
      workHours: [{ weekday: 1, localStartTime: '14:00', localEndTime: '22:00' }],
    });
    expect(hours.status).toBe(200);
    expect(hours.body.data[0].timezone).toBe('Africa/Cairo');

    const e = await m2Enrollment(ctx, student, teacher);
    await m2Slot(ctx, e, 1, '17:00');
    await m2Session(ctx, e, '2026-11-09T17:00:00Z');
    const tt = await monitor.get(`/teachers/${teacher.id}/timetable?from=2026-11-07&to=2026-11-14`);
    expect(tt.status).toBe(200);
    expect(tt.body.data.slots).toHaveLength(1);
    expect(tt.body.data.blocks).toHaveLength(1);
    expect(tt.body.data.workHours).toHaveLength(1);
    expect(tt.body.data.sessions).toHaveLength(1);
    expect(tt.body.data.slots[0].label).toContain(student.name);

    // the teacher may edit their own work hours and see their own timetable, not another teacher's
    const asTeacher = await signInAs(ctx, teacher.user);
    expect(
      (await asTeacher.put(`/teachers/${teacher.id}/work-hours`, { workHours: [] })).status,
    ).toBe(200);
    const other = await m2Teacher(ctx);
    expect(
      (await asTeacher.put(`/teachers/${other.id}/work-hours`, { workHours: [] })).status,
    ).toBe(403);
    expect((await asTeacher.get(`/teachers/${other.id}/timetable`)).status).toBe(404);
    expect((await asTeacher.get(`/teachers/${teacher.id}/timetable`)).status).toBe(200);
    expect(
      (
        await asTeacher.post(`/teachers/${teacher.id}/blocks`, {
          kind: 'recurring',
          reason: 'break',
          weekday: 2,
          localStartTime: '09:00',
          durationMinutes: 60,
        })
      ).status,
    ).toBe(403);
  });

  it('manages holidays and writes the audit log', async () => {
    const created = await monitor.post('/holidays', {
      name: 'Eid',
      date: '2026-11-20',
      endsOn: '2026-11-22',
      paid: false,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.paid).toBe(false);
    const id = created.body.data.id as number;
    expect((await monitor.get('/holidays?year=2026')).body.data).toHaveLength(1);
    expect((await monitor.get('/holidays?year=2027')).body.data).toHaveLength(0);
    const renamed = await monitor.patch(`/holidays/${id}`, { name: 'Eid al-Adha' });
    expect(renamed.body.data.name).toBe('Eid al-Adha');
    expect((await monitor.patch(`/holidays/${id}`, { endsOn: '2026-11-01' })).status).toBe(422);
    expect((await monitor.delete(`/holidays/${id}`)).status).toBe(204);
    expect(
      (
        await ctx.prisma.auditLog.findMany({
          where: { subjectType: 'holiday' },
          orderBy: { id: 'asc' },
        })
      ).map((a) => a.action),
    ).toEqual(['created', 'updated', 'deleted']);

    const asTeacher = await signInAs(ctx, teacher.user);
    expect((await asTeacher.post('/holidays', { name: 'x', date: '2026-12-01' })).status).toBe(403);
  });
});
