import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Crypto } from '../src/common/crypto.js';
import { SessionGenerator } from '../src/sessions/generator.js';
import { SessionJobs } from '../src/sessions/jobs.js';
import { Actor, SessionStateMachine } from '../src/sessions/state-machine.js';
import type { FakeZoomClient } from '../src/sessions/zoom.js';
import { SettingsService } from '../src/settings/settings.service.js';
import {
  clock,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  makeCourse,
  makeFamily,
  resetState,
  signedIn,
  signInAs,
  type Client,
  type TestContext,
  zoomDriver,
} from './helpers.js';

/*
| Ports of Laravel tests/Feature/M2/MeetingLinksTest.php, ZoomTest.php (the meeting parts; webhooks
| wait for a real Zoom account, B7) and SettingsOpsTest.php (class rules, Zoom host pool, health).
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

describe('meeting links (MeetingLinksTest)', () => {
  let teacher: Awaited<ReturnType<typeof m2Teacher>>;
  let student: Awaited<ReturnType<typeof m2Student>>;
  let admin: Client;

  beforeEach(async () => {
    clock(ctx).set('2026-11-10T08:00:00Z'); // Tuesday
    teacher = await m2Teacher(ctx, 'Africa/Cairo');
    student = await m2Student(ctx, 'Africa/Cairo');
    admin = (await signedIn(ctx, 'admin')).client;
  });

  const payload = (o: Record<string, unknown> = {}) => ({
    studentId: student.id,
    courseId: student.regularCourseId,
    teacherId: teacher.id,
    kind: 'regular',
    startsOn: '2026-11-10',
    meetingMode: 'external',
    externalMeetingUrl: 'https://meet.google.com/abc-defg-hij',
    slots: [
      { weekday: 2, localStartTime: '15:30' },
      { weekday: 4, localStartTime: '15:30' },
    ],
    ...o,
  });

  it('refuses a Zoom enrollment with a clear 422 when Zoom is not configured', async () => {
    zoomDriver(ctx, 'none');
    expect(
      (await admin.post('/enrollments', payload({ meetingMode: 'zoom', externalMeetingUrl: null })))
        .body.errors,
    ).toHaveProperty('meetingMode');
    const id = (await admin.post('/enrollments', payload())).body.data.id as number;
    const toZoom = await admin.patch(`/enrollments/${id}`, { meetingMode: 'zoom' });
    expect(toZoom.status).toBe(422);
    expect(toZoom.body.errors).toHaveProperty('meetingMode');
  });

  it('moves classes already generated to the new link when the enrollment switches from Zoom', async () => {
    zoomDriver(ctx, 'fake');
    const created = await admin.post(
      '/enrollments',
      payload({ meetingMode: 'zoom', externalMeetingUrl: null }),
    );
    expect(created.status).toBe(201);
    const id = created.body.data.id as number;
    await ctx.app.get(SessionGenerator).run({ from: '2026-11-10', to: '2026-11-20' });
    const sessions = await ctx.prisma.classSession.findMany({
      where: { enrollmentId: id },
      orderBy: { startsAt: 'asc' },
    });
    expect(sessions.length).toBeGreaterThanOrEqual(4);
    expect([...new Set(sessions.map((s) => s.zoomStatus))]).toEqual(['none']);
    // Last week's class already taken: history is not rewritten.
    const e = await ctx.prisma.enrollment.findUniqueOrThrow({ where: { id } });
    const past = await m2Session(ctx, e, '2026-11-03T13:30:00Z', { stage: 'taken' });

    zoomDriver(ctx, 'none');
    const res = await admin.patch(`/enrollments/${id}`, {
      meetingMode: 'external',
      externalMeetingUrl: 'https://meet.google.com/abc-defg-hij',
    });
    expect(res.status).toBe(200);
    for (const s of await ctx.prisma.classSession.findMany({
      where: { id: { in: sessions.map((x) => x.id) } },
    })) {
      expect([s.zoomStatus, ctx.app.get(Crypto).tryDecrypt(s.zoomJoinUrl)]).toEqual([
        'external',
        'https://meet.google.com/abc-defg-hij',
      ]);
    }
    expect(
      (await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: past.id } })).zoomStatus,
    ).toBe('none');
    expect(
      await ctx.prisma.sessionEvent.count({
        where: { sessionId: sessions[0]!.id, type: 'zoom_updated' },
      }),
    ).toBe(1);

    // Today's 15:30 Cairo class (13:30Z): the family joins with the new link, the teacher starts it.
    clock(ctx).set('2026-11-10T13:20:00Z');
    const fam = await ctx.prisma.family.findUniqueOrThrow({
      where: { id: student.familyId },
      include: { user: true },
    });
    const asParent = await signInAs(ctx, fam.user);
    const join = await asParent.get(`/sessions/${sessions[0]!.id}/zoom/join`);
    expect(join.status).toBe(200);
    expect(join.body.data.joinUrl).toBe('https://meet.google.com/abc-defg-hij');
    const asTeacher = await signInAs(ctx, teacher.user);
    const start = await asTeacher.get(`/sessions/${sessions[0]!.id}/zoom/start`);
    expect(start.status).toBe(200);
    expect(start.body.data.startUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(start.headers['cache-control']).toBe('no-store, private');
  });

  it('updates the link of future classes, and of a started class that still has none', async () => {
    const id = (await admin.post('/enrollments', payload())).body.data.id as number;
    await ctx.app.get(SessionGenerator).run({ from: '2026-11-10', to: '2026-11-20' });
    const first = await ctx.prisma.classSession.findFirstOrThrow({
      where: { enrollmentId: id },
      orderBy: { startsAt: 'asc' },
    });
    await ctx.prisma.classSession.update({
      where: { id: first.id },
      data: {
        stage: 'activated',
        activatedAt: clock(ctx).now(),
        zoomStatus: 'none',
        zoomJoinUrl: null,
      },
    });
    expect(
      (
        await admin.patch(`/enrollments/${id}`, {
          meetingMode: 'external',
          externalMeetingUrl: 'https://zoom.us/j/999',
        })
      ).status,
    ).toBe(200);
    const urls = await ctx.prisma.classSession.findMany({
      where: { enrollmentId: id },
      select: { zoomJoinUrl: true },
    });
    expect([...new Set(urls.map((u) => ctx.app.get(Crypto).tryDecrypt(u.zoomJoinUrl)))]).toEqual([
      'https://zoom.us/j/999',
    ]);
    expect(
      (await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: first.id } })).zoomStatus,
    ).toBe('external');
  });

  it('clears the fixed link when the enrollment goes back to Zoom, so the Zoom job creates meetings', async () => {
    zoomDriver(ctx, 'fake');
    const id = (await admin.post('/enrollments', payload())).body.data.id as number;
    await ctx.app.get(SessionGenerator).run({ from: '2026-11-10', to: '2026-11-20' });
    expect((await admin.patch(`/enrollments/${id}`, { meetingMode: 'zoom' })).status).toBe(200);
    const rows = await ctx.prisma.classSession.findMany({ where: { enrollmentId: id } });
    expect([...new Set(rows.map((r) => r.zoomStatus))]).toEqual(['none']);
    expect(rows.filter((r) => r.zoomJoinUrl)).toEqual([]);
  });
});

describe('Zoom meetings (ZoomTest)', () => {
  let fake: FakeZoomClient;
  let teacher: Awaited<ReturnType<typeof m2Teacher>>;
  let family: Awaited<ReturnType<typeof makeFamily>>;
  let e: Awaited<ReturnType<typeof m2Enrollment>>;
  let session: Awaited<ReturnType<typeof m2Session>>;
  let host: { id: number };

  beforeEach(async () => {
    fake = zoomDriver(ctx, 'fake')!;
    clock(ctx).set('2026-11-10T10:00:00Z');
    teacher = await m2Teacher(ctx);
    family = await makeFamily(ctx, { timezone: 'Europe/London' });
    const course = await makeCourse(ctx, { nameEn: 'Quran Reading' });
    const kid = await m2Student(ctx, 'Europe/London', family, 'Yusuf Khan');
    e = await m2Enrollment(ctx, kid, teacher, { courseId: course.id });
    session = await m2Session(ctx, e, '2026-11-10T15:00:00Z');
    host = await ctx.prisma.zoomHost.create({
      data: { zoomUserId: 'zu-1', email: 'host1@example.test' },
    });
  });

  const ensure = () => ctx.app.get(SessionJobs).ensureZoom();
  const get = (id: number) => ctx.prisma.classSession.findUniqueOrThrow({ where: { id } });

  it('creates one meeting per class within the lead time, topic without surname', async () => {
    await m2Session(ctx, e, '2026-11-12T15:00:00Z'); // beyond 24 h
    await ensure();
    const s = await get(session.id);
    expect([s.zoomStatus, s.zoomHostId]).toEqual(['ready', host.id]);
    expect(ctx.app.get(Crypto).tryDecrypt(s.zoomJoinUrl)).toMatch(
      /^https:\/\/zoom\.example\.test\/j\//,
    );
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]![1]).toMatchObject({
      host: 'zu-1',
      startTime: '2026-11-10T15:00:00Z',
      duration: 30,
      topic: 'Quran Reading — Yusuf',
    });
    expect(
      (await ctx.prisma.sessionEvent.findMany({ where: { sessionId: session.id } })).map(
        (x) => x.type,
      ),
    ).toContain('zoom_created');
  });

  it('never puts two overlapping meetings on one host, and fails visibly when the pool is full', async () => {
    const other = await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), await m2Teacher(ctx)),
      '2026-11-10T15:20:00Z',
    );
    const later = await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), await m2Teacher(ctx)),
      '2026-11-10T15:35:00Z',
    ); // 15:35 ≥ 15:30 + 5
    await ensure();
    expect((await get(session.id)).zoomStatus).toBe('ready');
    expect([(await get(other.id)).zoomStatus, (await get(other.id)).zoomError]).toEqual([
      'failed',
      'no_free_host',
    ]);
    expect((await get(later.id)).zoomHostId).toBe(host.id);

    const second = await ctx.prisma.zoomHost.create({
      data: { zoomUserId: 'zu-2', email: 'host2@example.test' },
    });
    const { client } = await signedIn(ctx, 'monitor');
    const retried = await client.post(`/sessions/${other.id}/zoom/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.data.zoom.status).toBe('ready');
    expect((await get(other.id)).zoomHostId).toBe(second.id);
  });

  it('uses the teacher’s dedicated host when set', async () => {
    const mine = await ctx.prisma.zoomHost.create({
      data: { zoomUserId: 'zu-t', email: 't@example.test', teacherId: teacher.id },
    });
    await ensure();
    expect((await get(session.id)).zoomHostId).toBe(mine.id);
  });

  it('gives the start URL only to the own teacher, fresh, and never stores it', async () => {
    await ensure();
    clock(ctx).set('2026-11-10T14:44:59Z');
    const asTeacher = await signInAs(ctx, teacher.user);
    const early = await asTeacher.get(`/sessions/${session.id}/zoom/start`);
    expect(early.status).toBe(422);
    expect(early.body.code).toBe('outside_window');

    clock(ctx).set('2026-11-10T14:45:00Z');
    const res = await asTeacher.get(`/sessions/${session.id}/zoom/start`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(res.body.data.startUrl).toContain('zak=');
    for (const table of ['class_sessions', 'session_events', 'audit_logs']) {
      const rows = await ctx.prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${table}"`);
      expect(JSON.stringify(rows)).not.toContain('zak=');
    }
    expect(
      await ctx.prisma.sessionEvent.count({
        where: { sessionId: session.id, type: 'zoom_start_url_issued' },
      }),
    ).toBe(1);

    const { client: asMonitor } = await signedIn(ctx, 'monitor');
    expect((await asMonitor.get(`/sessions/${session.id}/zoom/start`)).status).toBe(403);
    const stranger = await signInAs(ctx, (await m2Teacher(ctx)).user);
    expect((await stranger.get(`/sessions/${session.id}/zoom/start`)).status).toBe(404);
    // no URL in any class payload
    const detail = await asMonitor.get(`/sessions/${session.id}`);
    expect(JSON.stringify(detail.body)).not.toContain('zoom.example.test');
    expect(detail.body.data.zoom).toEqual({ status: 'ready', joinAvailable: true });
  });

  it('gives the join URL to the family and staff from 60 minutes before', async () => {
    await ensure();
    const asParent = await signInAs(ctx, family.user);
    expect((await asParent.get(`/sessions/${session.id}/zoom/join`)).status).toBe(422);
    clock(ctx).set('2026-11-10T14:00:00Z');
    const ok = await asParent.get(`/sessions/${session.id}/zoom/join`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.joinUrl).toMatch(/^https:\/\/zoom\.example\.test\/j\//);
    const stranger = await signInAs(ctx, (await makeFamily(ctx)).user);
    expect((await stranger.get(`/sessions/${session.id}/zoom/join`)).status).toBe(404);
  });

  it('answers 503 zoom_unavailable when there is no meeting', async () => {
    zoomDriver(ctx, 'none');
    clock(ctx).set('2026-11-10T14:50:00Z');
    const asTeacher = await signInAs(ctx, teacher.user);
    const res = await asTeacher.get(`/sessions/${session.id}/zoom/start`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('zoom_unavailable');
  });

  it('updates the meeting on a class shift and deletes it on cancel', async () => {
    await ensure();
    const { client, user } = await signedIn(ctx, 'monitor');
    expect(
      (
        await client.patch(`/sessions/${session.id}`, {
          startsAt: '2026-11-10T16:00:00Z',
          expectedStage: 'scheduled',
        })
      ).status,
    ).toBe(200);
    const meetingId = (await get(session.id)).zoomMeetingId;
    expect(fake.calls.at(-1)).toEqual([
      'update',
      {
        id: meetingId,
        topic: 'Quran Reading — Yusuf',
        startTime: '2026-11-10T16:00:00Z',
        duration: 30,
      },
    ]);
    const { authUser } = await import('./helpers.js');
    await ctx.app
      .get(SessionStateMachine)
      .apply(session.id, 'cancel', await Actor.of(ctx.prisma, await authUser(ctx, user)), {
        stageReason: 'admin',
      });
    expect(fake.calls.at(-1)![0]).toBe('delete');
    expect((await get(session.id)).zoomStatus).toBe('deleted');
  });
});

describe('class rules and operations (SettingsOpsTest)', () => {
  beforeEach(() => clock(ctx).set('2026-11-10T12:00:00Z'));

  it('reads and partially updates the class rules as flat keys (admin only)', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const shown = await client.get('/settings/sessions');
    expect(shown.status).toBe(200);
    expect(shown.body.data).toMatchObject({
      'sessions.horizon_days': 14,
      'sessions.leave_notice_hours': 2,
      'academy.timezone': 'Africa/Cairo',
    });

    const put = await client.put('/settings/sessions', { 'sessions.absent_min_wait_min': 20 });
    expect(put.status).toBe(200);
    expect(put.body.data['sessions.absent_min_wait_min']).toBe(20);
    expect((await ctx.app.get(SettingsService).all())['sessions.absent_min_wait_min']).toBe(20);

    const bad = await client.put('/settings/sessions', {
      'sessions.horizon_days': 0,
      'nope.key': 1,
      'academy.timezone': 'Mars/Base',
    });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.errors).sort()).toEqual([
      'academy.timezone',
      'nope.key',
      'sessions.horizon_days',
    ]);

    const { client: asMonitor } = await signedIn(ctx, 'monitor');
    expect((await asMonitor.get('/settings/sessions')).status).toBe(403);
  });

  it('manages the Zoom host pool', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const created = await client.post('/zoom-hosts', {
      zoomUserId: 'zu-9',
      email: 'h@example.test',
      label: 'Pool 9',
    });
    expect(created.status).toBe(201);
    const off = await client.patch(`/zoom-hosts/${created.body.data.id}`, { isActive: false });
    expect(off.body.data.isActive).toBe(false);
    expect((await client.get('/zoom-hosts')).body.data).toHaveLength(1);
    expect(
      (await client.post('/zoom-hosts', { zoomUserId: 'zu-9', email: 'x@example.test' })).status,
    ).toBe(422);
  });
});

describe('meeting links at rest (AES-256-GCM)', () => {
  let teacher: Awaited<ReturnType<typeof m2Teacher>>;
  let family: Awaited<ReturnType<typeof makeFamily>>;
  let admin: Client;
  let enrollmentId: number;
  const link = 'https://meet.example.test/private-room?pwd=s3cret';

  beforeEach(async () => {
    clock(ctx).set('2026-11-10T08:00:00Z');
    teacher = await m2Teacher(ctx, 'Africa/Cairo');
    family = await makeFamily(ctx, { timezone: 'Africa/Cairo' });
    const kid = await m2Student(ctx, 'Africa/Cairo', family);
    admin = (await signedIn(ctx, 'admin')).client;
    const res = await admin.post('/enrollments', {
      studentId: kid.id,
      courseId: kid.regularCourseId,
      teacherId: teacher.id,
      kind: 'regular',
      startsOn: '2026-11-10',
      meetingMode: 'external',
      externalMeetingUrl: link,
      slots: [{ weekday: 2, localStartTime: '15:30' }],
    });
    expect(res.status).toBe(201);
    enrollmentId = res.body.data.id as number;
  });

  it('stores only ciphertext in the database, never the link', async () => {
    const e = await ctx.prisma.enrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
    const classes = await ctx.prisma.classSession.findMany({ where: { enrollmentId } });
    expect(classes.length).toBeGreaterThan(0);
    for (const value of [e.externalMeetingUrl, ...classes.map((c) => c.zoomJoinUrl)]) {
      expect(value).toMatch(/^v1:/);
      expect(value).not.toContain('meet.example.test');
    }
    for (const table of ['enrollments', 'class_sessions', 'session_events', 'audit_logs']) {
      const rows = await ctx.prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${table}"`);
      expect(JSON.stringify(rows), table).not.toContain('private-room');
    }
    // staff who manage the schedule read it back decrypted
    expect((await admin.get(`/enrollments/${enrollmentId}`)).body.data.externalMeetingUrl).toBe(
      link,
    );
  });

  it('decrypts only for the start / join links, inside their windows', async () => {
    const s = await ctx.prisma.classSession.findFirstOrThrow({
      where: { enrollmentId },
      orderBy: { startsAt: 'asc' },
    });
    clock(ctx).set('2026-11-10T13:20:00Z');
    const asParent = await signInAs(ctx, family.user);
    expect((await asParent.get(`/sessions/${s.id}/zoom/join`)).body.data.joinUrl).toBe(link);
    expect(JSON.stringify((await asParent.get(`/sessions/${s.id}`)).body)).not.toContain(
      'private-room',
    );
    const asTeacher = await signInAs(ctx, teacher.user);
    expect((await asTeacher.get(`/sessions/${s.id}/zoom/start`)).body.data.startUrl).toBe(link);
  });

  it('answers 503 zoom_unavailable (not a server error) when the stored link was tampered with', async () => {
    const s = await ctx.prisma.classSession.findFirstOrThrow({
      where: { enrollmentId },
      orderBy: { startsAt: 'asc' },
    });
    const raw = Buffer.from(s.zoomJoinUrl!.slice(3), 'base64');
    raw.writeUInt8(raw.readUInt8(20) ^ 0xff, 20);
    await ctx.prisma.classSession.update({
      where: { id: s.id },
      data: { zoomJoinUrl: `v1:${raw.toString('base64')}` },
    });
    await ctx.prisma.enrollment.update({
      where: { id: enrollmentId },
      data: { externalMeetingUrl: 'https://plain.example.test/x' },
    });

    clock(ctx).set('2026-11-10T13:20:00Z');
    const asParent = await signInAs(ctx, family.user);
    const join = await asParent.get(`/sessions/${s.id}/zoom/join`);
    expect([join.status, join.body.code]).toEqual([503, 'zoom_unavailable']);
    const asTeacher = await signInAs(ctx, teacher.user);
    const start = await asTeacher.get(`/sessions/${s.id}/zoom/start`);
    expect([start.status, start.body.code]).toEqual([503, 'zoom_unavailable']);
    // a value that is not ours (plain text) reads as no link, not as the text itself
    expect(
      (await admin.get(`/enrollments/${enrollmentId}`)).body.data.externalMeetingUrl,
    ).toBeNull();
  });
});
