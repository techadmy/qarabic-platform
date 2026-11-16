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
  makeFamily,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';

/*
| D151: the teacher's personal Zoom link lives on their profile (encrypted), its meeting id is the
| teacher's PMI (Z1), and their classes read it when shown or joined, so a new link or a new teacher
| on a class applies with no change to the class rows.
*/

const LINK_A = 'https://us02web.zoom.us/j/81234567890?pwd=SecretA1';
const LINK_A2 = 'https://zoom.us/j/81234567891?pwd=SecretA2';
const LINK_B = 'https://us05web.zoom.us/j/9876543210?pwd=SecretB1';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let admin: Client;
let a: Awaited<ReturnType<typeof m2Teacher>>;
let b: Awaited<ReturnType<typeof m2Teacher>>;

beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-10T08:00:00Z');
  admin = (await signedIn(ctx, 'admin')).client;
  a = await m2Teacher(ctx, 'Africa/Cairo', 'Amina');
  b = await m2Teacher(ctx, 'Africa/Cairo', 'Bilal');
});

const setLink = (id: number, zoomJoinUrl: string | null) =>
  admin.patch(`/teachers/${id}`, { zoomJoinUrl });

describe('the teacher profile link', () => {
  it('is saved encrypted, its meeting id becomes the teacher PMI, and clears', async () => {
    const res = await setLink(a.id, LINK_A);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ zoomJoinUrl: LINK_A, hasZoomLink: true });

    const row = await ctx.prisma.teacher.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.zoomJoinUrl).toMatch(/^v1:/);
    expect(row.zoomJoinUrl).not.toContain('81234567890');
    expect(row.zoomMeetingId).toBe('81234567890');
    const host = await ctx.prisma.zoomHost.findFirstOrThrow({ where: { teacherId: a.id } });
    expect(host.pmiMeetingId).toBe('81234567890');
    // The passcode never reaches the audit log.
    const audit = await ctx.prisma.$queryRawUnsafe<unknown[]>('SELECT * FROM "audit_logs"');
    expect(JSON.stringify(audit)).not.toContain('SecretA1');

    // A new link moves the same host's PMI.
    await setLink(a.id, LINK_A2);
    expect(await ctx.prisma.zoomHost.count({ where: { teacherId: a.id } })).toBe(1);
    expect(
      (await ctx.prisma.zoomHost.findFirstOrThrow({ where: { teacherId: a.id } })).pmiMeetingId,
    ).toBe('81234567891');

    const cleared = await setLink(a.id, '');
    expect(cleared.body.data).toMatchObject({ zoomJoinUrl: null, hasZoomLink: false });
    expect(
      (await ctx.prisma.zoomHost.findFirstOrThrow({ where: { teacherId: a.id } })).pmiMeetingId,
    ).toBeNull();
  });

  it('is set on create too', async () => {
    const res = await admin.post('/teachers', {
      firstName: 'Huda',
      email: 'huda.d151@example.test',
      phone: '+201000000151',
      timezone: 'Africa/Cairo',
      zoomJoinUrl: LINK_B,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ zoomJoinUrl: LINK_B, hasZoomLink: true });
  });

  it('refuses links that are not Zoom meeting links (422)', async () => {
    for (const bad of [
      'http://zoom.us/j/123456789',
      'https://zoom.us.evil.example/j/123456789',
      'https://zoom.us/my/amina',
    ]) {
      const res = await setLink(a.id, bad);
      expect(res.status, bad).toBe(422);
      expect(res.body.errors.zoomJoinUrl).toBeDefined();
    }
  });

  it('answers 409 zoom_link_taken for another teacher’s or host’s meeting', async () => {
    await setLink(a.id, LINK_A);
    const same = await setLink(b.id, 'https://zoom.us/j/81234567890');
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('zoom_link_taken');

    await ctx.prisma.zoomHost.create({
      data: { zoomUserId: 'pool-1', email: 'pool@example.test', pmiMeetingId: '9876543210' },
    });
    const pool = await setLink(b.id, LINK_B);
    expect(pool.status).toBe(409);
    expect(pool.body.code).toBe('zoom_link_taken');

    // …and a Zoom host cannot take a teacher's meeting id either.
    const host = await admin.post('/zoom-hosts', {
      zoomUserId: 'pool-2',
      email: 'pool2@example.test',
      pmiMeetingId: '81234567890',
    });
    expect(host.status).toBe(409);
    expect(host.body.code).toBe('zoom_link_taken');
  });

  it('shows the link to editors only; 401 / 403 for the rest', async () => {
    await setLink(a.id, LINK_A);
    const { client: monitor } = await signedIn(ctx, 'monitor'); // staff.view, not staff.manage
    const seen = await monitor.get(`/teachers/${a.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.hasZoomLink).toBe(true);
    expect(seen.body.data).not.toHaveProperty('zoomJoinUrl');
    expect(JSON.stringify((await monitor.get('/teachers')).body)).not.toContain('SecretA1');

    expect((await monitor.patch(`/teachers/${a.id}`, { zoomJoinUrl: LINK_B })).status).toBe(403);
    const teacher = await signInAs(ctx, a.user);
    expect((await teacher.patch(`/teachers/${a.id}`, { zoomJoinUrl: LINK_B })).status).toBe(403);
    const { client: parent } = await signedIn(ctx, 'parent');
    expect((await parent.patch(`/teachers/${a.id}`, { zoomJoinUrl: LINK_B })).status).toBe(403);
    // No session: 401 (a write without one is refused earlier, by the CSRF check).
    expect((await request(ctx.app.getHttpServer()).get(`/api/v1/teachers/${a.id}`)).status).toBe(
      401,
    );
  });
});

describe('GET /teacher-portal/zoom-link', () => {
  it('gives the teacher their own link, read-only; staff 403; no session 401', async () => {
    await setLink(a.id, LINK_A);
    const teacher = await signInAs(ctx, a.user);
    const res = await teacher.get('/teacher-portal/zoom-link');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(res.body.data).toEqual({ url: LINK_A, meetingId: '81234567890' });
    const other = await signInAs(ctx, b.user);
    expect((await other.get('/teacher-portal/zoom-link')).body.data).toEqual({
      url: null,
      meetingId: null,
    });
    expect((await admin.get('/teacher-portal/zoom-link')).status).toBe(403);
    expect(
      (await request(ctx.app.getHttpServer()).get('/api/v1/teacher-portal/zoom-link')).status,
    ).toBe(401);
  });
});

describe('class links follow the teacher', () => {
  // A class at 15:00 UTC; the join window opens 60 minutes before.
  const START = '2026-11-10T15:00:00Z';

  async function teacherModeClass() {
    const student = await m2Student(ctx);
    const family = await ctx.prisma.family.findUniqueOrThrow({
      where: { id: student.familyId },
      include: { user: true },
    });
    const e = await m2Enrollment(ctx, student, a, { meetingMode: 'teacher' });
    const session = await m2Session(ctx, e, START);
    return { session, parent: await signInAs(ctx, family.user), enrollment: e, student };
  }

  it('resolves the teacher’s link at join time, and a new link or teacher applies at once', async () => {
    const { session, parent } = await teacherModeClass();
    // No link yet: the class warns, and nothing can be joined.
    const before = await admin.get(`/sessions/${session.id}`);
    expect(before.body.data.zoom).toMatchObject({ link: 'missing', joinAvailable: false });

    await setLink(a.id, LINK_A);
    // Outside the window the parent gets nothing (and never a URL in a payload).
    const early = await parent.get(`/sessions/${session.id}/zoom/join`);
    expect(early.status).toBe(422);
    const shown = await parent.get(`/sessions/${session.id}`);
    expect(shown.body.data.zoom).toMatchObject({ link: 'teacher', joinAvailable: false });
    expect(JSON.stringify(shown.body)).not.toContain('zoom.us');

    clock(ctx).set('2026-11-10T14:00:00Z');
    expect((await parent.get(`/sessions/${session.id}`)).body.data.zoom.joinAvailable).toBe(true);
    const join = await parent.get(`/sessions/${session.id}/zoom/join`);
    expect(join.status).toBe(200);
    expect(join.body.data.joinUrl).toBe(LINK_A);
    // The class row itself holds no link.
    expect(
      (await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: session.id } })).zoomJoinUrl,
    ).toBeNull();

    // The teacher changes their link: the same class uses the new one.
    await setLink(a.id, LINK_A2);
    expect((await parent.get(`/sessions/${session.id}/zoom/join`)).body.data.joinUrl).toBe(LINK_A2);

    // A substitute takes the class: their link, with nothing copied.
    await setLink(b.id, LINK_B);
    await ctx.prisma.classSession.update({ where: { id: session.id }, data: { teacherId: b.id } });
    expect((await parent.get(`/sessions/${session.id}/zoom/join`)).body.data.joinUrl).toBe(LINK_B);

    // The own teacher's start link is their Zoom link too.
    clock(ctx).set('2026-11-10T14:50:00Z');
    const teacher = await signInAs(ctx, b.user);
    const start = await teacher.get(`/sessions/${session.id}/zoom/start`);
    expect(start.status).toBe(200);
    expect(start.body.data.startUrl).toBe(LINK_B);
  });

  it('keeps the enrollment’s fixed link as an override', async () => {
    await setLink(a.id, LINK_A);
    const student = await m2Student(ctx);
    const fixed = 'https://meet.example.test/fixed-room';
    const e = await m2Enrollment(ctx, student, a, {
      meetingMode: 'external',
      externalMeetingUrl: fixed,
    });
    const session = await m2Session(ctx, e, START, {
      zoomStatus: 'external',
      zoomJoinUrl: fixed,
    });
    clock(ctx).set('2026-11-10T14:30:00Z');
    expect((await admin.get(`/sessions/${session.id}`)).body.data.zoom.link).toBe('external');
    expect((await admin.get(`/sessions/${session.id}/zoom/join`)).body.data.joinUrl).toBe(fixed);
  });

  it('a teacher without a link: no link on the class (503), flagged for the board', async () => {
    const { session, parent } = await teacherModeClass();
    clock(ctx).set('2026-11-10T14:30:00Z');
    const join = await parent.get(`/sessions/${session.id}/zoom/join`);
    expect(join.status).toBe(503);
    expect(join.body.code).toBe('zoom_unavailable');
    const board = await admin.get('/sessions/board?date=2026-11-10');
    const row = JSON.stringify(board.body).includes('"missing"');
    expect(row).toBe(true);
    // Another family never gets the class, nor its link.
    const stranger = await signInAs(ctx, (await makeFamily(ctx)).user);
    expect((await stranger.get(`/sessions/${session.id}/zoom/join`)).status).toBe(404);
  });

  it('new enrollments default to the teacher’s link', async () => {
    await setLink(a.id, LINK_A);
    const student = await m2Student(ctx);
    const res = await admin.post('/enrollments', {
      studentId: student.id,
      courseId: student.regularCourseId,
      teacherId: a.id,
      kind: 'regular',
      startsOn: '2026-11-11',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.meetingMode).toBe('teacher');
  });
});
