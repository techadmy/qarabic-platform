import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../src/common/errors.js';
import { TestsService } from '../src/teaching/tests.service.js';
import {
  authUser,
  type Client,
  clock,
  createTestApp,
  createUser,
  m2Enrollment,
  m2Student,
  m2Teacher,
  makeFamily,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';

/*
 * Port of Laravel tests/Feature/M3/TestsApiTest.php (docs/27, D113–D120): scheduling, results,
 * decisions and the row scope. Staff see everything; a teacher sees the tests they examine and
 * their students' tests and acts only on the tests they examine; a parent sees their own
 * children's tests without internal data. Every out-of-scope row answers 404.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let teacher: Awaited<ReturnType<typeof m2Teacher>>;
let otherTeacher: Awaited<ReturnType<typeof m2Teacher>>;
let family: Awaited<ReturnType<typeof makeFamily>>;
let child: Awaited<ReturnType<typeof m2Student>>;
let otherChild: Awaited<ReturnType<typeof m2Student>>;

const at = (iso: string) => clock(ctx).set(iso);
const ALL = ['makharij', 'noon_sakin', 'meem_sakin', 'qalqala', 'ghunna', 'madd'];

beforeEach(async () => {
  await resetState(ctx);
  at('2026-11-10T10:00:00Z');
  teacher = await m2Teacher(ctx, 'Asia/Karachi');
  family = await makeFamily(ctx, { timezone: 'Europe/London' });
  child = await m2Student(ctx, 'Europe/London', family);
  await ctx.prisma.student.update({ where: { id: child.id }, data: { teacherId: teacher.id } });
  await m2Enrollment(ctx, child, teacher);

  otherTeacher = await m2Teacher(ctx, 'Africa/Cairo');
  const otherFamily = await makeFamily(ctx, { timezone: 'America/Toronto' });
  otherChild = await m2Student(ctx, 'America/Toronto', otherFamily);
  await ctx.prisma.student.update({
    where: { id: otherChild.id },
    data: { teacherId: otherTeacher.id },
  });
  await m2Enrollment(ctx, otherChild, otherTeacher);
});

function testPayload(o: Record<string, unknown> = {}) {
  return {
    studentId: child.id,
    track: 'hifz',
    sections: ALL,
    scheduledAt: '2026-11-12T16:00:00Z',
    ...o,
  };
}

async function scheduleAs(client: Client, o: Record<string, unknown> = {}): Promise<number> {
  const res = await client.post('/tests', testPayload(o));
  if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id as number;
}

const as = async (role: string) => (await signedIn(ctx, role)).client;
const asTeacher = () => signInAs(ctx, teacher.user);

describe('student tests (TestsApiTest)', () => {
  it("lets a monitor schedule a test with the student's teacher as default examiner and both zones", async () => {
    const monitor = await as('monitor');
    const res = await monitor.post('/tests', testPayload({ notes: 'Juz 30' }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'scheduled',
      teacher: { id: teacher.id, timezone: 'Asia/Karachi' },
      student: { id: child.id, timezone: 'Europe/London' },
      scheduledAt: '2026-11-12T16:00:00Z',
      month: '2026-11',
      result: null,
      notes: 'Juz 30',
      can: { record: true, setExaminer: true },
    });

    // One open test per student and track.
    const twice = await monitor.post('/tests', testPayload());
    expect(twice.status).toBe(422);
    expect(twice.body.code).toBe('test_already_scheduled');
    // Another examiner (QA) on another track.
    const qa = await monitor.post(
      '/tests',
      testPayload({ track: 'qaida', teacherId: otherTeacher.id }),
    );
    expect(qa.status).toBe(201);
    expect(qa.body.data.teacher.id).toBe(otherTeacher.id);
    // Unknown section.
    const bad = await monitor.post('/tests', testPayload({ track: 'nazra', sections: ['tafsir'] }));
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.errors)).toEqual(['sections.0']);
    const missing = await monitor.post('/tests', {});
    expect(Object.keys(missing.body.errors).sort()).toEqual([
      'scheduledAt',
      'sections',
      'studentId',
      'track',
    ]);
  });

  it('lets a teacher schedule only for their own students and only as examiner', async () => {
    const t = await asTeacher();
    const res = await t.post('/tests', testPayload());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      teacher: { id: teacher.id },
      can: { setExaminer: false, cancel: true },
    });
    expect(
      (await t.post('/tests', testPayload({ track: 'qaida', teacherId: otherTeacher.id }))).status,
    ).toBe(403);
    expect((await t.post('/tests', testPayload({ studentId: otherChild.id }))).status).toBe(404);
  });

  it('applies the permission matrix per role', async () => {
    const id = await scheduleAs(await as('manager'));

    const csr = await as('csr');
    const seen = await csr.get(`/tests/${id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.can.record).toBe(false);
    expect((await csr.post('/tests', testPayload({ track: 'qaida' }))).status).toBe(403);
    expect((await csr.post(`/tests/${id}/refuse`, { reason: 'No show' })).status).toBe(403);
    for (const role of ['billing', 'accounts']) {
      expect((await (await as(role)).get('/tests')).status).toBe(403);
    }
    // Parents never act.
    const parent = await signInAs(ctx, family.user);
    expect((await parent.post('/tests', testPayload({ track: 'qaida' }))).status).toBe(403);
    expect((await parent.put(`/tests/${id}/result`, { mistakes: [] })).status).toBe(403);
    // Reopen is staff only.
    const t = await asTeacher();
    expect((await t.post(`/tests/${id}/refuse`, { reason: 'Student refused' })).status).toBe(200);
    expect((await t.post(`/tests/${id}/reopen`, { reason: 'By mistake' })).status).toBe(403);
    const reopened = await (
      await as('senior_manager')
    ).post(`/tests/${id}/reopen`, { reason: 'By mistake' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({ status: 'scheduled', statusReason: null });
  });

  it('scores each track like the old system, keeps mistake 26 and rejects mistakes outside the sections', async () => {
    at('2026-11-12T16:05:00Z');
    const monitor = await as('monitor');

    // Hifz, all sections (Σw = 26): 3 mistakes → 88; reading 75, hifz 50 → round(213/3) = 71.
    const id = await scheduleAs(monitor, { scheduledAt: '2026-11-12T16:00:00Z' });
    const noHifz = await monitor.put(`/tests/${id}/result`, {
      mistakes: [1, 7, 26],
      readingScore: 75,
    });
    expect(noHifz.status).toBe(422);
    expect(Object.keys(noHifz.body.errors)).toEqual(['hifzScore']);
    const dup = await monitor.put(`/tests/${id}/result`, {
      mistakes: [26, 1, 7, 7],
      readingScore: 75,
      hifzScore: 50,
    });
    expect(dup.status).toBe(422);
    const ok = await monitor.put(`/tests/${id}/result`, {
      mistakes: [26, 1, 7],
      readingScore: 75,
      hifzScore: 50,
      remarks: 'Good effort',
      internalNotes: 'Weak madd',
      teacherRating: 90,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('taken');
    expect(ok.body.data.result).toMatchObject({
      mistakes: [1, 7, 26],
      tajweed: 88,
      overall: 71,
      teacherRating: 90,
    });

    // Qaida, makharij + madd (Σw = 11): 2 mistakes → 82; no reading / hifz allowed.
    const q = await scheduleAs(monitor, {
      track: 'qaida',
      sections: ['madd', 'makharij'],
      scheduledAt: '2026-11-12T16:00:00Z',
    });
    const reading = await monitor.put(`/tests/${q}/result`, {
      mistakes: [2, 22],
      readingScore: 100,
    });
    expect(reading.status).toBe(422);
    expect(Object.keys(reading.body.errors)).toEqual(['readingScore']);
    const outside = await monitor.put(`/tests/${q}/result`, { mistakes: [2, 13] });
    expect(outside.status).toBe(422);
    expect(outside.body.code).toBe('mistake_outside_sections');
    const qaida = await monitor.put(`/tests/${q}/result`, { mistakes: [2, 22] });
    expect(qaida.status).toBe(200);
    expect(qaida.body.data.sections).toEqual(['makharij', 'madd']);
    expect(qaida.body.data.result).toMatchObject({ tajweed: 82, overall: 82 });

    // Nazra: (tajweed 100 + reading 25) / 2 = 63 (62.5 rounds up).
    const n = await scheduleAs(monitor, {
      track: 'nazra',
      sections: ['ghunna'],
      scheduledAt: '2026-11-12T16:00:00Z',
    });
    expect(
      (await monitor.put(`/tests/${n}/result`, { mistakes: [], readingScore: 25, hifzScore: 50 }))
        .status,
    ).toBe(422);
    const nazra = await monitor.put(`/tests/${n}/result`, { mistakes: [], readingScore: 25 });
    expect(nazra.body.data.result.overall).toBe(63);
  });

  it('lets the examiner record from 30 minutes before, edit inside the window, and staff correct with a reason', async () => {
    const id = await scheduleAs(await as('monitor'), { track: 'qaida', sections: ['makharij'] });
    const t = await asTeacher();

    at('2026-11-12T15:20:00Z');
    const early = await t.put(`/tests/${id}/result`, { mistakes: [1] });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('test_not_started');

    at('2026-11-12T15:31:00Z');
    const rec = await t.put(`/tests/${id}/result`, {
      mistakes: [1],
      teacherRating: 100,
      internalNotes: 'x',
    });
    expect(rec.status).toBe(200);
    expect(rec.body.data.result).toMatchObject({
      tajweed: 83,
      recordedAt: '2026-11-12T15:31:00Z',
      internalNotes: 'x',
    });
    expect(rec.body.data.result).not.toHaveProperty('teacherRating');
    expect(rec.body.data.can.editResult).toBe(true);
    expect(
      (await ctx.prisma.studentTest.findUniqueOrThrow({ where: { id } })).teacherRating,
    ).toBeNull();

    at('2026-11-13T10:00:00Z');
    expect((await t.put(`/tests/${id}/result`, { mistakes: [] })).body.data.result.tajweed).toBe(
      100,
    );

    at('2026-11-15T10:00:00Z'); // > 48 h after recording
    const closed = await t.put(`/tests/${id}/result`, { mistakes: [1] });
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('edit_window_closed');
    expect((await t.get(`/tests/${id}`)).body.data.can.editResult).toBe(false);

    const manager = await as('manager');
    const noReason = await manager.put(`/tests/${id}/result`, { mistakes: [1] });
    expect(noReason.status).toBe(422);
    expect(noReason.body.code).toBe('reason_required');
    const fixed = await manager.put(`/tests/${id}/result`, {
      mistakes: [1, 2],
      reason: 'Rechecked the recording',
    });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.result).toMatchObject({
      tajweed: 67,
      recordedAt: '2026-11-12T15:31:00Z',
    });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'test_result_corrected' },
      orderBy: { id: 'desc' },
    });
    expect(audit.reason).toBe('Rechecked the recording');
  });

  it('refuses, cancels and reopens with a reason and an audit row; never deletes', async () => {
    const t = await asTeacher();
    const own = await scheduleAs(t);
    const byMonitor = await scheduleAs(await as('monitor'), { track: 'nazra', sections: ['madd'] });

    const noReason = await t.post(`/tests/${own}/cancel`, {});
    expect(noReason.status).toBe(422);
    expect(Object.keys(noReason.body.errors)).toEqual(['reason']);
    expect((await t.post(`/tests/${byMonitor}/cancel`, { reason: 'Not needed' })).status).toBe(403);
    const cancelled = await t.post(`/tests/${own}/cancel`, { reason: 'Student travelling' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({
      status: 'cancelled',
      statusReason: 'Student travelling',
    });
    expect((await t.post(`/tests/${own}/refuse`, { reason: 'No show' })).status).toBe(403);
    const refused = await t.post(`/tests/${byMonitor}/refuse`, {
      reason: 'Student did not attend',
    });
    expect(refused.body.data.status).toBe('refused');
    expect(
      (await t.put(`/tests/${byMonitor}/result`, { mistakes: [], readingScore: 100 })).status,
    ).toBe(403);

    const cancelAudit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'test_cancelled' },
    });
    expect((cancelAudit.after as { reason: string }).reason).toBe('Student travelling');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'test_refused' } })).toBe(1);
    expect(await ctx.prisma.studentTest.count()).toBe(2);
  });

  it('updates a scheduled test: the examiner moves the time, only staff change the examiner', async () => {
    const t = await asTeacher();
    const monitor = await as('monitor');
    const id = await scheduleAs(monitor);

    const moved = await t.patch(`/tests/${id}`, {
      scheduledAt: '2026-11-13T09:00:00+05:00',
      sections: ['madd'],
    });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({
      scheduledAt: '2026-11-13T04:00:00Z',
      sections: ['madd'],
    });
    expect((await t.patch(`/tests/${id}`, { teacherId: otherTeacher.id })).status).toBe(403);
    const changed = await monitor.patch(`/tests/${id}`, { teacherId: otherTeacher.id });
    expect(changed.status).toBe(200);
    expect(changed.body.data.teacher.id).toBe(otherTeacher.id);
    // The first teacher still sees it (own student) but can no longer act on it.
    const seen = await t.get(`/tests/${id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.can).toMatchObject({ record: false, update: false });
    expect((await t.patch(`/tests/${id}`, { notes: 'x' })).status).toBe(403);
    expect(
      await ctx.prisma.auditLog.count({
        where: { subjectType: 'student_test', action: 'updated' },
      }),
    ).toBe(2);
  });

  it('shows a teacher only the tests they examine or of their students; others are 404', async () => {
    const monitor = await as('monitor');
    const mine = await scheduleAs(monitor);
    const theirs = await scheduleAs(monitor, { studentId: otherChild.id });
    const examining = await scheduleAs(monitor, {
      studentId: otherChild.id,
      track: 'qaida',
      teacherId: teacher.id,
    });

    const t = await asTeacher();
    const ids = (await t.get('/tests')).body.data.map((r: { id: number }) => r.id).sort();
    expect(ids).toEqual([mine, examining].sort());
    expect((await t.get(`/tests/${theirs}`)).status).toBe(404);
    expect((await t.post(`/tests/${theirs}/refuse`, { reason: 'No show' })).status).toBe(404);
    expect(
      (
        await t.put(`/tests/${theirs}/result`, {
          mistakes: [],
          readingScore: 100,
          hifzScore: 100,
        })
      ).status,
    ).toBe(404);
    // Even an invalid body: the scope answers first (no hint the test exists).
    expect((await t.put(`/tests/${theirs}/result`, { mistakes: 'x' })).status).toBe(404);
    expect((await t.get(`/tests/${examining}`)).body.data.can.record).toBe(true);
  });

  it("shows a parent only their own children's tests, without cancelled ones or internal data", async () => {
    at('2026-11-12T16:05:00Z');
    const monitor = await as('monitor');
    const taken = await scheduleAs(monitor, { scheduledAt: '2026-11-12T16:00:00Z' });
    expect(
      (
        await monitor.put(`/tests/${taken}/result`, {
          mistakes: [3],
          readingScore: 100,
          hifzScore: 100,
          remarks: 'Excellent',
          internalNotes: 'Teacher was late',
          teacherRating: 70,
        })
      ).status,
    ).toBe(200);
    const cancelled = await scheduleAs(monitor, { track: 'qaida', sections: ['madd'] });
    expect((await monitor.post(`/tests/${cancelled}/cancel`, { reason: 'Duplicate' })).status).toBe(
      200,
    );
    const other = await scheduleAs(monitor, { studentId: otherChild.id });

    const parent = await signInAs(ctx, family.user);
    const list = await parent.get('/tests');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    const row = list.body.data[0];
    expect(row.id).toBe(taken);
    expect(row.result).toMatchObject({ overall: 99, remarks: 'Excellent' });
    expect(row.result).not.toHaveProperty('internalNotes');
    expect(row.result).not.toHaveProperty('teacherRating');
    expect(row.result).not.toHaveProperty('editableUntil');
    expect(row.can.record).toBe(false);
    expect((await parent.get(`/tests?studentId=${otherChild.id}`)).body.data).toHaveLength(0);
    expect((await parent.get(`/tests/${other}`)).status).toBe(404);
    expect((await parent.get(`/tests/${cancelled}`)).status).toBe(404);
    expect((await parent.get('/tests/summary?month=2026-11')).status).toBe(403);
  });

  it('buckets tests by the academy month (Cairo) and counts the summary tiles correctly', async () => {
    const monitor = await as('monitor');
    // 23:30 Cairo on 30 Nov = 21:30Z; London 21:30, Karachi 02:30 on 1 Dec → still November.
    const lateNov = await scheduleAs(monitor, { scheduledAt: '2026-11-30T21:30:00Z' });
    // 00:30 Cairo on 1 Dec = 22:30Z on 30 Nov → December.
    const earlyDec = await scheduleAs(monitor, {
      track: 'qaida',
      sections: ['madd'],
      scheduledAt: '2026-11-30T22:30:00Z',
    });
    const refused = await scheduleAs(monitor, {
      studentId: otherChild.id,
      scheduledAt: '2026-11-20T10:00:00Z',
    });
    await monitor.post(`/tests/${refused}/refuse`, { reason: 'No show' });
    const cancelled = await scheduleAs(monitor, {
      studentId: otherChild.id,
      track: 'nazra',
      sections: ['madd'],
      scheduledAt: '2026-11-21T10:00:00Z',
    });
    await monitor.post(`/tests/${cancelled}/cancel`, { reason: 'Duplicate' });

    expect((await monitor.get(`/tests/${lateNov}`)).body.data.month).toBe('2026-11');
    expect((await monitor.get(`/tests/${earlyDec}`)).body.data.month).toBe('2026-12');
    const nov = await monitor.get('/tests?month=2026-11');
    expect(nov.body.data).toHaveLength(3);
    expect(nov.body.meta.counts).toEqual({
      all: 3,
      scheduled: 1,
      taken: 0,
      refused: 1,
      cancelled: 1,
    });
    const scheduled = await monitor.get('/tests?month=2026-11&status=scheduled');
    expect(scheduled.body.data.map((r: { id: number }) => r.id)).toEqual([lateNov]);

    const summary = await monitor.get('/tests/summary?month=2026-11');
    expect(summary.status).toBe(200);
    expect(summary.body.data.counts).toEqual({
      created: 2,
      taken: 0,
      remaining: 1,
      refused: 1,
      cancelled: 1,
    });
    expect(summary.body.data.byTeacher).toHaveLength(2);
    const t = await asTeacher();
    const own = await t.get('/tests/summary?month=2026-11');
    expect(own.body.data.counts.created).toBe(1);
    expect(own.body.data.byTeacher).toHaveLength(1);
    expect(own.body.data.byTeacher[0].teacher.id).toBe(teacher.id);
    expect((await monitor.get('/tests/summary?month=2026-13')).status).toBe(422);
  });

  it('keeps one scheduled test per student and track across creates and reopens', async () => {
    const monitor = await as('monitor');
    const first = await scheduleAs(monitor);
    const twice = await monitor.post(
      '/tests',
      testPayload({ scheduledAt: '2026-11-13T16:00:00Z' }),
    );
    expect(twice.status).toBe(422);
    expect(twice.body.code).toBe('test_already_scheduled');
    expect(await ctx.prisma.studentTest.count({ where: { studentId: child.id } })).toBe(1);

    await monitor.post(`/tests/${first}/refuse`, { reason: 'Student did not attend' });
    const second = await scheduleAs(monitor, { scheduledAt: '2026-11-14T16:00:00Z' });
    // Reopening the refused one would make two scheduled tests in the same track.
    const reopen = await monitor.post(`/tests/${first}/reopen`, { reason: 'Entered by mistake' });
    expect(reopen.status).toBe(422);
    expect(reopen.body.code).toBe('test_already_scheduled');
    expect((await ctx.prisma.studentTest.findUniqueOrThrow({ where: { id: first } })).status).toBe(
      'refused',
    );

    await monitor.post(`/tests/${second}/cancel`, { reason: 'Duplicate' });
    const ok = await monitor.post(`/tests/${first}/reopen`, { reason: 'Entered by mistake' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('scheduled');
  });

  it('re-checks the status under a lock when a decision or a result arrives on a stale test', async () => {
    at('2026-11-12T16:05:00Z');
    const monitor = await createUser(ctx, 'monitor');
    const client = await signInAs(ctx, monitor);
    const id = await scheduleAs(client, { scheduledAt: '2026-11-12T16:00:00Z' });
    const stale = await ctx.prisma.studentTest.findUniqueOrThrow({ where: { id } });
    await ctx.prisma.studentTest.update({ where: { id }, data: { status: 'cancelled' } });

    const service = ctx.app.get(TestsService);
    const user = await authUser(ctx, monitor);
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        if (e instanceof ApiException) {
          return [e.getStatus(), (e.getResponse() as { code: string }).code];
        }
        throw e;
      }
      return [0, 'ok'];
    };
    expect(await code(service.decide(stale, 'refused', 'No show', user))).toEqual([
      409,
      'invalid_test_status',
    ]);
    expect(
      await code(service.record(stale, { mistakes: [], readingScore: 100, hifzScore: 100 }, user)),
    ).toEqual([409, 'invalid_test_status']);
    expect((await ctx.prisma.studentTest.findUniqueOrThrow({ where: { id } })).status).toBe(
      'cancelled',
    );
  });

  it('does not move a scheduled test into the past', async () => {
    const monitor = await as('monitor');
    const id = await scheduleAs(monitor);
    const res = await monitor.patch(`/tests/${id}`, { scheduledAt: '2026-11-01T10:00:00Z' });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors)).toEqual(['scheduledAt']);
    const create = await monitor.post(
      '/tests',
      testPayload({ track: 'qaida', scheduledAt: '2026-11-08T10:00:00Z' }),
    );
    expect(create.status).toBe(422);
  });
});

describe('student tests: N3 extras', () => {
  it('answers 401 without a session on every test route', async () => {
    const anon = request(ctx.app.getHttpServer());
    expect((await anon.get('/api/v1/tests')).status).toBe(401);
    expect((await anon.get('/api/v1/tests/summary?month=2026-11')).status).toBe(401);
  });

  it('asks staff for an examiner when the student has no teacher (no_examiner)', async () => {
    const lonely = await m2Student(ctx);
    const res = await (await as('monitor')).post('/tests', testPayload({ studentId: lonely.id }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('no_examiner');
    expect(Object.keys(res.body.errors)).toEqual(['teacherId']);
  });

  it('refuses an unknown or archived examiner', async () => {
    const gone = await m2Teacher(ctx);
    await ctx.prisma.teacher.update({ where: { id: gone.id }, data: { archivedAt: new Date() } });
    const res = await (await as('monitor')).post('/tests', testPayload({ teacherId: gone.id }));
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors)).toEqual(['teacherId']);
  });

  it('pages scheduled tests first (soonest first), then the rest (newest first)', async () => {
    at('2026-11-12T16:05:00Z');
    const monitor = await as('monitor');
    const done = await scheduleAs(monitor, { scheduledAt: '2026-11-12T16:00:00Z' });
    await monitor.put(`/tests/${done}/result`, { mistakes: [], readingScore: 100, hifzScore: 100 });
    const later = await scheduleAs(monitor, {
      track: 'qaida',
      sections: ['madd'],
      scheduledAt: '2026-11-20T10:00:00Z',
    });
    const sooner = await scheduleAs(monitor, {
      studentId: otherChild.id,
      scheduledAt: '2026-11-14T10:00:00Z',
    });
    const ids = (await monitor.get('/tests')).body.data.map((r: { id: number }) => r.id);
    expect(ids).toEqual([sooner, later, done]);
    const page2 = await monitor.get('/tests?perPage=2&page=2');
    expect(page2.body.data.map((r: { id: number }) => r.id)).toEqual([done]);
    expect(page2.body.meta).toMatchObject({ total: 3, lastPage: 2 });
  });
});
