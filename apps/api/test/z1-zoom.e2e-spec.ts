import { createHash, createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ZoomApi, ZoomHttp, type ZoomResponse } from '../src/zoom/zoom.api.js';
import { ZoomAttendance } from '../src/zoom/zoom.attendance.js';
import { ZoomConfig } from '../src/zoom/zoom.config.js';
import { FAILURES_PER_MINUTE } from '../src/zoom/zoom.webhook.js';
import {
  type Client,
  clock,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  resetState,
  signedIn,
  type TestContext,
} from './helpers.js';

/*
| Z1 (docs/42 §6, D148): Zoom attendance from a Server-to-Server app and its webhook, on each
| teacher's personal meeting (PMI). Off until the keys exist. Throwaway test keys only.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const SECRET = 'test-webhook-secret';
const PMI = '1234567890';
const HOST = 'zoom-user-1';
const DAY = '2026-11-10';
const at = (hhmm: string) => `${DAY}T${hhmm}:00Z`;

let monitor: Client;
beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set(at('09:00'));
  monitor = (await signedIn(ctx, 'monitor')).client;
});

function on() {
  ctx.app.get(ZoomConfig).use({
    accountId: 'acc',
    clientId: 'cid',
    clientSecret: 'csecret',
    webhookSecret: SECRET,
  });
}

function post(body: object, opts: { ts?: number; sig?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(clock(ctx).nowMs() / 1000));
  const sig =
    opts.sig ??
    `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:`).update(Buffer.from(raw, 'utf8')).digest('hex')}`;
  return request(ctx.app.getHttpServer())
    .post('/api/v1/integrations/zoom/webhook')
    .set('Content-Type', 'application/json')
    .set('x-zm-request-timestamp', ts)
    .set('x-zm-signature', sig)
    .send(raw);
}

const participant = (id: string, userId: string, time: string, left = false) => ({
  id,
  user_id: userId,
  user_name: id ? 'Teacher' : 'Student',
  ...(left ? { leave_time: at(time) } : { join_time: at(time) }),
});
const event = (name: string, p?: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  event: name,
  event_ts: Date.parse(at('09:00')),
  payload: {
    account_id: 'acc',
    object: {
      id: PMI,
      uuid: 'meeting-uuid-1',
      host_id: HOST,
      ...extra,
      ...(p ? { participant: p } : {}),
    },
  },
});

/** Waits for the background processing, then processes anything left. */
async function drain() {
  const attendance = ctx.app.get(ZoomAttendance);
  for (let i = 0; i < 20; i++) {
    await attendance.processPending();
    const busy = await ctx.prisma.zoomWebhookEvent.count({
      where: { status: { in: ['received', 'processing'] } },
    });
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function trackedTeacher() {
  const teacher = await m2Teacher(ctx, 'Africa/Cairo');
  await ctx.prisma.zoomHost.create({
    data: {
      zoomUserId: HOST,
      email: 'teacher@zoom.example.test',
      teacherId: teacher.id,
      pmiMeetingId: PMI,
    },
  });
  return teacher;
}

describe('switched off without the keys', () => {
  it('the webhook is 404, the API refuses, and the board keeps the manual late rule', async () => {
    expect((await post(event('meeting.started'))).status).toBe(404);
    await expect(ctx.app.get(ZoomApi).user('x')).rejects.toThrow(/off/);
    const teacher = await trackedTeacher();
    const s = await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), teacher),
      at('10:00'),
    );
    clock(ctx).set(at('10:12'));
    const board = await monitor.get(`/sessions/board?date=${DAY}&tz=UTC`);
    const row = board.body.data.sessions.find((x: { id: number }) => x.id === s.id);
    expect(row.attention).toContain('late'); // not activated: today's rule
    expect(row.attention).not.toContain('teacher_no_show');
  });
});

describe('POST /integrations/zoom/webhook', () => {
  beforeEach(on);

  it('checks the signature: good 200, wrong 401, older than 5 minutes 401, missing 401', async () => {
    expect((await post(event('meeting.started'))).status).toBe(200);
    expect((await post(event('meeting.started'), { sig: 'v0=deadbeef' })).status).toBe(401);
    const stale = Math.floor(clock(ctx).nowMs() / 1000) - 6 * 60;
    expect((await post(event('meeting.started'), { ts: stale })).status).toBe(401);
    const none = await request(ctx.app.getHttpServer())
      .post('/api/v1/integrations/zoom/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event('meeting.started')));
    expect(none.status).toBe(401);
  });

  it('answers the URL validation challenge', async () => {
    const res = await post({ event: 'endpoint.url_validation', payload: { plainToken: 'abc123' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      plainToken: 'abc123',
      encryptedToken: createHmac('sha256', SECRET).update('abc123').digest('hex'),
    });
  });

  it('stores a repeated event once', async () => {
    const joined = event('meeting.participant_joined', participant('', 'p-1', '10:01'));
    expect((await post(joined)).status).toBe(200);
    expect((await post(joined)).status).toBe(200);
    expect(await ctx.prisma.zoomWebhookEvent.count()).toBe(1);
    await drain();
  });

  it('maps the PMI to the teacher and splits two back-to-back classes', async () => {
    const teacher = await trackedTeacher();
    const e1 = await m2Enrollment(ctx, await m2Student(ctx), teacher);
    const e2 = await m2Enrollment(ctx, await m2Student(ctx), teacher);
    const c1 = await m2Session(ctx, e1, at('10:00'));
    const c2 = await m2Session(ctx, e2, at('10:30'));
    for (const body of [
      event('meeting.started', undefined, { start_time: at('09:58') }),
      event('meeting.participant_joined', participant(HOST, 't-1', '09:58')),
      event('meeting.participant_joined', participant('', 's-1', '10:01')),
      // The next student arrives early, the first leaves at the end; the teacher stays.
      event('meeting.participant_joined', participant('', 's-2', '10:29')),
      event('meeting.participant_left', participant('', 's-1', '10:30', true)),
    ]) {
      expect((await post(body)).status).toBe(200);
    }
    // Another meeting: logged as unmatched, not an error.
    await post({ ...event('meeting.started'), payload: { object: { id: '999', uuid: 'x' } } });
    await drain();

    const one = await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: c1.id } });
    expect(one.teacherJoinedAt?.toISOString()).toBe(at('09:58').replace('Z', '.000Z'));
    expect(one.studentJoinedAt?.toISOString()).toBe('2026-11-10T10:01:00.000Z');
    expect(one.actualStartedAt?.toISOString()).toBe('2026-11-10T10:01:00.000Z');
    expect(one.actualEndedAt?.toISOString()).toBe('2026-11-10T10:30:00.000Z');
    const two = await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: c2.id } });
    expect(two.studentJoinedAt?.toISOString()).toBe('2026-11-10T10:29:00.000Z');
    // The teacher was still in the meeting when the second class's window opened (10:15).
    expect(two.teacherJoinedAt?.toISOString()).toBe('2026-11-10T10:15:00.000Z');
    expect(two.actualStartedAt?.toISOString()).toBe('2026-11-10T10:29:00.000Z');

    const statuses = await ctx.prisma.zoomWebhookEvent.groupBy({ by: ['status'], _count: true });
    expect(Object.fromEntries(statuses.map((s) => [s.status, s._count]))).toEqual({
      processed: 5,
      unmatched: 1,
    });
    // The timeline names the role only (B118).
    const timeline = await ctx.prisma.sessionEvent.findMany({
      where: { sessionId: c1.id, type: 'participant_joined' },
    });
    expect(timeline.map((t) => (t.payload as { role: string }).role).sort()).toEqual([
      'student',
      'teacher',
    ]);
    expect(JSON.stringify(timeline)).not.toContain('Teacher');
  });
});

describe('flags from Zoom (B132 thresholds)', () => {
  beforeEach(on);

  async function tracked(startsAt: string) {
    const teacher = await trackedTeacher();
    return m2Session(ctx, await m2Enrollment(ctx, await m2Student(ctx), teacher), startsAt);
  }
  const flags = async (id: number, now: string) => {
    clock(ctx).set(now);
    const board = await monitor.get(`/sessions/board?date=${DAY}&tz=UTC`);
    return board.body.data.sessions.find((x: { id: number }) => x.id === id).attention as string[];
  };

  it('teacher late after 5 minutes, no-show after 10', async () => {
    const s = await tracked(at('12:00'));
    expect(await flags(s.id, at('12:04'))).not.toContain('late');
    expect(await flags(s.id, at('12:06'))).toContain('late');
    const later = await flags(s.id, at('12:11'));
    expect(later).toEqual(expect.arrayContaining(['late', 'teacher_no_show']));
    const board = await monitor.get(`/sessions/board?date=${DAY}&tz=UTC`);
    expect(board.body.data.counters.teacher_no_show).toBe(1);
  });

  it('student no-show after 10 minutes; a short class below 80 %; flagged for review afterwards', async () => {
    const s = await tracked(at('12:00'));
    await post(event('meeting.participant_joined', participant(HOST, 't', '12:01')));
    await drain();
    expect(await flags(s.id, at('12:09'))).not.toContain('student_no_show');
    expect(await flags(s.id, at('12:11'))).toContain('student_no_show');

    await post(event('meeting.participant_joined', participant('', 's', '12:12')));
    await post(event('meeting.participant_left', participant('', 's', '12:20', true)));
    await drain();
    const after = await flags(s.id, at('12:25'));
    expect(after).toContain('short_class'); // 8 of 30 minutes
    clock(ctx).set(at('13:00'));
    expect(await ctx.app.get(ZoomAttendance).flagFinished()).toBe(1);
    const row = await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row).toMatchObject({ needsReview: true, reviewReason: 'student_no_show' });
  });
});

describe('reconciliation after the meeting ends', () => {
  beforeEach(on);

  it('pulls the participant report (cached token) and fills the joins the webhook missed', async () => {
    const teacher = await trackedTeacher();
    const s = await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), teacher),
      at('10:00'),
    );
    const calls: string[] = [];
    ctx.app.get(ZoomHttp).use((req) => {
      calls.push(`${req.method} ${req.url.split('?')[0]}`);
      if (req.url.startsWith('https://zoom.us/oauth/token')) {
        return Promise.resolve({
          status: 200,
          headers: {},
          json: { access_token: 'tok', expires_in: 3600 },
        });
      }
      return Promise.resolve({
        status: 200,
        headers: {},
        json: {
          participants: [
            {
              id: HOST,
              user_id: 't-1',
              name: 'T',
              join_time: at('09:59'),
              leave_time: at('10:31'),
            },
            { id: '', user_id: 's-1', name: 'S', join_time: at('10:00'), leave_time: at('10:30') },
          ],
          next_page_token: '',
        },
      });
    });
    // Only the end reached us.
    await post(event('meeting.ended', undefined, { end_time: at('10:31') }));
    await drain();
    clock(ctx).set(at('10:40'));
    expect(await ctx.app.get(ZoomAttendance).reconcile()).toBe(1);
    const row = await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.teacherJoinedAt?.toISOString()).toBe('2026-11-10T09:59:00.000Z');
    expect(row.studentJoinedAt?.toISOString()).toBe('2026-11-10T10:00:00.000Z');
    expect(row.actualStartedAt?.toISOString()).toBe('2026-11-10T10:00:00.000Z');
    expect(row.actualEndedAt?.toISOString()).toBe('2026-11-10T10:31:00.000Z');
    // A second pass does nothing; one token for both calls.
    expect(await ctx.app.get(ZoomAttendance).reconcile()).toBe(0);
    expect(calls.filter((c) => c.includes('oauth')).length).toBe(1);
  });

  it('backs off on 429 and retries', async () => {
    let n = 0;
    ctx.app.get(ZoomHttp).use((req) => {
      if (req.url.startsWith('https://zoom.us/oauth/token')) {
        return Promise.resolve({
          status: 200,
          headers: {},
          json: { access_token: 'tok', expires_in: 3600 },
        });
      }
      n++;
      const res: ZoomResponse =
        n === 1
          ? { status: 429, headers: { 'retry-after': '1' }, json: {} }
          : { status: 200, headers: {}, json: { id: 'u1', email: 'a@b.test', pmi: 1234567890 } };
      return Promise.resolve(res);
    });
    const waits: number[] = [];
    const api = ctx.app.get(ZoomApi);
    const user = (await api.get('/users/u1', (ms) => {
      waits.push(ms);
      return Promise.resolve();
    })) as { id: string };
    expect(user.id).toBe('u1');
    expect(waits).toEqual([1000]);
  });
});

describe('security review follow-ups', () => {
  beforeEach(on);

  it('keeps no names, hashes the email, and stores other events as metadata only', async () => {
    await post({
      ...event('meeting.participant_joined'),
      payload: {
        object: {
          id: PMI,
          uuid: 'u',
          host_id: HOST,
          participant: {
            user_id: 'p-9',
            user_name: 'Student Name',
            email: 'Kid@Example.test',
            join_time: at('10:01'),
          },
        },
      },
    });
    await post({
      event: 'meeting.chat_message_sent',
      payload: { object: { id: PMI, uuid: 'u', chat_message: { message: 'private words' } } },
    });
    await drain();
    const rows = await ctx.prisma.zoomWebhookEvent.findMany({ orderBy: { id: 'asc' } });
    const joined = JSON.stringify(rows[0]!.payload);
    expect(joined).not.toContain('Student Name');
    expect(joined).not.toContain('Kid@Example');
    expect(joined).toContain(createHash('sha256').update('kid@example.test').digest('hex'));
    expect(rows[1]).toMatchObject({ status: 'ignored' });
    expect(JSON.stringify(rows[1]!.payload)).not.toContain('private words');
  });

  it('prunes processed, unmatched and ignored rows after 60 days; failed ones stay', async () => {
    const old = new Date(clock(ctx).nowMs() - 61 * 86_400_000);
    const recent = new Date(clock(ctx).nowMs() - 59 * 86_400_000);
    const row = (key: string, status: string, receivedAt: Date) => ({
      eventKey: key.padEnd(64, '0'),
      event: 'meeting.started',
      payload: {},
      eventAt: receivedAt,
      status,
      receivedAt,
    });
    await ctx.prisma.zoomWebhookEvent.createMany({
      data: [
        row('a', 'processed', old),
        row('b', 'unmatched', old),
        row('c', 'ignored', old),
        row('d', 'failed', old),
        row('e', 'processed', recent),
      ],
    });
    expect(await ctx.app.get(ZoomAttendance).prune()).toBe(3);
    expect((await ctx.prisma.zoomWebhookEvent.findMany()).map((r) => r.status).sort()).toEqual([
      'failed',
      'processed',
    ]);
  });

  it('counts only failed signatures per IP; a signed request still gets through', async () => {
    for (let i = 0; i < FAILURES_PER_MINUTE; i++) {
      expect((await post(event('meeting.started'), { sig: 'v0=bad' })).status).toBe(401);
    }
    expect((await post(event('meeting.started'), { sig: 'v0=bad' })).status).toBe(429);
    expect((await post(event('meeting.started'))).status).toBe(200);
  });

  it('signs over the raw bytes (non-ASCII bodies)', async () => {
    const body = event('meeting.participant_joined', {
      ...participant('', 'p-ar', '10:02'),
      user_name: 'محمد عبد الله',
    });
    expect((await post(body)).status).toBe(200);
  });

  it('the Zoom user id decides who the host is; an email alone does not override it', async () => {
    const teacher = await trackedTeacher();
    const s = await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), teacher),
      at('10:00'),
    );
    // Another Zoom user who happens to give the teacher's email: a student.
    await post(
      event('meeting.participant_joined', {
        id: 'someone-else',
        user_id: 'x',
        user_name: 'X',
        join_time: at('10:01'),
        email: 'teacher@zoom.example.test',
      }),
    );
    await drain();
    const row = await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.teacherJoinedAt).toBeNull();
    expect(row.studentJoinedAt).not.toBeNull();
  });

  it('checks a saved PMI against the Zoom user', async () => {
    ctx.app
      .get(ZoomHttp)
      .use((req) =>
        Promise.resolve(
          req.url.startsWith('https://zoom.us/oauth/token')
            ? { status: 200, headers: {}, json: { access_token: 'tok', expires_in: 3600 } }
            : { status: 200, headers: {}, json: { id: HOST, email: 'h@x.test', pmi: 1234567890 } },
        ),
      );
    const { client: admin } = await signedIn(ctx, 'admin');
    const wrong = await admin.post('/zoom-hosts', {
      zoomUserId: HOST,
      email: 'h@x.test',
      pmiMeetingId: '9999999999',
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.errors).toHaveProperty('pmiMeetingId');
    const ok = await admin.post('/zoom-hosts', {
      zoomUserId: HOST,
      email: 'h@x.test',
      pmiMeetingId: '123 456 7890',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.pmiMeetingId).toBe(PMI);
  });

  it('the queue coalesces runs, takes back stuck rows and retries failed ones with backoff', async () => {
    const teacher = await trackedTeacher();
    const s = await m2Session(
      ctx,
      await m2Enrollment(ctx, await m2Student(ctx), teacher),
      at('10:00'),
    );
    const attendance = ctx.app.get(ZoomAttendance);
    for (const t of ['10:01', '10:02', '10:03']) {
      await attendance.store(event('meeting.participant_joined', participant('', `s-${t}`, t)));
    }
    // Three overlapping calls: one run (plus its dirty pass), each event once.
    await Promise.all([
      attendance.processPending(),
      attendance.processPending(),
      attendance.processPending(),
    ]);
    expect(
      await ctx.prisma.sessionEvent.count({
        where: { sessionId: s.id, type: 'participant_joined' },
      }),
    ).toBe(3);

    // A row a crashed run left behind is taken back after 10 minutes.
    await attendance.store(
      event('meeting.participant_left', participant('', 's-x', '10:20', true)),
    );
    await ctx.prisma.zoomWebhookEvent.updateMany({
      where: { status: 'received' },
      data: { status: 'processing', claimedAt: new Date(clock(ctx).nowMs() - 11 * 60_000) },
    });
    await attendance.processPending();
    expect(await ctx.prisma.zoomWebhookEvent.count({ where: { status: 'processing' } })).toBe(0);

    // A failed row waits for its backoff, then runs again.
    await attendance.store(event('meeting.participant_joined', participant('', 's-y', '10:25')));
    await ctx.prisma.zoomWebhookEvent.updateMany({
      where: { status: 'received' },
      data: {
        status: 'failed',
        attempts: 1,
        nextAttemptAt: new Date(clock(ctx).nowMs() + 60_000),
      },
    });
    await attendance.processPending();
    expect(await ctx.prisma.zoomWebhookEvent.count({ where: { status: 'failed' } })).toBe(1);
    clock(ctx).set(new Date(clock(ctx).nowMs() + 2 * 60_000).toISOString());
    await attendance.processPending();
    expect(await ctx.prisma.zoomWebhookEvent.count({ where: { status: 'failed' } })).toBe(0);
  });
});
