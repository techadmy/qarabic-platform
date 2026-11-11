import request from 'supertest';
import { QURAN_SURAHS } from '@qarabic/shared';
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

/*
 * N3 teacher portal (D71, D138): `/me` carries `teacherId`; «أسبوعي» (Saturday–Friday in the
 * teacher's zone) and «طلابي»; plus the progress coverage and the Quran reference table.
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
let student: Awaited<ReturnType<typeof m2Student>>;
let enrollment: Awaited<ReturnType<typeof m2Enrollment>>;

const at = (iso: string) => clock(ctx).set(iso);
const report = (hifz: unknown[], summary = 'ok') => ({ summary, rating: 5, hifz });

beforeEach(async () => {
  await resetState(ctx);
  at('2026-11-10T12:00:00Z'); // Tuesday
  teacher = await m2Teacher(ctx, 'Asia/Karachi');
  family = await makeFamily(ctx, { timezone: 'Europe/London' });
  student = await m2Student(ctx, 'Europe/London', family, 'Amina');
  await ctx.prisma.student.update({
    where: { id: student.id },
    data: { teacherId: teacher.id, age: 9, remarkTeacher: 'Loves Juz Amma' },
  });
  enrollment = await m2Enrollment(ctx, student, teacher);
});

describe('/me teacherId (N2 leftover)', () => {
  it('carries the own teacher id for a teacher, null for everyone else', async () => {
    const t = await signInAs(ctx, teacher.user);
    expect((await t.get('/me')).body.teacherId).toBe(teacher.id);
    expect((await t.get('/auth/me')).body.teacherId).toBe(teacher.id);
    const timetable = await t.get(`/teachers/${(await t.get('/me')).body.teacherId}/timetable`);
    expect(timetable.status).toBe(200);
    const { client: monitor } = await signedIn(ctx, 'monitor');
    expect((await monitor.get('/me')).body.teacherId).toBeNull();
    const parent = await signInAs(ctx, family.user);
    expect((await parent.get('/auth/me')).body.teacherId).toBeNull();
  });
});

describe('teacher portal: my week', () => {
  it('cuts a Saturday–Friday week in the teacher zone with the summary tiles', async () => {
    // Karachi is UTC+5: Saturday 7 Nov 00:00 local = Friday 6 Nov 19:00Z.
    const before = await m2Session(ctx, enrollment, '2026-11-06T18:30:00Z', { stage: 'taken' });
    const saturday = await m2Session(ctx, enrollment, '2026-11-06T19:30:00Z', { stage: 'ended' });
    const taken = await m2Session(ctx, enrollment, '2026-11-08T10:00:00Z', { stage: 'taken' });
    const today = await m2Session(ctx, enrollment, '2026-11-10T15:00:00Z');
    const friday = await m2Session(ctx, enrollment, '2026-11-13T18:00:00Z');
    const after = await m2Session(ctx, enrollment, '2026-11-13T19:30:00Z');
    // Someone else's class the same week (D138).
    await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), await m2Teacher(ctx)),
      '2026-11-10T15:00:00Z',
    );

    const t = await signInAs(ctx, teacher.user);
    const res = await t.get('/teacher-portal/week');
    expect(res.status).toBe(200);
    const week = res.body.data;
    expect(week).toMatchObject({
      teacher: { id: teacher.id, timezone: 'Asia/Karachi' },
      timezone: 'Asia/Karachi',
      weekStart: '2026-11-07',
      weekEnd: '2026-11-13',
      today: '2026-11-10',
      previousWeek: '2026-10-31',
      nextWeek: '2026-11-14',
      summary: { total: 4, taken: 1, remaining: 2, needsReport: 1, absent: 0, leave: 0 },
    });
    expect(week.days.map((d: { date: string }) => d.date)).toEqual([
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
    ]);
    const ids = week.days.flatMap((d: { sessions: Array<{ id: number }> }) =>
      d.sessions.map((s) => s.id),
    );
    expect(ids).toEqual([saturday.id, taken.id, today.id, friday.id]);
    expect(ids).not.toContain(before.id);
    expect(ids).not.toContain(after.id);
    expect(week.days[0].sessions[0].allowedActions).toContain('submit_report');

    const prev = await t.get('/teacher-portal/week?date=2026-11-06');
    expect(prev.body.data.weekStart).toBe('2026-10-31');
    expect((await t.get('/teacher-portal/week?date=nope')).status).toBe(422);
  });

  it('is for teachers only: staff and parents 403, no session 401', async () => {
    const { client: admin } = await signedIn(ctx, 'admin');
    expect((await admin.get('/teacher-portal/week')).status).toBe(403);
    expect((await admin.get('/teacher-portal/students')).status).toBe(403);
    const parent = await signInAs(ctx, family.user);
    expect((await parent.get('/teacher-portal/week')).status).toBe(403);
    const anon = await request(ctx.app.getHttpServer()).get('/api/v1/teacher-portal/students');
    expect(anon.status).toBe(401);
  });
});

describe('teacher portal: my students', () => {
  it('lists own students with next class, last report, missing reports and last positions', async () => {
    const ended = await m2Session(ctx, enrollment, '2026-11-09T10:00:00Z', { stage: 'ended' });
    await m2Session(ctx, enrollment, '2026-11-08T10:00:00Z', { stage: 'ended' });
    const next = await m2Session(ctx, enrollment, '2026-11-11T10:00:00Z');
    await m2Session(ctx, enrollment, '2026-11-12T10:00:00Z');
    // A student of another teacher: never listed.
    await m2Enrollment(ctx, await m2Student(ctx), await m2Teacher(ctx));

    const t = await signInAs(ctx, teacher.user);
    await t.put(
      `/sessions/${ended.id}/report`,
      report([{ type: 'sabaq', from: { surah: 78, ayah: 1 }, to: { surah: 78, ayah: 10 } }]),
    );
    const res = await t.get('/teacher-portal/students');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const row = res.body.data[0];
    expect(row).toMatchObject({
      id: student.id,
      name: 'Amina',
      age: 9,
      timezone: 'Europe/London',
      remarkTeacher: 'Loves Juz Amma',
      enrollments: [{ id: enrollment.id, status: 'active' }],
      nextSession: { id: next.id, startsAt: '2026-11-11T10:00:00Z' },
      lastReport: { sessionId: ended.id, submittedAt: '2026-11-10T12:00:00Z' },
      reportsMissing: 1,
    });
    expect(row.lastPositions).toEqual([
      expect.objectContaining({ type: 'sabaq', to: { surah: 78, ayah: 10 }, sessionId: ended.id }),
    ]);
    // D138: no contact or family data.
    expect(Object.keys(row)).not.toContain('email');
    expect(Object.keys(row)).not.toContain('family');
  });
});

describe('progress coverage', () => {
  it('counts each memorised ayah once, across surahs and types, skipping not_memorised rows', async () => {
    const t = await signInAs(ctx, teacher.user);
    const a = await m2Session(ctx, enrollment, '2026-10-05T10:00:00Z', { stage: 'ended' });
    const b = await m2Session(ctx, enrollment, '2026-11-02T10:00:00Z', { stage: 'ended' });
    // October: An-Nas → Al-Ikhlas backwards (6 + 5 + 4 = 15).
    await t.put(
      `/sessions/${a.id}/report`,
      report([{ type: 'sabaq', from: { surah: 114, ayah: 1 }, to: { surah: 112, ayah: 4 } }]),
    );
    // November: overlaps Al-Falaq again + An-Naba 1–10; a revision of Al-Fatiha; a failed row.
    await t.put(
      `/sessions/${b.id}/report`,
      report([
        { type: 'sabaq', from: { surah: 113, ayah: 1 }, to: { surah: 113, ayah: 5 } },
        { type: 'sabaq', from: { surah: 78, ayah: 1 }, to: { surah: 78, ayah: 10 } },
        { type: 'manzil', from: { surah: 1, ayah: 1 }, to: { surah: 1, ayah: 7 } },
        {
          type: 'sabaqi',
          from: { surah: 2, ayah: 1 },
          to: { surah: 2, ayah: 20 },
          grade: 'not_memorised',
        },
      ]),
    );
    const res = await t.get(`/students/${student.id}/progress`);
    expect(res.status).toBe(200);
    const { coverage, monthlyAyahs, timeline, lastPositions, student: who } = res.body.data;
    expect(who).toEqual({ id: student.id, name: 'Amina', timezone: 'Europe/London' });
    expect(coverage).toMatchObject({
      memorisedAyahs: 15 + 10 + 7,
      totalAyahs: 6236,
      percent: 0.5,
      completeSurahs: 4,
    });
    expect(coverage.surahs.map((s: { number: number }) => s.number)).toEqual([
      1, 78, 112, 113, 114,
    ]);
    expect(coverage.surahs[1]).toEqual({
      number: 78,
      memorisedAyahs: 10,
      ayahCount: 40,
      complete: false,
    });
    expect(monthlyAyahs).toEqual([
      { month: '2026-10', ayahs: 15 },
      { month: '2026-11', ayahs: 15 },
    ]);
    // Newest class first; filters by type and class time.
    expect(timeline.map((r: { sessionId: number }) => r.sessionId)).toEqual([b.id, a.id]);
    expect(lastPositions.map((p: { type: string }) => p.type)).toEqual([
      'sabaq',
      'sabaqi',
      'manzil',
    ]);
    const onlyManzil = await t.get(`/students/${student.id}/progress?type=manzil`);
    expect(onlyManzil.body.data.timeline[0].hifz).toHaveLength(1);
    const fromNov = await t.get(`/students/${student.id}/progress?from=2026-11-01T00:00:00Z`);
    expect(fromNov.body.data.timeline).toHaveLength(1);
  });

  it('needs families.view or a teacher (CSR yes, billing no) and keeps the Quran table seeded', async () => {
    const { client: csr } = await signedIn(ctx, 'csr');
    expect((await csr.get(`/students/${student.id}/progress`)).status).toBe(200);
    const { client: accounts } = await signedIn(ctx, 'accounts');
    expect((await accounts.get(`/students/${student.id}/progress`)).status).toBe(403);

    const rows = await ctx.prisma.quranSurah.findMany({ orderBy: { number: 'asc' } });
    expect(rows).toEqual(QURAN_SURAHS);
    expect(rows.reduce((n, s) => n + s.ayahCount, 0)).toBe(6236);
  });
});
