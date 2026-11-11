import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../src/common/errors.js';
import {
  ConflictChecker,
  type SessionCandidate,
  type SlotCandidate,
} from '../src/schedule/conflicts.js';
import { SessionJobs } from '../src/sessions/jobs.js';
import { SettingsService } from '../src/settings/settings.service.js';
import {
  clock,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Slot,
  m2Student,
  m2Teacher,
  makeCourse,
  resetState,
  signedIn,
  signInAs,
  type Client,
  type TestContext,
} from './helpers.js';

/*
| Ports of Laravel tests/Feature/M2/ConflictCheckerTest.php (docs/14 §5) and AvailabilityTest.php
| (§5.5), DST included (UK/US/Karachi/Sydney).
*/

let ctx: TestContext;
let checker: ConflictChecker;

beforeAll(async () => {
  ctx = await createTestApp();
  checker = ctx.app.get(ConflictChecker);
});
afterAll(async () => {
  await ctx.app.close();
});

let teacher: Awaited<ReturnType<typeof m2Teacher>>;
let student: Awaited<ReturnType<typeof m2Student>>;
let enrollment: Awaited<ReturnType<typeof m2Enrollment>>;

beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-09T08:00:00Z'); // Monday
  teacher = await m2Teacher(ctx, 'Africa/Cairo');
  student = await m2Student(ctx, 'Europe/London');
  enrollment = await m2Enrollment(ctx, student, teacher);
});

const settings = () => ctx.app.get(SettingsService).all();
const session = async (o: Partial<SessionCandidate> & { at?: string } = {}) =>
  checker.checkSession(
    ctx.prisma,
    {
      teacherId: o.teacherId ?? teacher.id,
      studentId: o.studentId ?? student.id,
      startsAt: new Date(o.at ?? '2026-11-10T15:00:00Z').getTime(),
      durationMinutes: o.durationMinutes ?? 30,
      enrollmentId: o.enrollmentId === undefined ? enrollment.id : o.enrollmentId,
      excludeSessionId: o.excludeSessionId ?? null,
    },
    await settings(),
  );
const slot = async (o: Partial<SlotCandidate> = {}) =>
  checker.checkSlot(
    ctx.prisma,
    {
      teacherId: teacher.id,
      studentId: student.id,
      weekday: 1,
      localStartTime: '17:00',
      durationMinutes: 30,
      timezone: 'Europe/London',
      validFrom: '2026-11-09',
      validTo: null,
      enrollmentId: enrollment.id,
      excludeSlotIds: [],
      ...o,
    },
    await settings(),
  );
const codes = (list: Array<{ code: string }>) => list.map((c) => c.code);

describe('conflict checker (ConflictCheckerTest)', () => {
  it('passes a free time', async () => {
    const r = await session();
    expect([r.conflicts, r.warnings]).toEqual([[], []]);
  });

  it('blocks a teacher overlap but allows back-to-back, unless a buffer is set', async () => {
    await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), teacher),
      '2026-11-10T14:30:00Z',
    );
    expect(codes((await session({ at: '2026-11-10T14:45:00Z' })).conflicts)).toEqual([
      'teacher_overlap',
    ]);
    expect((await session()).conflicts).toEqual([]);
    await ctx.app.get(SettingsService).set('sessions.teacher_buffer_min', 5, null);
    expect(codes((await session()).conflicts)).toEqual(['teacher_overlap']);
  });

  it('blocks a student overlap with another teacher', async () => {
    const course = await makeCourse(ctx);
    await m2Session(
      ctx,
      await m2Enrollment(ctx, student, await m2Teacher(ctx), { courseId: course.id }),
      '2026-11-10T15:15:00Z',
    );
    const r = await session();
    expect(codes(r.conflicts)).toEqual(['student_overlap']);
    const dto = r.toDto().conflicts[0]!;
    expect(Object.keys(dto)).toEqual(
      expect.arrayContaining(['code', 'severity', 'message', 'with', 'firstDate']),
    );
    expect(dto.with?.type).toBe('session');
  });

  it.each(['leave', 'cancelled', 'moved_out'] as const)(
    'lets a %s class free its time',
    async (stage) => {
      await m2Session(
        ctx,
        await m2Enrollment(ctx, await m2Student(ctx), teacher),
        '2026-11-10T15:00:00Z',
        {
          stage,
        },
      );
      expect((await session()).conflicts).toEqual([]);
    },
  );

  it('counts a weekly slot occurrence that is not generated yet', async () => {
    // Tuesday 15:00 London = 15:00 UTC in November
    const other = await m2Enrollment(ctx, await m2Student(ctx), teacher);
    const s = await m2Slot(ctx, other, 2, '15:00');
    const r = await session();
    expect(codes(r.conflicts)).toEqual(['teacher_overlap']);
    expect(r.conflicts[0]!.firstDate).toBe('2026-11-10');

    // once generated and taken as leave, the time is free
    await m2Session(ctx, other, '2026-11-10T15:00:00Z', {
      scheduleSlotId: s.id,
      occurrenceDate: '2026-11-10',
      stage: 'leave',
      source: 'generated',
    });
    expect((await session()).conflicts).toEqual([]);
  });

  it('blocks recurring and one-off teacher blocks', async () => {
    await ctx.prisma.teacherBlock.create({
      data: {
        teacherId: teacher.id,
        kind: 'recurring',
        reason: 'other_job',
        weekday: 2,
        localStartTime: '16:30',
        durationMinutes: 120,
        timezone: 'Africa/Cairo',
      },
    });
    expect(codes((await session()).conflicts)).toEqual(['teacher_blocked']);
    await ctx.prisma.teacherBlock.deleteMany();
    await ctx.prisma.teacherBlock.create({
      data: {
        teacherId: teacher.id,
        kind: 'one_off',
        reason: 'leave',
        startsAt: new Date('2026-11-10T00:00:00Z'),
        endsAt: new Date('2026-11-12T00:00:00Z'),
      },
    });
    expect(codes((await session()).conflicts)).toEqual(['teacher_blocked']);
  });

  it('blocks an inactive teacher and a paused enrollment', async () => {
    await ctx.prisma.teacher.update({ where: { id: teacher.id }, data: { status: 'inactive' } });
    await ctx.prisma.enrollment.update({
      where: { id: enrollment.id },
      data: { status: 'paused' },
    });
    expect(codes((await session()).conflicts)).toEqual(['teacher_inactive', 'enrollment_inactive']);
  });

  it('warns about past time, holidays, work hours, siblings and daily load', async () => {
    await ctx.prisma.holiday.create({
      data: { name: 'Eid', date: new Date('2026-11-10T00:00:00Z') },
    });
    await ctx.prisma.teacherWorkHour.create({
      data: {
        teacherId: teacher.id,
        weekday: 2,
        localStartTime: '09:00',
        localEndTime: '12:00',
        timezone: 'Africa/Cairo',
      },
    });
    const sibling = await m2Student(ctx, 'Europe/London', { id: student.familyId });
    await m2Session(
      ctx,
      await m2Enrollment(ctx, sibling, await m2Teacher(ctx)),
      '2026-11-10T15:00:00Z',
    );

    expect(codes((await session()).warnings).sort()).toEqual([
      'holiday',
      'outside_work_hours',
      'sibling_overlap',
    ]);
    expect(codes((await session({ at: '2026-11-08T15:00:00Z' })).warnings)).toContain('past_time');
    // inside work hours (Cairo 10:00 = 08:00 UTC): no warning
    expect(codes((await session({ at: '2026-11-10T08:00:00Z' })).warnings)).not.toContain(
      'outside_work_hours',
    );

    // 16 classes of 30 min that Cairo day → +30 min > 8 h
    const busy = await m2Enrollment(ctx, await m2Student(ctx), teacher);
    for (let i = 0; i < 16; i++) {
      await m2Session(
        ctx,
        busy,
        new Date(Date.parse('2026-11-11T04:00:00Z') + 30 * 60_000 * i).toISOString(),
      );
    }
    expect(codes((await session({ at: '2026-11-11T14:00:00Z' })).warnings)).toContain(
      'teacher_daily_load',
    );
  });

  it('excludes the class being moved from its own check', async () => {
    const s = await m2Session(ctx, enrollment, '2026-11-10T15:00:00Z');
    expect(
      (await session({ excludeSessionId: s.id, at: '2026-11-10T15:15:00Z' })).conflicts,
    ).toEqual([]);
  });

  it('blocks a recurring overlap that only happens in summer, with its first date', async () => {
    // another student of the same teacher, family in Karachi (no DST), Mon 21:00 = 16:00 UTC
    await m2Slot(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx, 'Asia/Karachi'), teacher, {
        timezone: 'Asia/Karachi',
      }),
      1,
      '21:00',
    );
    const r = await slot();
    expect(codes(r.conflicts)).toEqual(['teacher_overlap']);
    expect(r.conflicts[0]!.firstDate).toBe('2027-03-29');
    expect(r.conflicts[0]!.with?.type).toBe('slot');
    // ending the new slot before summer removes the conflict
    expect((await slot({ validTo: '2027-03-01' })).conflicts).toEqual([]);
  });

  it('blocks a student slot overlap and ignores the slot being replaced', async () => {
    const own = await m2Slot(ctx, enrollment, 1, '17:00');
    expect(codes((await slot({ localStartTime: '17:15' })).conflicts)).toEqual([
      'teacher_overlap',
      'student_overlap',
    ]);
    expect((await slot({ localStartTime: '17:15', excludeSlotIds: [own.id] })).conflicts).toEqual(
      [],
    );
  });

  it('ignores slots of ended enrollments and slots whose validity does not meet', async () => {
    await m2Slot(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), teacher, { status: 'ended' }),
      1,
      '17:00',
    );
    await m2Slot(ctx, await m2Enrollment(ctx, await m2Student(ctx), teacher), 1, '17:00', {
      validTo: '2026-11-01',
    });
    expect((await slot()).conflicts).toEqual([]);
  });

  it('blocks a slot over a future one-off class and over a recurring block', async () => {
    await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), teacher),
      '2026-11-23T17:00:00Z',
    );
    const r = await slot();
    expect(codes(r.conflicts)).toEqual(['teacher_overlap']);
    expect(r.conflicts[0]!.firstDate).toBe('2026-11-23');

    await ctx.prisma.teacherBlock.create({
      data: {
        teacherId: teacher.id,
        kind: 'recurring',
        reason: 'break',
        weekday: 1,
        localStartTime: '19:00',
        durationMinutes: 60,
        timezone: 'Africa/Cairo',
      },
    });
    expect(codes((await slot({ localStartTime: '17:30' })).conflicts)).toEqual(['teacher_blocked']);
  });

  it('warns when the teacher-side time shifts with DST, and about siblings', async () => {
    await m2Slot(
      ctx,
      await m2Enrollment(
        ctx,
        await m2Student(ctx, 'Europe/London', { id: student.familyId }),
        await m2Teacher(ctx),
      ),
      1,
      '17:00',
    );
    expect(codes((await slot()).warnings).sort()).toEqual(['dst_shift', 'sibling_overlap']);
    // Karachi teacher + Karachi family: no DST anywhere
    const karachi = await m2Teacher(ctx, 'Asia/Karachi');
    expect(
      (await slot({ timezone: 'Asia/Karachi', teacherId: karachi.id, enrollmentId: null }))
        .warnings,
    ).toEqual([]);
  });

  it('throws 409 on hard conflicts and 422 until warnings are acknowledged', async () => {
    await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), teacher),
      '2026-11-10T15:00:00Z',
    );
    const failOf = (fn: () => void): [number, string, unknown] => {
      try {
        fn();
      } catch (error) {
        const e = error as ApiException;
        const body = e.getResponse() as {
          code: string;
          data?: { warnings?: Array<{ code: string }> };
        };
        return [e.getStatus(), body.code, body.data?.warnings?.[0]?.code];
      }
      return [0, 'ok', null];
    };
    const hard = await session();
    expect(failOf(() => hard.assertPasses())).toEqual([409, 'schedule_conflict', undefined]);
    const soft = await session({ at: '2026-11-08T15:00:00Z' });
    expect(failOf(() => soft.assertPasses())).toEqual([
      422,
      'warnings_not_acknowledged',
      'past_time',
    ]);
    expect(failOf(() => soft.assertPasses(['past_time']))).toEqual([0, 'ok', null]);
  });

  it('audits overlaps that slipped through', async () => {
    const jobs = ctx.app.get(SessionJobs);
    expect(await jobs.auditOverlaps()).toEqual([]);
    await m2Session(ctx, enrollment, '2026-11-10T15:00:00Z');
    await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), teacher),
      '2026-11-10T15:10:00Z',
    );
    const found = await jobs.auditOverlaps();
    expect(found).toHaveLength(1);
    expect(found[0]!.by).toBe('teacher');
  });
});

describe('availability (AvailabilityTest)', () => {
  let course: Awaited<ReturnType<typeof makeCourse>>;
  let monitor: Client;

  beforeEach(async () => {
    course = await makeCourse(ctx, { nameEn: 'Quran Hifz Test' });
    monitor = (await signedIn(ctx, 'monitor')).client;
  });

  const qualified = async (zone: string) => {
    const t = await m2Teacher(ctx, zone);
    await ctx.prisma.teacherCourse.create({ data: { teacherId: t.id, courseId: course.id } });
    return t;
  };
  const hours = (t: { id: number }, zone: string, weekday: number, from: string, to: string) =>
    ctx.prisma.teacherWorkHour.create({
      data: { teacherId: t.id, weekday, localStartTime: from, localEndTime: to, timezone: zone },
    });
  const search = (q: Record<string, string | number | undefined> = {}) => {
    const params = new URLSearchParams();
    const all = {
      timezone: 'Europe/London',
      weekdays: '1',
      fromTime: '17:00',
      toTime: '18:00',
      durationMinutes: 30,
      courseId: course.id,
      effectiveFrom: '2026-11-16',
      ...q,
    };
    for (const [k, v] of Object.entries(all)) if (v !== undefined) params.set(k, String(v));
    return monitor.get(`/schedule/availability?${params.toString()}`);
  };
  const freeTimes = (body: {
    data: { teachers: Array<{ free: Array<{ localStartTime: string }> }> };
  }) => (body.data.teachers[0]?.free ?? []).map((f) => f.localStartTime);

  it('lists free times in the student zone with the teacher local time, for qualified teachers only', async () => {
    const cairo = await qualified('Africa/Cairo');
    await hours(cairo, 'Africa/Cairo', 1, '14:00', '23:00');
    await m2Teacher(ctx, 'Africa/Cairo'); // not qualified for the course

    const res = await search();
    expect(res.status).toBe(200);
    expect(res.body.data.timezone).toBe('Europe/London');
    expect(res.body.data.teachers).toHaveLength(1);
    expect(res.body.data.teachers[0].free).toHaveLength(2);
    expect(res.body.data.teachers[0].free[0]).toMatchObject({
      weekday: 1,
      localStartTime: '17:00',
      teacherLocal: { weekday: 1, time: '19:00' },
      inWorkHours: true,
      // London/Cairo DST differ in spring: the teacher-side time moves
      dstNote: '19:00 / 18:00',
    });
    expect(res.body.data.teachers[0].matchingWeekdays).toBe(1);
    expect(res.body.data.nearest).toBeNull();
  });

  it('removes times taken by slots (incl. summer-only overlaps), blocks and one-off classes', async () => {
    const karachi = await qualified('Asia/Karachi');
    // Karachi family Mon 21:00 = 16:00 UTC all year = London 16:00 winter / 17:00 summer
    await m2Slot(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx, 'Asia/Karachi'), karachi, {
        timezone: 'Asia/Karachi',
      }),
      1,
      '21:00',
      { validFrom: '2026-11-01' },
    );
    await ctx.prisma.teacherBlock.create({
      data: {
        teacherId: karachi.id,
        kind: 'recurring',
        reason: 'break',
        weekday: 1,
        localStartTime: '22:30',
        durationMinutes: 30,
        timezone: 'Asia/Karachi',
      },
    });
    const first = await search();
    expect(freeTimes(first.body)).toEqual([]);
    expect(first.body.data.workHoursNotSet[0].id).toBe(karachi.id);

    const other = await qualified('Africa/Cairo');
    await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), other),
      '2026-11-30T17:30:00Z',
    );
    expect(freeTimes((await search({ teacherIds: other.id })).body)).toEqual(['17:00']);
  });

  it('respects the student’s own schedule', async () => {
    await qualified('Africa/Cairo');
    const kid = await m2Student(ctx, 'Europe/London');
    await m2Slot(ctx, await m2Enrollment(ctx, kid, await m2Teacher(ctx)), 1, '17:00');
    expect(freeTimes((await search({ studentId: kid.id, timezone: undefined })).body)).toEqual([
      '17:30',
    ]);
  });

  it('ranks teachers in work hours first, then by load, and suggests the nearest time when empty', async () => {
    const busy = await qualified('Africa/Cairo');
    await hours(busy, 'Africa/Cairo', 1, '00:00', '23:59');
    await m2Slot(ctx, await m2Enrollment(ctx, await m2Student(ctx), busy), 3, '10:00');
    const idle = await qualified('Africa/Cairo');
    await hours(idle, 'Africa/Cairo', 1, '00:00', '23:59');
    const noHours = await qualified('Africa/Cairo');

    expect(
      (await search()).body.data.teachers.map((t: { teacher: { id: number } }) => t.teacher.id),
    ).toEqual([idle.id, busy.id, noHours.id]);

    // everyone busy at 17:00–17:30 → the nearest free time is suggested
    for (const t of [busy, idle, noHours]) {
      await m2Slot(ctx, await m2Enrollment(ctx, await m2Student(ctx), t), 1, '17:00');
    }
    const res = await search({ toTime: '17:30' });
    expect(res.body.data.teachers).toEqual([]);
    expect(res.body.data.nearest).toMatchObject({ weekday: 1, localStartTime: '17:30' });
  });

  it('is staff only', async () => {
    const asTeacher = await signInAs(ctx, (await m2Teacher(ctx)).user);
    expect(
      (
        await asTeacher.get(
          '/schedule/availability?timezone=UTC&weekdays=1&fromTime=17:00&toTime=18:00&durationMinutes=30',
        )
      ).status,
    ).toBe(403);
    const { user } = await signedIn(ctx, 'parent');
    const asParent = await signInAs(ctx, user);
    expect(
      (
        await asParent.get(
          '/schedule/availability?timezone=UTC&weekdays=1&fromTime=17:00&toTime=18:00&durationMinutes=30',
        )
      ).status,
    ).toBe(403);
  });

  it('answers well under a second for 60 teachers, 7 days, 30-minute steps', async () => {
    const zones = ['Africa/Cairo', 'Asia/Karachi', 'Europe/London', 'America/New_York'];
    for (let i = 1; i <= 60; i++) {
      const zone = zones[i % 4]!;
      const t = await qualified(zone);
      await hours(t, zone, 1, '08:00', '22:00');
      const e = await m2Enrollment(ctx, await m2Student(ctx), t);
      for (let d = 1; d <= 7; d++)
        await m2Slot(ctx, e, d, `${String(8 + (i % 12)).padStart(2, '0')}:00`);
    }
    const started = Date.now();
    const res = await search({ weekdays: '1,2,3,4,5,6,7', fromTime: '08:00', toTime: '22:00' });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
