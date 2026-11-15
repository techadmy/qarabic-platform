import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
| R1 (docs/42 §5): teacher utilization and the free-capacity grid, on a fixed seed in Cairo
| (UTC+2 in November; UTC+3 until 30 October, so the previous week checks DST too).
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let monitor: Client;
let a: Awaited<ReturnType<typeof m2Teacher>>;
let b: Awaited<ReturnType<typeof m2Teacher>>;
let courseId: number;

beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-09T08:00:00Z');
  monitor = (await signedIn(ctx, 'monitor')).client;
  const quran = await makeCourse(ctx);
  courseId = quran.id;
  a = await m2Teacher(ctx, 'Africa/Cairo', 'Amina');
  b = await m2Teacher(ctx, 'Africa/Cairo', 'Bilal');
  await ctx.prisma.teacher.update({ where: { id: a.id }, data: { gender: 'female' } });
  await ctx.prisma.teacher.update({ where: { id: b.id }, data: { gender: 'male' } });
  await ctx.prisma.teacherCourse.create({ data: { teacherId: a.id, courseId } });
  await ctx.prisma.teacherWorkHour.createMany({
    data: [
      // A: Mondays 09:00–13:00 Cairo. B: Wednesdays 09:00–11:00.
      {
        teacherId: a.id,
        weekday: 1,
        localStartTime: '09:00',
        localEndTime: '13:00',
        timezone: 'Africa/Cairo',
      },
      {
        teacherId: b.id,
        weekday: 3,
        localStartTime: '09:00',
        localEndTime: '11:00',
        timezone: 'Africa/Cairo',
      },
    ],
  });
  // A is away 12:00–13:00 on Monday 2 Nov; Wednesday 4 Nov is an academy holiday.
  await ctx.prisma.teacherBlock.create({
    data: {
      teacherId: a.id,
      kind: 'one_off',
      reason: 'other',
      startsAt: new Date('2026-11-02T10:00:00Z'),
      endsAt: new Date('2026-11-02T11:00:00Z'),
    },
  });
  await ctx.prisma.holiday.create({
    data: { name: 'Holiday', date: new Date('2026-11-04T00:00:00Z') },
  });
  const e = await m2Enrollment(ctx, await m2Student(ctx), a, { courseId });
  // 09:00–10:00 taken (inside), 10:00 cancelled (not booked), 14:00–14:30 outside the hours.
  await m2Session(ctx, e, '2026-11-02T07:00:00Z', { durationMinutes: 60, stage: 'taken' });
  await m2Session(ctx, e, '2026-11-02T08:00:00Z', { stage: 'cancelled' });
  await m2Session(ctx, e, '2026-11-02T12:00:00Z');
});

const WEEK = 'from=2026-11-02&to=2026-11-08';

describe('GET /reports/teacher-utilization', () => {
  it('computes available, booked, free and outside hours, utilization and the trend', async () => {
    const res = await monitor.get(`/reports/teacher-utilization?${WEEK}`);
    expect(res.status).toBe(200);
    expect(res.body.data.range).toEqual({
      from: '2026-11-02',
      to: '2026-11-08',
      previous: { from: '2026-10-26', to: '2026-11-01' },
      timezone: 'Africa/Cairo',
    });
    const [first, second] = res.body.data.teachers;
    expect(first).toMatchObject({
      teacher: { id: a.id },
      classes: 2,
      availableHours: 3, // 4 h of work hours − the 1 h block
      bookedHours: 1.5, // 1 h taken + 30 min scheduled (the cancelled class does not count)
      freeHours: 2, // 10:00–12:00
      outsideHours: 0.5, // the 14:00 class
      utilization: 0.5,
      // The Monday before (26 Oct, still UTC+3): 4 h available, nothing booked.
      previous: { availableHours: 4, bookedHours: 0, utilization: 0 },
      utilizationDelta: 0.5,
    });
    // B's only working day is a holiday: nothing available, no ratio.
    expect(second).toMatchObject({
      teacher: { id: b.id },
      availableHours: 0,
      utilization: null,
      utilizationDelta: null,
      previous: { availableHours: 2 },
    });
    // Per day (D148 «busiest / emptiest days»): Monday carries everything, Wednesday is a holiday.
    expect(res.body.data.days).toHaveLength(7);
    expect(res.body.data.days[0]).toEqual({
      date: '2026-11-02',
      weekday: 1,
      classes: 2,
      availableHours: 3,
      bookedHours: 1.5,
      freeHours: 2,
      outsideHours: 0.5,
      utilization: 0.5,
    });
    expect(res.body.data.days[2]).toMatchObject({
      date: '2026-11-04',
      weekday: 3,
      availableHours: 0,
      utilization: null,
    });
    expect(res.body.data.days[6]).toMatchObject({ date: '2026-11-08', weekday: 7, classes: 0 });
    expect(res.body.data.totals).toEqual({
      availableHours: 3,
      bookedHours: 1.5,
      freeHours: 2,
      outsideHours: 0.5,
      utilization: 0.5,
    });
  });

  it('filters by teacher, course and gender', async () => {
    const ids = async (qs: string) =>
      (
        (await monitor.get(`/reports/teacher-utilization?${WEEK}&${qs}`)).body.data
          .teachers as Array<{
          teacher: { id: number };
        }>
      ).map((t) => t.teacher.id);
    expect(await ids(`teacherIds=${b.id}`)).toEqual([b.id]);
    expect(await ids(`courseId=${courseId}`)).toEqual([a.id]);
    expect(await ids('gender=male')).toEqual([b.id]);
  });

  it('a teacher sees only their own row; parents 403; no session 401; a long range 422', async () => {
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: b.userId } });
    const teacher = await signInAs(ctx, user);
    const own = await teacher.get(`/reports/teacher-utilization?${WEEK}&teacherIds=${a.id}`);
    expect(own.status).toBe(200);
    expect(own.body.data.teachers.map((t: { teacher: { id: number } }) => t.teacher.id)).toEqual([
      b.id,
    ]);
    const grid = await teacher.get('/reports/free-capacity?from=2026-11-02&to=2026-11-02');
    expect(grid.body.data.teacherCount).toBe(1);
    const { client: parent } = await signedIn(ctx, 'parent');
    expect((await parent.get(`/reports/teacher-utilization?${WEEK}`)).status).toBe(403);
    expect((await parent.get('/reports/free-capacity')).status).toBe(403);
    expect(
      (await request(ctx.app.getHttpServer()).get('/api/v1/reports/teacher-utilization')).status,
    ).toBe(401);
    expect(
      (await monitor.get('/reports/teacher-utilization?from=2026-01-01&to=2026-12-31')).status,
    ).toBe(422);
    expect((await monitor.get('/reports/free-capacity?from=2026-11-01&to=2026-11-10')).status).toBe(
      422,
    );
  });
});

describe('GET /reports/free-capacity', () => {
  it('counts teachers free for each whole hour, in the chosen zone', async () => {
    const res = await monitor.get('/reports/free-capacity?from=2026-11-02&to=2026-11-04');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      range: { from: '2026-11-02', to: '2026-11-04', timezone: 'Africa/Cairo' },
      teacherCount: 2,
    });
    const [mon, tue, wed] = res.body.data.days;
    expect(mon).toMatchObject({ date: '2026-11-02', weekday: 1 });
    // Monday: A is free 10:00–12:00 Cairo (09:00 taken, 12:00 blocked).
    const freeHours = (day: { free: number[] }) =>
      day.free.flatMap((n, h) => (n > 0 ? [`${h}:${n}`] : []));
    expect(freeHours(mon)).toEqual(['10:1', '11:1']);
    expect(freeHours(tue)).toEqual([]);
    expect(freeHours(wed)).toEqual([]); // B's Wednesday is a holiday

    // The same Monday seen from London (UTC+0): 08:00 and 09:00.
    const london = await monitor.get(
      '/reports/free-capacity?from=2026-11-02&to=2026-11-02&tz=Europe/London',
    );
    expect(freeHours(london.body.data.days[0])).toEqual(['8:1', '9:1']);
    // Filters: B only (male) → nothing free that Monday.
    const male = await monitor.get(
      '/reports/free-capacity?from=2026-11-02&to=2026-11-02&gender=male',
    );
    expect(male.body.data.teacherCount).toBe(1);
    expect(freeHours(male.body.data.days[0])).toEqual([]);
  });
});
