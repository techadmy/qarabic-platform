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
  type Client,
  type TestContext,
} from './helpers.js';
import { fbTicket } from './n4-helpers.js';

/*
 * Port of Laravel tests/Feature/M4/ParentPortalTest.php (D138): a parent sees and acts on their
 * own children only, server-side; every cross-family attempt answers 404 (never confirms the other
 * child exists). Plus the new `GET /parent/home` with its recent lesson reports (N3). The phone
 * case is covered by me.e2e-spec.
 */

/** A submitted lesson report on a class (as the N3 report service stores it). */
async function report(
  sessionId: number,
  studentId: number,
  o: { summary?: string; teacherNotes?: string; rating?: number } = {},
) {
  return ctx.prisma.lessonReport.create({
    data: {
      sessionId,
      studentId,
      teacherId: teacher.id,
      summary: o.summary ?? 'Read Al-Fatiha well',
      homework: 'Revise',
      teacherNotes: o.teacherNotes ?? 'INTERNAL: talk to the monitor',
      rating: o.rating ?? 4,
      dueAt: new Date('2026-11-11T16:00:00Z'),
      submittedAt: new Date('2026-11-10T09:00:00Z'),
      hifz: {
        create: [
          {
            studentId,
            sessionId,
            type: 'sabaq',
            fromSurah: 1,
            fromAyah: 1,
            toSurah: 1,
            toAyah: 7,
            ayahs: 7,
            lessonAt: new Date('2026-11-09T16:00:00Z'),
          },
        ],
      },
    },
  });
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let teacher: Awaited<ReturnType<typeof m2Teacher>>;
let family: Awaited<ReturnType<typeof makeFamily>>;
let child: Awaited<ReturnType<typeof m2Student>>;
let mine: Awaited<ReturnType<typeof m2Session>>;
let otherFamily: Awaited<ReturnType<typeof makeFamily>>;
let otherChild: Awaited<ReturnType<typeof m2Student>>;
let theirs: Awaited<ReturnType<typeof m2Session>>;
let parent: Client;

beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-10T10:00:00Z');
  teacher = await m2Teacher(ctx, 'Africa/Cairo');
  family = await makeFamily(ctx, { timezone: 'Europe/London' });
  child = await m2Student(ctx, 'Europe/London', family, 'Maryam');
  mine = await m2Session(ctx, await m2Enrollment(ctx, child, teacher), '2026-11-10T16:00:00Z');
  otherFamily = await makeFamily(ctx, { timezone: 'America/Toronto' });
  otherChild = await m2Student(ctx, 'America/Toronto', otherFamily, 'Other');
  theirs = await m2Session(
    ctx,
    await m2Enrollment(ctx, otherChild, teacher),
    '2026-11-10T17:00:00Z',
  );
  parent = await signInAs(ctx, family.user);
});

describe('parent portal scope (ParentPortalTest)', () => {
  it("lists only the parent's own children's classes, with both zones", async () => {
    const res = await parent.get('/sessions?from=2026-11-10T00:00:00Z&to=2026-11-11T00:00:00Z');
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { id: number }) => s.id)).toEqual([mine.id]);
    expect(res.body.data[0].student.timezone).toBe('Europe/London');
    expect(res.body.data[0].teacher.timezone).toBe('Africa/Cairo');
    expect(res.body.data[0].teacher.phone ?? null).toBeNull();
    // Asking for the other child by id returns nothing, not their classes.
    expect((await parent.get(`/sessions?studentId=${otherChild.id}`)).body.data).toEqual([]);
  });

  it("returns 404 for another family's class, meeting link, progress, student and family records", async () => {
    expect((await parent.get(`/sessions/${theirs.id}`)).status).toBe(404);
    expect((await parent.get(`/students/${otherChild.id}/progress`)).status).toBe(404);
    expect((await parent.get(`/students/${child.id}/progress`)).status).toBe(200);
    expect((await parent.get(`/sessions/${theirs.id}/zoom/join`)).status).toBe(404);
    expect((await parent.get(`/students/${otherChild.id}`)).status).toBe(404);
    expect((await parent.get(`/families/${otherFamily.id}`)).status).toBe(404);

    expect((await parent.get(`/sessions/${mine.id}`)).status).toBe(200);
    const own = await parent.get(`/students/${child.id}`);
    expect(own.status).toBe(200);
    expect(own.body.data.name).toBe('Maryam');
    expect((await parent.get(`/families/${family.id}`)).status).toBe(200);
    expect((await parent.get('/students')).body.data.map((s: { id: number }) => s.id)).toEqual([
      child.id,
    ]);
  });

  it('keeps the family and student records scoped for teachers too', async () => {
    const stranger = await m2Student(ctx, 'Europe/Paris');
    const asTeacher = await signInAs(ctx, teacher.user);
    expect((await asTeacher.get(`/students/${child.id}`)).status).toBe(200);
    expect((await asTeacher.get(`/students/${stranger.id}`)).status).toBe(404);
    // Family records (parent contact, billing) are staff-only (D137).
    expect((await asTeacher.get(`/families/${family.id}`)).status).toBe(403);
    const csr = await signedIn(ctx, 'csr');
    expect((await csr.client.get(`/students/${stranger.id}`)).status).toBe(200);
    expect((await csr.client.get(`/families/${stranger.familyId}`)).status).toBe(200);
  });

  it('lets the parent request a leave for their own child only', async () => {
    const other = await parent.post('/session-requests', {
      type: 'leave',
      sessionId: theirs.id,
      reason: 'Travel',
    });
    expect(other.status).toBe(404);
    const advance = await parent.post('/session-requests', {
      type: 'advance',
      sessionId: mine.id,
      reason: 'Earlier please',
      proposedStartsAt: '2026-11-10T14:00:00Z',
    });
    expect(advance.status).toBe(403);
    const leave = await parent.post('/session-requests', {
      type: 'leave',
      sessionId: mine.id,
      reason: 'Travel',
    });
    expect(leave.status).toBe(201);
    expect(leave.body.data).toMatchObject({
      status: 'auto_approved',
      requestedBy: { role: 'parent' },
    });
    expect(
      (await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: mine.id } })).stage,
    ).toBe('leave');
  });

  it("lists the parent's own requests and only lets them withdraw their own", async () => {
    clock(ctx).set('2026-11-10T15:00:00Z'); // inside the notice window: stays pending
    const own = await parent.post('/session-requests', {
      type: 'leave',
      sessionId: mine.id,
      reason: 'Sick',
    });
    expect(own.body.data.status).toBe('pending');
    const ownId = own.body.data.id as number;
    const other = await signInAs(ctx, otherFamily.user);
    const theirsId = (
      await other.post('/session-requests', { type: 'leave', sessionId: theirs.id, reason: 'Trip' })
    ).body.data.id as number;
    expect((await other.post(`/session-requests/${ownId}/cancel`)).status).toBe(404);

    const list = await parent.get('/session-requests');
    expect(list.body.data.map((r: { id: number }) => r.id)).toEqual([ownId]);
    expect((await parent.get(`/session-requests/${theirsId}`)).status).toBe(404);
    expect((await parent.post(`/session-requests/${theirsId}/cancel`)).status).toBe(404);
    expect((await parent.post(`/session-requests/${ownId}/approve`)).status).toBe(403);
    const cancelled = await parent.post(`/session-requests/${ownId}/cancel`);
    expect(cancelled.body.data.status).toBe('cancelled');
  });

  it('cannot run, mark or report a class', async () => {
    expect(
      (await parent.post(`/sessions/${mine.id}/transitions`, { action: 'activate' })).status,
    ).toBe(403);
    expect((await parent.put(`/sessions/${mine.id}/report`, { summary: 'x' })).status).toBe(403);
    expect(
      (await parent.patch(`/sessions/${mine.id}`, { startsAt: '2026-11-10T18:00:00Z' })).status,
    ).toBe(403);
  });

  it("shows the lesson report read-only, without the teacher's internal notes", async () => {
    await ctx.prisma.classSession.update({
      where: { id: mine.id },
      data: {
        startsAt: new Date('2026-11-09T16:00:00Z'),
        endsAt: new Date('2026-11-09T17:00:00Z'),
        stage: 'taken',
      },
    });
    await report(mine.id, child.id);
    const progress = JSON.stringify((await parent.get(`/students/${child.id}/progress`)).body);
    expect(progress).toContain('Read Al-Fatiha well');
    expect(progress).not.toContain('INTERNAL');
    const detail = await parent.get(`/sessions/${mine.id}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain('INTERNAL');
    expect(JSON.stringify((await parent.get('/parent/home')).body)).not.toContain('INTERNAL');
  });
});

describe('GET /parent/home', () => {
  it('answers the parent’s own family, children, upcoming classes and counters', async () => {
    const tomorrow = await m2Session(
      ctx,
      await ctx.prisma.enrollment.findFirstOrThrow({ where: { studentId: child.id } }),
      '2026-11-11T16:00:00Z',
    );
    await m2Session(
      ctx,
      await ctx.prisma.enrollment.findFirstOrThrow({ where: { studentId: child.id } }),
      '2026-11-09T16:00:00Z',
      { stage: 'taken' },
    );
    await m2Session(
      ctx,
      await ctx.prisma.enrollment.findFirstOrThrow({ where: { studentId: child.id } }),
      '2026-11-30T16:00:00Z',
    );
    clock(ctx).set('2026-11-10T15:00:00Z');
    await parent.post('/session-requests', { type: 'leave', sessionId: mine.id, reason: 'Sick' });
    const t = await fbTicket(ctx, family.user, { lastPublicAt: new Date('2026-11-10T15:30:00Z') });
    expect(t.reporterId).toBe(family.user.id);

    const res = await parent.get('/parent/home');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.family).toEqual({
      id: family.id,
      name: family.user.name,
      timezone: 'Europe/London',
      status: 'regular',
    });
    expect(data.children).toEqual([
      expect.objectContaining({
        id: child.id,
        name: 'Maryam',
        nextClass: expect.objectContaining({ id: mine.id, startsAt: '2026-11-10T16:00:00Z' }),
      }),
    ]);
    // Next 7 days, live classes only, own children only, soonest first.
    expect(data.upcomingClasses.map((s: { id: number }) => s.id)).toEqual([mine.id, tomorrow.id]);
    expect(JSON.stringify(data)).not.toContain('Other');
    expect(data.requests).toEqual({ pendingClassRequests: 1, openTickets: 1, ticketUpdates: 1 });
    expect(data.recentReports).toEqual([]);
  });

  it('lists the latest lesson reports of each child, parent-safe, newest first', async () => {
    const enrollment = await ctx.prisma.enrollment.findFirstOrThrow({
      where: { studentId: child.id },
    });
    const past = [];
    for (const day of ['05', '06', '07', '08']) {
      past.push(await m2Session(ctx, enrollment, `2026-11-${day}T16:00:00Z`, { stage: 'taken' }));
    }
    for (const [i, s] of past.entries()) await report(s.id, child.id, { summary: `Lesson ${i}` });
    const sibling = await m2Student(ctx, 'Europe/London', family, 'Yusuf');
    const siblingClass = await m2Session(
      ctx,
      await m2Enrollment(ctx, sibling, teacher),
      '2026-11-07T18:00:00Z',
      { stage: 'taken' },
    );
    await report(siblingClass.id, sibling.id, { summary: 'Yusuf lesson' });
    const strangerClass = await m2Session(
      ctx,
      await ctx.prisma.enrollment.findFirstOrThrow({ where: { studentId: otherChild.id } }),
      '2026-11-08T17:00:00Z',
      { stage: 'taken' },
    );
    await report(strangerClass.id, otherChild.id, { summary: 'Other lesson' });

    const res = await parent.get('/parent/home');
    const reports = res.body.data.recentReports as Array<Record<string, unknown>>;
    // Three per child at most, newest class first; never another family's.
    expect(reports.map((r) => r.summary)).toEqual([
      'Lesson 3',
      'Yusuf lesson',
      'Lesson 2',
      'Lesson 1',
    ]);
    expect(reports[0]).toMatchObject({
      sessionId: past[3]!.id,
      student: { id: child.id, name: 'Maryam' },
      startsAt: '2026-11-08T16:00:00Z',
      teacher: { id: teacher.id },
      homework: 'Revise',
      rating: 4,
      hifz: [{ type: 'sabaq', from: { surah: 1, ayah: 1 }, to: { surah: 1, ayah: 7 } }],
    });
    for (const r of reports) {
      expect(r).not.toHaveProperty('teacherNotes');
      expect(r).not.toHaveProperty('late');
    }

    // B30 off: the parent no longer sees the rating.
    await ctx.app.get(SettingsService).set('reports.parent_sees_rating', false, null);
    const off = await parent.get('/parent/home');
    expect(off.body.data.recentReports[0]).not.toHaveProperty('rating');
  });

  it('is for parents only', async () => {
    const asTeacher = await signInAs(ctx, teacher.user);
    expect((await asTeacher.get('/parent/home')).status).toBe(403);
    const csr = await signedIn(ctx, 'csr'); // holds families.view, but is not a parent
    expect((await csr.client.get('/parent/home')).status).toBe(403);
  });
});
