import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SettingsService } from '../src/settings/settings.service.js';
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
 * Port of Laravel tests/Feature/M2/ReportsTest.php and the report parts of SessionsApiTest,
 * StateMachineTest and M4 ParentPortalTest (D45, D70, D72, B29, B30), plus the N3 staff list.
 * The lesson picker and the WhatsApp copy are not ported (no lesson catalog / notifications yet).
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
let session: Awaited<ReturnType<typeof m2Session>>;

const at = (iso: string) => clock(ctx).set(iso);

function payload(o: Record<string, unknown> = {}) {
  return {
    summary: 'Good revision',
    homework: 'Repeat An-Naba 1-16',
    teacherNotes: 'Shy today',
    tajweedNotes: 'Work on the ghunnah',
    rating: 4,
    hifz: [
      {
        type: 'sabaq',
        from: { surah: 78, ayah: 1 },
        to: { surah: 78, ayah: 16 },
        grade: 'very_good',
        mistakes: 2,
        pages: 1.5,
      },
      {
        type: 'sabaqi',
        from: { surah: 114, ayah: 1 },
        to: { surah: 112, ayah: 4 },
        grade: 'excellent',
      },
      { type: 'manzil', from: { surah: 1, ayah: 1 }, to: { surah: 1, ayah: 7 } },
    ],
    ...o,
  };
}

const asTeacher = () => signInAs(ctx, teacher.user);
const asParent = () => signInAs(ctx, family.user);
const events = async (id = session.id) =>
  (
    await ctx.prisma.sessionEvent.findMany({ where: { sessionId: id }, orderBy: { id: 'asc' } })
  ).map((e) => e.type);

beforeEach(async () => {
  await resetState(ctx);
  at('2026-11-10T15:30:00Z');
  teacher = await m2Teacher(ctx);
  family = await makeFamily(ctx, { timezone: 'Europe/London' });
  student = await m2Student(ctx, 'Europe/London', family);
  enrollment = await m2Enrollment(ctx, student, teacher);
  session = await m2Session(ctx, enrollment, '2026-11-10T15:00:00Z', {
    stage: 'ended',
    activatedAt: '2026-11-10T15:00:00Z',
    endedAt: '2026-11-10T15:28:00Z',
  });
});

describe('lesson report (ReportsTest)', () => {
  it('submits the report, moves the class to taken and returns the class', async () => {
    const t = await asTeacher();
    const res = await t.put(`/sessions/${session.id}/report`, payload());
    expect(res.status).toBe(200);
    expect(res.body.data.stage).toBe('taken');
    expect(res.body.data.report.submitted).toBe(true);
    expect(await ctx.prisma.hifzEntry.count()).toBe(3);
    expect(await events()).toContain('report_submitted');
    const row = await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.markedAt?.toISOString()).toBe('2026-11-10T15:30:00.000Z');

    // A retried PUT (flaky connection) is idempotent and edits the report.
    const again = await t.put(`/sessions/${session.id}/report`, payload({ summary: 'Edited' }));
    expect(again.status).toBe(200);
    expect(await ctx.prisma.hifzEntry.count()).toBe(3);
    expect(
      (await ctx.prisma.lessonReport.findUniqueOrThrow({ where: { sessionId: session.id } }))
        .summary,
    ).toBe('Edited');
    expect(await events()).toContain('report_updated');

    const detail = await t.get(`/sessions/${session.id}`);
    expect(detail.body.data.lessonReport).toMatchObject({
      summary: 'Edited',
      rating: 4,
      teacherNotes: 'Shy today',
      tajweedNotes: 'Work on the ghunnah',
      dueAt: '2026-11-11T15:28:00Z',
      late: false,
      submittedAt: '2026-11-10T15:30:00Z',
      submittedBy: { id: teacher.user.id },
    });
    expect(detail.body.data.lessonReport.hifz[1].from.surah).toBe(114);
    expect(detail.body.data.lessonReport.hifz[0]).toMatchObject({ ayahs: 16, pages: 1.5 });
    expect(detail.body.data.lessonReport.hifz[1].ayahs).toBe(6 + 5 + 4);

    const shown = await t.get(`/sessions/${session.id}/report`);
    expect(shown.status).toBe(200);
    expect(shown.body.data.id).toBe(detail.body.data.lessonReport.id);
  });

  it('validates ayah bounds and order, cross-surah in any direction', async () => {
    const t = await asTeacher();
    const bad = payload({
      hifz: [
        { type: 'sabaq', from: { surah: 1, ayah: 1 }, to: { surah: 1, ayah: 8 } },
        { type: 'sabaqi', from: { surah: 78, ayah: 10 }, to: { surah: 78, ayah: 5 } },
        { type: 'manzil', from: { surah: 115, ayah: 1 }, to: { surah: 1, ayah: 1 } },
        { type: 'nope', from: { surah: 1, ayah: 1 }, to: { surah: 1, ayah: 1 } },
      ],
    });
    const res = await t.put(`/sessions/${session.id}/report`, bad);
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors).sort()).toEqual([
      'hifz.0.to.ayah',
      'hifz.1.to.ayah',
      'hifz.2.from.surah',
      'hifz.3.type',
    ]);
    expect(res.body.errors['hifz.0.to.ayah']).toEqual(['This surah has 7 ayahs.']);

    const blank = await t.put(`/sessions/${session.id}/report`, payload({ summary: '' }));
    expect(blank.status).toBe(422);
    expect(Object.keys(blank.body.errors)).toEqual(['summary']);
    const rating = await t.put(`/sessions/${session.id}/report`, payload({ rating: 6 }));
    expect(Object.keys(rating.body.errors)).toEqual(['rating']);
    const pages = await t.put(
      `/sessions/${session.id}/report`,
      payload({
        hifz: [
          { type: 'sabaq', from: { surah: 2, ayah: 1 }, to: { surah: 2, ayah: 5 }, pages: 0.3 },
        ],
      }),
    );
    expect(Object.keys(pages.body.errors)).toEqual(['hifz.0.pages']);
    // Nothing was written.
    expect(await ctx.prisma.lessonReport.count()).toBe(0);
  });

  it('lets the teacher edit for 48 hours, staff always, and nobody else', async () => {
    const t = await asTeacher();
    expect((await t.put(`/sessions/${session.id}/report`, payload())).status).toBe(200);

    at('2026-11-12T16:00:00Z');
    const late = await t.put(`/sessions/${session.id}/report`, payload());
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('outside_window');
    const { client: monitor } = await signedIn(ctx, 'monitor');
    const fixed = await monitor.put(
      `/sessions/${session.id}/report`,
      payload({ summary: 'fixed' }),
    );
    expect(fixed.status).toBe(200);
    // The staff edit is audited with the change.
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { subjectType: 'lesson_report', action: 'updated' },
    });
    expect(audit.after).toEqual({ summary: 'fixed' });

    const stranger = await signInAs(ctx, (await m2Teacher(ctx)).user);
    expect((await stranger.put(`/sessions/${session.id}/report`, payload())).status).toBe(404);
    const parent = await asParent();
    expect((await parent.put(`/sessions/${session.id}/report`, payload())).status).toBe(403);
  });

  it('refuses a report on a class that has not ended', async () => {
    const t = await asTeacher();
    const s = await m2Session(ctx, enrollment, '2026-11-11T15:00:00Z');
    const res = await t.put(`/sessions/${s.id}/report`, payload());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invalid_transition');
  });

  it('answers 409 stale_session with the fresh class when the screen showed another stage', async () => {
    const t = await asTeacher();
    const res = await t.put(`/sessions/${session.id}/report`, payload({ expectedStage: 'taken' }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stale_session');
    expect(res.body.data.stage).toBe('ended');
    expect(await ctx.prisma.lessonReport.count()).toBe(0);
  });

  it('shows progress with last positions, timeline and monthly ayahs, hiding internal notes from parents', async () => {
    const t = await asTeacher();
    await t.put(`/sessions/${session.id}/report`, payload());

    const res = await t.get(`/students/${student.id}/progress`);
    expect(res.status).toBe(200);
    expect(res.body.data.lastPositions).toHaveLength(3);
    expect(res.body.data.timeline[0].teacherNotes).toBe('Shy today');
    expect(res.body.data.monthlyAyahs[0]).toEqual({ month: '2026-11', ayahs: 16 });

    const parent = await asParent();
    const mine = await parent.get(`/students/${student.id}/progress`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.timeline[0]).not.toHaveProperty('teacherNotes');
    const detail = await parent.get(`/sessions/${session.id}`);
    expect(detail.body.data.lessonReport).not.toHaveProperty('teacherNotes');
    expect(detail.body.data.lessonReport).not.toHaveProperty('submittedBy');
    expect(detail.body.data.lessonReport).not.toHaveProperty('editableUntil');
    const report = await parent.get(`/sessions/${session.id}/report`);
    expect(report.body.data).not.toHaveProperty('teacherNotes');
    expect(report.body.data.summary).toBe('Good revision');

    const someoneElse = await m2Student(ctx);
    expect((await parent.get(`/students/${someoneElse.id}/progress`)).status).toBe(404);
    expect((await t.get(`/students/${someoneElse.id}/progress`)).status).toBe(404);
  });

  it('serves the surahs to any signed-in user, 401 without a session', async () => {
    const parent = await asParent();
    const res = await parent.get('/quran/surahs');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.body.data).toHaveLength(114);
    expect(res.body.data[0]).toEqual({
      number: 1,
      nameAr: 'الفاتحة',
      nameEn: 'Al-Fatihah',
      ayahCount: 7,
      juzStart: 1,
    });
    const anon = await request(ctx.app.getHttpServer()).get('/api/v1/quran/surahs');
    expect(anon.status).toBe(401);
  });

  it('offers submit_report on a taken class inside the edit window only (D70)', async () => {
    const t = await asTeacher();
    const before = await t.get(`/sessions/${session.id}`);
    expect(before.body.data.report.editableUntil).toBeNull();
    expect(before.body.data.allowedActions).toContain('submit_report');

    const sent = await t.put(`/sessions/${session.id}/report`, payload());
    expect(sent.body.data.report.editableUntil).toBe('2026-11-12T15:30:00Z');
    expect(sent.body.data.allowedActions).toContain('submit_report');

    // Lists carry the same flags (the teacher's My week reads them).
    const list = await t.get('/sessions?date=2026-11-10&tz=UTC');
    expect(list.body.data[0].report.editableUntil).toBe('2026-11-12T15:30:00Z');
    expect(list.body.data[0].allowedActions).toContain('submit_report');

    // Parents never get it.
    const parent = await asParent();
    expect((await parent.get(`/sessions/${session.id}`)).body.data.allowedActions).not.toContain(
      'submit_report',
    );

    at('2026-11-12T15:31:00Z');
    expect((await t.get(`/sessions/${session.id}`)).body.data.allowedActions).not.toContain(
      'submit_report',
    );
    const late = await t.put(`/sessions/${session.id}/report`, payload());
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('outside_window');
    expect(late.body.errors.availableUntil[0]).toBe('2026-11-12T15:30:00Z');

    const { client: monitor } = await signedIn(ctx, 'monitor');
    expect((await monitor.get(`/sessions/${session.id}`)).body.data.allowedActions).toContain(
      'submit_report',
    );
  });

  it('reads the edit window from the sessions.report_edit_hours setting', async () => {
    const { client: admin } = await signedIn(ctx, 'admin');
    expect(
      (await admin.put('/settings/sessions', { 'sessions.report_edit_hours': 2 })).status,
    ).toBe(200);
    expect(
      (await admin.put('/settings/sessions', { 'sessions.report_edit_hours': 9999 })).status,
    ).toBe(422);

    const t = await asTeacher();
    const sent = await t.put(`/sessions/${session.id}/report`, payload());
    expect(sent.body.data.report.editableUntil).toBe('2026-11-10T17:30:00Z');
    at('2026-11-10T18:00:00Z');
    expect((await t.put(`/sessions/${session.id}/report`, payload())).status).toBe(422);
  });

  it('puts the rating and submit time on the progress timeline (B30: parents see the rating)', async () => {
    const t = await asTeacher();
    await t.put(`/sessions/${session.id}/report`, payload());
    const parent = await asParent();
    const res = await parent.get(`/students/${student.id}/progress`);
    expect(res.body.data.timeline[0]).toMatchObject({
      rating: 4,
      submittedAt: '2026-11-10T15:30:00Z',
      hifz: [{ type: 'sabaq' }, { type: 'sabaqi' }, { type: 'manzil' }],
    });

    // The owner turns B30 off: the rating disappears for parents only.
    await ctx.app.get(SettingsService).set('reports.parent_sees_rating', false, null);
    const off = await parent.get(`/students/${student.id}/progress`);
    expect(off.body.data.timeline[0]).not.toHaveProperty('rating');
    expect((await parent.get(`/sessions/${session.id}/report`)).body.data).not.toHaveProperty(
      'rating',
    );
    expect((await t.get(`/students/${student.id}/progress`)).body.data.timeline[0].rating).toBe(4);
  });

  it('clears the board "ended, report missing" count once the report is filed', async () => {
    const { client: monitor } = await signedIn(ctx, 'monitor');
    const before = await monitor.get('/sessions/board?date=2026-11-10&tz=UTC');
    expect(before.body.data.counters.ended).toBe(1);
    expect(before.body.data.counters.taken).toBe(0);

    const t = await asTeacher();
    await t.put(`/sessions/${session.id}/report`, payload());
    const after = await monitor.get('/sessions/board?date=2026-11-10&tz=UTC');
    expect(after.body.data.counters.ended).toBe(0);
    expect(after.body.data.counters.taken).toBe(1);
    const row = after.body.data.sessions.find((s: { id: number }) => s.id === session.id);
    expect(row.attention).not.toContain('report_missing');
  });

  it('flags report_missing after report_due_hours and marks a late report', async () => {
    at('2026-11-11T15:28:00Z'); // ended 15:28 + 24 h
    const { client: monitor } = await signedIn(ctx, 'monitor');
    expect((await monitor.get(`/sessions/${session.id}`)).body.data.attention).not.toContain(
      'report_missing',
    );
    at('2026-11-11T15:28:01Z');
    expect((await monitor.get(`/sessions/${session.id}`)).body.data.attention).toContain(
      'report_missing',
    );
    // A taken class without a report (legacy / seeded) is flagged too.
    const legacy = await m2Session(ctx, enrollment, '2026-11-09T15:00:00Z', { stage: 'taken' });
    expect((await monitor.get(`/sessions/${legacy.id}`)).body.data.attention).toContain(
      'report_missing',
    );

    const t = await asTeacher();
    const sent = await t.put(`/sessions/${session.id}/report`, payload());
    expect(sent.body.data.attention).not.toContain('report_missing');
    expect((await t.get(`/sessions/${session.id}/report`)).body.data.late).toBe(true);
  });

  it('keeps the report when staff revert a taken class, and the teacher can send it again', async () => {
    const t = await asTeacher();
    await t.put(`/sessions/${session.id}/report`, payload());
    const { client: monitor } = await signedIn(ctx, 'monitor');
    const reverted = await monitor.post(`/sessions/${session.id}/transitions`, {
      action: 'revert',
      expectedStage: 'taken',
      reason: 'Wrong class',
    });
    expect(reverted.status).toBe(200);
    expect(reverted.body.data.stage).toBe('scheduled');
    expect(reverted.body.data.report.submitted).toBe(true);
    expect(await ctx.prisma.lessonReport.count()).toBe(1);
  });

  it('lets the marker undo the report within 2 minutes (taken → ended) and re-send it', async () => {
    const t = await asTeacher();
    await t.put(`/sessions/${session.id}/report`, payload());
    const undo = await t.post(`/sessions/${session.id}/transitions`, {
      action: 'undo_mark',
      expectedStage: 'taken',
    });
    expect(undo.status).toBe(200);
    expect(undo.body.data.stage).toBe('ended');
    const again = await t.put(`/sessions/${session.id}/report`, payload({ summary: 'Again' }));
    expect(again.body.data.stage).toBe('taken');
    expect(await ctx.prisma.lessonReport.count()).toBe(1);
    expect(await events()).toEqual(['report_submitted', 'reverted', 'report_submitted']);
  });

  it('keeps the hifz rows when hifz is left out and clears them with []', async () => {
    const t = await asTeacher();
    await t.put(`/sessions/${session.id}/report`, payload());
    const rest: Record<string, unknown> = payload();
    delete rest.hifz;
    await t.put(`/sessions/${session.id}/report`, rest);
    expect(await ctx.prisma.hifzEntry.count()).toBe(3);
    await t.put(`/sessions/${session.id}/report`, { ...rest, hifz: [] });
    expect(await ctx.prisma.hifzEntry.count()).toBe(0);
  });
});

describe('report permissions and scope', () => {
  it('answers 401 without a session and 403 without the permission', async () => {
    const anon = await request(ctx.app.getHttpServer()).get(
      `/api/v1/sessions/${session.id}/report`,
    );
    expect(anon.status).toBe(401);
    const { client: billing } = await signedIn(ctx, 'billing');
    expect((await billing.get(`/sessions/${session.id}/report`)).status).toBe(403);
    expect((await billing.put(`/sessions/${session.id}/report`, payload())).status).toBe(403);
    expect((await billing.get('/lesson-reports')).status).toBe(403);
    // CSR may read classes but not write a report.
    const { client: csr } = await signedIn(ctx, 'csr');
    expect((await csr.get(`/sessions/${session.id}/report`)).status).toBe(200);
    expect((await csr.put(`/sessions/${session.id}/report`, payload())).status).toBe(403);
  });

  it('hides another teacher’s class and report (D138)', async () => {
    const t = await asTeacher();
    await t.put(`/sessions/${session.id}/report`, payload());
    const stranger = await signInAs(ctx, (await m2Teacher(ctx)).user);
    expect((await stranger.get(`/sessions/${session.id}/report`)).status).toBe(404);
    const strangerFamily = await signInAs(ctx, (await makeFamily(ctx)).user);
    expect((await strangerFamily.get(`/sessions/${session.id}/report`)).status).toBe(404);
  });

  it('answers data null for a class without a report', async () => {
    const t = await asTeacher();
    const res = await t.get(`/sessions/${session.id}/report`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });
});

describe('staff report list (GET /lesson-reports)', () => {
  it('lists classes by report state with counts; the teacher sees own classes; parents 403', async () => {
    // pending (this class), missing (an older ended one), on time, late.
    const missing = await m2Session(ctx, enrollment, '2026-11-08T15:00:00Z', {
      stage: 'ended',
      endedAt: '2026-11-08T15:30:00Z',
    });
    const onTime = await m2Session(ctx, enrollment, '2026-11-10T13:00:00Z', {
      stage: 'ended',
      endedAt: '2026-11-10T13:30:00Z',
    });
    const late = await m2Session(ctx, enrollment, '2026-11-07T15:00:00Z', {
      stage: 'ended',
      endedAt: '2026-11-07T15:30:00Z',
    });
    const t = await asTeacher();
    expect((await t.put(`/sessions/${onTime.id}/report`, payload())).status).toBe(200);
    expect((await t.put(`/sessions/${late.id}/report`, payload())).status).toBe(200);
    // Another teacher's ended class: staff only.
    await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), await m2Teacher(ctx)),
      '2026-11-09T10:00:00Z',
      { stage: 'ended' },
    );

    const { client: monitor } = await signedIn(ctx, 'monitor');
    const all = await monitor.get('/lesson-reports');
    expect(all.status).toBe(200);
    expect(all.body.meta.counts).toEqual({ all: 5, pending: 1, missing: 2, on_time: 1, late: 1 });
    const byId = Object.fromEntries(
      all.body.data.map((r: { session: { id: number }; state: string }) => [r.session.id, r.state]),
    );
    expect(byId).toMatchObject({
      [session.id]: 'pending',
      [missing.id]: 'missing',
      [onTime.id]: 'on_time',
      [late.id]: 'late',
    });
    const onlyMissing = await monitor.get('/lesson-reports?state=missing');
    expect(onlyMissing.body.data).toHaveLength(2);
    expect(onlyMissing.body.data.every((r: { report: unknown }) => r.report === null)).toBe(true);
    const lateRow = (await monitor.get('/lesson-reports?state=late')).body.data[0];
    expect(lateRow.report).toMatchObject({ late: true, rating: 4 });
    expect(lateRow.dueAt).toBe('2026-11-08T15:30:00Z');

    const own = await t.get('/lesson-reports');
    expect(own.body.meta.counts.all).toBe(4);
    expect((await t.get(`/lesson-reports?teacherId=${teacher.id + 1}`)).body.data).toHaveLength(0);

    const parent = await asParent();
    expect((await parent.get('/lesson-reports')).status).toBe(403);
    const bad = await monitor.get('/lesson-reports?state=nope');
    expect(bad.status).toBe(422);
  });
});
