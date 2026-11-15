import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionGenerator } from '../src/sessions/generator.js';
import {
  type Client,
  clock,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  makeCourse,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';

/*
| C1 (docs/42 §3, D148): GET /calendar/events and /calendar/background, the T1 board and list
| filters, and PATCH /sessions/:id scope=following (the weekly slot moves from the next week).
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let monitor: Client;
beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-09T09:00:00Z');
  monitor = (await signedIn(ctx, 'monitor')).client;
});

const NOV = 'from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z';

async function twoTeachers() {
  const t1 = await m2Teacher(ctx, 'Africa/Cairo', 'Amina');
  const t2 = await m2Teacher(ctx, 'Africa/Cairo', 'Bilal');
  const s1 = await m2Student(ctx);
  const s2 = await m2Student(ctx);
  const quran = await makeCourse(ctx);
  const e1 = await m2Enrollment(ctx, s1, t1, { courseId: quran.id });
  const e2 = await m2Enrollment(ctx, s2, t2);
  const a = await m2Session(ctx, e1, '2026-11-03T10:00:00Z');
  const b = await m2Session(ctx, e1, '2026-11-04T10:00:00Z', { kind: 'trial', stage: 'taken' });
  const c = await m2Session(ctx, e2, '2026-11-05T12:00:00Z');
  await m2Session(ctx, e2, '2026-12-05T12:00:00Z'); // outside the range
  return { t1, t2, s1, s2, quran, e1, e2, a, b, c };
}

describe('GET /calendar/events', () => {
  it('staff see every teacher in the range, compact; filters combine', async () => {
    const { t1, s1, quran, a, b, c } = await twoTeachers();
    const all = await monitor.get(`/calendar/events?${NOV}`);
    expect(all.status).toBe(200);
    expect(all.body.data.truncated).toBe(false);
    expect(all.body.data.events.map((e: { id: number }) => e.id)).toEqual([a.id, b.id, c.id]);
    expect(all.body.data.events[0]).toEqual({
      id: a.id,
      startsAt: '2026-11-03T10:00:00.000Z',
      endsAt: '2026-11-03T10:30:00.000Z',
      durationMinutes: 30,
      kind: 'regular',
      stage: 'scheduled',
      attention: expect.any(Array),
      teacher: { id: t1.id, name: expect.stringContaining('Amina'), timezone: 'Africa/Cairo' },
      student: {
        id: s1.id,
        name: s1.name,
        timezone: 'Europe/London',
        familyId: s1.familyId,
      },
      course: { id: quran.id, nameAr: quran.nameAr, nameEn: quran.nameEn },
      enrollmentId: a.enrollmentId,
      slotId: null,
      isDetached: false,
      lockVersion: 0,
    });

    const ids = async (qs: string) =>
      (
        (await monitor.get(`/calendar/events?${NOV}&${qs}`)).body.data.events as Array<{
          id: number;
        }>
      ).map((e) => e.id);
    expect(await ids(`teacherIds=${t1.id}`)).toEqual([a.id, b.id]);
    expect(await ids(`teacherIds=${t1.id}&kinds=trial`)).toEqual([b.id]);
    expect(await ids(`courseIds=${quran.id}&stages=scheduled`)).toEqual([a.id]);
    expect(await ids(`familyIds=${s1.familyId}`)).toEqual([a.id, b.id]);
    expect(await ids(`studentIds=${c.studentId}`)).toEqual([c.id]);
  });

  it('a class that started before the range but runs into it is included', async () => {
    const t = await m2Teacher(ctx);
    const s = await m2Student(ctx);
    const e = await m2Enrollment(ctx, s, t);
    const across = await m2Session(ctx, e, '2026-10-31T23:45:00Z', { durationMinutes: 30 });
    const res = await monitor.get(`/calendar/events?${NOV}`);
    expect(res.body.data.events.map((x: { id: number }) => x.id)).toEqual([across.id]);
  });

  it('a teacher sees only their own classes, whatever they ask for', async () => {
    const { t1, t2, a, b } = await twoTeachers();
    const teacherUser = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: (await ctx.prisma.teacher.findUniqueOrThrow({ where: { id: t1.id } })).userId },
    });
    const teacher = await signInAs(ctx, teacherUser);
    const res = await teacher.get(`/calendar/events?${NOV}&teacherIds=${t2.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.events).toEqual([]);
    const own = await teacher.get(`/calendar/events?${NOV}`);
    expect(own.body.data.events.map((e: { id: number }) => e.id)).toEqual([a.id, b.id]);
    const bg = await teacher.get(`/calendar/background?${NOV}&teacherIds=${t2.id}`);
    expect(bg.body.data.teachers.map((x: { teacherId: number }) => x.teacherId)).toEqual([t1.id]);
  });

  it('401 without a session; 403 for a parent and for roles without schedule.view; 422 for a long range', async () => {
    expect(
      (await request(ctx.app.getHttpServer()).get(`/api/v1/calendar/events?${NOV}`)).status,
    ).toBe(401);
    for (const role of ['parent', 'billing', 'accounts']) {
      const { client } = await signedIn(ctx, role);
      expect((await client.get(`/calendar/events?${NOV}`)).status, role).toBe(403);
      expect((await client.get(`/calendar/background?${NOV}`)).status, role).toBe(403);
    }
    const long = await monitor.get(
      '/calendar/events?from=2026-11-01T00:00:00Z&to=2027-01-15T00:00:00Z',
    );
    expect(long.status).toBe(422);
  });
});

describe('GET /calendar/background', () => {
  it('expands work hours and blocks exactly across the October DST change; holidays too', async () => {
    const t = await m2Teacher(ctx, 'Europe/London', 'Leila');
    await ctx.prisma.teacherWorkHour.createMany({
      data: [
        // Mondays 09:00–17:00 London; Sundays 22:00–01:00 (crosses midnight).
        {
          teacherId: t.id,
          weekday: 1,
          localStartTime: '09:00',
          localEndTime: '17:00',
          timezone: 'Europe/London',
        },
        {
          teacherId: t.id,
          weekday: 7,
          localStartTime: '22:00',
          localEndTime: '01:00',
          timezone: 'Europe/London',
        },
      ],
    });
    const block = await ctx.prisma.teacherBlock.create({
      data: {
        teacherId: t.id,
        kind: 'recurring',
        reason: 'other',
        weekday: 1,
        localStartTime: '12:00',
        durationMinutes: 60,
        timezone: 'Europe/London',
      },
    });
    const holiday = await ctx.prisma.holiday.create({
      data: { name: 'Mawlid', date: new Date('2026-10-26T00:00:00Z') },
    });

    // 2026-10-25 (Sunday 01:00 UTC): London leaves summer time (UTC+1 → UTC+0).
    const res = await monitor.get(
      `/calendar/background?from=2026-10-19T00:00:00Z&to=2026-10-27T00:00:00Z&teacherIds=${t.id}`,
    );
    expect(res.status).toBe(200);
    const row = res.body.data.teachers[0];
    expect(row).toMatchObject({ teacherId: t.id, timezone: 'Europe/London' });
    expect(row.workHours).toEqual([
      { start: '2026-10-19T08:00:00.000Z', end: '2026-10-19T16:00:00.000Z' }, // BST
      { start: '2026-10-25T22:00:00.000Z', end: '2026-10-26T01:00:00.000Z' }, // GMT, overnight
      { start: '2026-10-26T09:00:00.000Z', end: '2026-10-26T17:00:00.000Z' }, // GMT
    ]);
    expect(row.blocks).toEqual([
      {
        start: '2026-10-19T11:00:00.000Z',
        end: '2026-10-19T12:00:00.000Z',
        blockId: block.id,
        reason: 'other',
        kind: 'recurring',
      },
      {
        start: '2026-10-26T12:00:00.000Z',
        end: '2026-10-26T13:00:00.000Z',
        blockId: block.id,
        reason: 'other',
        kind: 'recurring',
      },
    ]);
    // The academy day in Cairo (still summer time, UTC+3, until the end of October 2026).
    expect(res.body.data.holidays).toEqual([
      {
        id: holiday.id,
        name: 'Mawlid',
        appliesTo: 'all',
        start: '2026-10-25T21:00:00.000Z',
        end: '2026-10-26T21:00:00.000Z',
      },
    ]);
  });
});

describe('T1 filters on the board and the list', () => {
  it('courseIds and kinds narrow the rows and the counters', async () => {
    const { quran, a, b } = await twoTeachers();
    clock(ctx).set('2026-11-04T08:00:00Z');
    const board = await monitor.get(
      `/sessions/board?date=2026-11-04&tz=UTC&courseIds=${quran.id}&kinds=trial`,
    );
    expect(board.status).toBe(200);
    expect(board.body.data.sessions.map((s: { id: number }) => s.id)).toEqual([b.id]);
    expect(board.body.data.counters.total).toBe(1);
    const list = await monitor.get(
      `/sessions?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z&courseIds=${quran.id}`,
    );
    expect(list.body.data.map((s: { id: number }) => s.id)).toEqual([a.id, b.id]);
  });
});

describe('PATCH /sessions/:id scope=following', () => {
  async function weekly() {
    const teacher = await m2Teacher(ctx, 'Africa/Cairo');
    const student = await m2Student(ctx);
    const created = await monitor.post('/enrollments', {
      studentId: student.id,
      courseId: student.regularCourseId,
      teacherId: teacher.id,
      kind: 'regular',
      startsOn: '2026-11-09',
      meetingMode: 'external',
      externalMeetingUrl: 'https://meet.example.test/abc',
      slots: [{ weekday: 2, localStartTime: '17:00' }],
      acknowledgeWarnings: ['dst_shift'],
    });
    expect(created.status).toBe(201);
    await ctx.app.get(SessionGenerator).run({ from: '2026-11-09', to: '2026-11-30' });
    const slot = await ctx.prisma.scheduleSlot.findFirstOrThrow({
      where: { enrollmentId: created.body.data.id },
    });
    const first = await ctx.prisma.classSession.findFirstOrThrow({
      where: { scheduleSlotId: slot.id, deletedAt: null },
      orderBy: { startsAt: 'asc' },
    });
    return { slot, first };
  }

  it('moves this class and the weekly slot from the next week; history kept', async () => {
    const { slot, first } = await weekly();
    expect(first.startsAt.toISOString()).toBe('2026-11-10T17:00:00.000Z'); // Tue 17:00 London

    const res = await monitor.patch(`/sessions/${first.id}`, {
      scope: 'following',
      startsAt: '2026-11-11T18:00:00Z', // Wed 18:00 London
      expectedStage: 'scheduled',
      lockVersion: first.lockVersion,
      reason: 'Family asked for Wednesdays',
      acknowledgeWarnings: ['dst_shift'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ id: first.id, startsAt: '2026-11-11T18:00:00Z' });
    expect(res.body.series).toMatchObject({
      closedSlotId: slot.id,
      newSlotId: expect.any(Number),
      effectiveFrom: '2026-11-12',
    });

    const closed = await ctx.prisma.scheduleSlot.findUniqueOrThrow({ where: { id: slot.id } });
    expect(closed.validTo?.toISOString().slice(0, 10)).toBe('2026-11-11');
    const next = await ctx.prisma.scheduleSlot.findUniqueOrThrow({
      where: { id: res.body.series.newSlotId },
    });
    expect(next).toMatchObject({ weekday: 3, localStartTime: '18:00', timezone: 'Europe/London' });

    const live = await ctx.prisma.classSession.findMany({
      where: { enrollmentId: first.enrollmentId!, deletedAt: null },
      orderBy: { startsAt: 'asc' },
    });
    // This week: the moved class (detached); then Wednesdays 18:00 up to the 14-day horizon. The
    // Tuesdays generated earlier (17th, 24th) are gone.
    expect(live.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-11-11T18:00:00.000Z',
      '2026-11-18T18:00:00.000Z',
    ]);
    expect(live[0]!.isDetached).toBe(true);
    expect(res.body.series.movedSessionIds).toEqual([live[1]!.id]);
    expect(
      await ctx.prisma.classSession.count({
        where: { scheduleSlotId: slot.id, deletedAt: { not: null } },
      }),
    ).toBe(2);
    const events = await ctx.prisma.sessionEvent.findMany({ where: { sessionId: first.id } });
    expect(events.length).toBeGreaterThan(0);
  });

  it('a stale lockVersion is 409 and nothing changes; a one-off class is 422', async () => {
    const { slot, first } = await weekly();
    const stale = await monitor.patch(`/sessions/${first.id}`, {
      scope: 'following',
      startsAt: '2026-11-11T18:00:00Z',
      expectedStage: 'scheduled',
      lockVersion: first.lockVersion + 5,
      acknowledgeWarnings: ['dst_shift'],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_session');
    expect(
      (await ctx.prisma.scheduleSlot.findUniqueOrThrow({ where: { id: slot.id } })).validTo,
    ).toBeNull();

    const t = await m2Teacher(ctx);
    const s = await m2Student(ctx);
    const one = await m2Session(ctx, await m2Enrollment(ctx, s, t), '2026-11-12T10:00:00Z');
    const res = await monitor.patch(`/sessions/${one.id}`, {
      scope: 'following',
      startsAt: '2026-11-12T11:00:00Z',
      expectedStage: 'scheduled',
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('scope');
  });
});
