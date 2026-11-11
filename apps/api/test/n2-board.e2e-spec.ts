import { BOARD_COUNTERS } from '@qarabic/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionGenerator } from '../src/sessions/generator.js';
import {
  clock,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  resetState,
  signedIn,
  signInAs,
  type Client,
  type TestContext,
} from './helpers.js';

/* Port of Laravel tests/Feature/M2/BoardTest.php (docs/14 §6.2, docs/15 §3.1 K1). */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let teacher: Awaited<ReturnType<typeof m2Teacher>>;
let e: Awaited<ReturnType<typeof m2Enrollment>>;
let monitor: Client;

beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-10T12:00:00Z'); // Cairo 14:00
  teacher = await m2Teacher(ctx);
  e = await m2Enrollment(ctx, await m2Student(ctx), teacher);
  monitor = (await signedIn(ctx, 'monitor')).client;
});

async function seedDay() {
  const t = async () => m2Enrollment(ctx, await m2Student(ctx), await m2Teacher(ctx));
  return {
    taken: await m2Session(ctx, await t(), '2026-11-10T06:00:00Z', {
      stage: 'taken',
      activatedAt: '2026-11-10T06:00:00Z',
    }),
    absent: await m2Session(ctx, await t(), '2026-11-10T07:00:00Z', {
      stage: 'absent',
      activatedAt: '2026-11-10T07:00:00Z',
    }),
    leave: await m2Session(ctx, await t(), '2026-11-10T08:00:00Z', {
      stage: 'leave',
      stageReason: 'student',
    }),
    declined: await m2Session(ctx, await t(), '2026-11-10T08:00:00Z', {
      stage: 'declined',
      activatedAt: '2026-11-10T08:00:00Z',
    }),
    suspended: await m2Session(ctx, await t(), '2026-11-10T09:00:00Z', {
      stage: 'cancelled',
      stageReason: 'family_suspended',
    }),
    holiday: await m2Session(ctx, await t(), '2026-11-10T09:00:00Z', {
      stage: 'cancelled',
      stageReason: 'holiday',
    }),
    ended: await m2Session(ctx, await t(), '2026-11-10T10:00:00Z', {
      stage: 'ended',
      activatedAt: '2026-11-10T10:00:00Z',
      endedAt: '2026-11-10T10:30:00Z',
    }),
    running: await m2Session(ctx, await t(), '2026-11-10T11:50:00Z', {
      stage: 'activated',
      activatedAt: '2026-11-10T11:58:00Z',
      kind: 'trial',
    }),
    late: await m2Session(ctx, e, '2026-11-10T11:50:00Z'),
    needsEntry: await m2Session(ctx, await t(), '2026-11-10T10:00:00Z'),
    remaining: await m2Session(ctx, await t(), '2026-11-10T16:00:00Z', {
      kind: 'extra',
      zoomStatus: 'failed',
      needsReview: true,
    }),
    moved: await m2Session(ctx, await t(), '2026-11-10T17:00:00Z', { stage: 'moved_out' }),
    advance: await m2Session(ctx, await t(), '2026-11-10T18:00:00Z', { kind: 'advance' }),
    resched: await m2Session(ctx, await t(), '2026-11-10T19:00:00Z', { kind: 'rescheduled' }),
    tomorrow: await m2Session(ctx, await t(), '2026-11-10T22:30:00Z'), // 00:30 Cairo on the 11th
  };
}

describe('Today board (BoardTest)', () => {
  it('returns the day counters in the board order, in the viewer zone', async () => {
    const rows = await seedDay();
    await ctx.prisma.teacherBlock.create({
      data: {
        teacherId: rows.advance.teacherId,
        kind: 'one_off',
        reason: 'leave',
        startsAt: new Date('2026-11-10T00:00:00Z'),
        endsAt: new Date('2026-11-11T00:00:00Z'),
      },
    });
    const res = await monitor.get('/sessions/board?date=2026-11-10&tz=Africa/Cairo');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['counters', 'cursor', 'generator', 'serverTime', 'sessions'].sort(),
    );
    expect(Object.keys(res.body.data.counters)).toEqual([...BOARD_COUNTERS]);
    expect(res.body.data.counters).toEqual({
      total: 13,
      taken: 1,
      remaining: 5,
      running: 1,
      late: 1,
      absent: 1,
      leave: 1,
      declined: 1,
      suspended: 1,
      trial: 1,
      advance: 1,
      rescheduled: 1,
      ended: 1,
      holiday: 1,
      extra: 1,
      needs_entry: 1,
      teacher_unavailable: 1,
      zoom_failed: 1,
      needs_review: 1,
      pending_requests: 0,
    });
    expect(res.body.data.sessions).toHaveLength(14); // moved_out rows are listed, not counted
    expect(res.body.data.generator.stale).toBe(true);

    // Tomorrow in Cairo is still today in UTC: viewing in UTC moves it
    expect(
      (await monitor.get('/sessions/board?date=2026-11-10&tz=UTC')).body.data.counters.total,
    ).toBe(14);
  });

  it('returns only changed rows after the cursor, including removed ones, with full counters', async () => {
    const rows = await seedDay();
    clock(ctx).set('2026-11-10T12:00:05Z');
    const first = (await monitor.get('/sessions/board?date=2026-11-10&tz=Africa/Cairo')).body.data;

    clock(ctx).set('2026-11-10T12:00:30Z');
    await ctx.prisma.classSession.update({
      where: { id: rows.remaining.id },
      data: { needsReview: false, updatedAt: clock(ctx).now() },
    });
    await ctx.prisma.classSession.update({
      where: { id: rows.advance.id },
      data: { deletedAt: clock(ctx).now(), updatedAt: clock(ctx).now() },
    });

    const delta = (
      await monitor.get(`/sessions/board?date=2026-11-10&tz=Africa/Cairo&since=${first.cursor}`)
    ).body.data;
    const ids = delta.sessions.map((s: { id: number }) => s.id);
    expect(ids).toContain(rows.remaining.id);
    expect(ids).toContain(rows.advance.id);
    expect(ids).not.toContain(rows.taken.id);
    expect(delta.sessions.find((s: { id: number }) => s.id === rows.advance.id).attention).toEqual([
      'deleted',
    ]);
    expect(delta.counters.total).toBe(12);
    expect(delta.cursor).not.toBeNull();
  });

  it('answers 304 when nothing changed (weak ETag)', async () => {
    await seedDay();
    await ctx.app.get(SessionGenerator).run();
    const res = await monitor.get('/sessions/board?date=2026-11-09&tz=Africa/Cairo');
    const etag = res.headers.etag as string;
    expect(etag.startsWith('W/"')).toBe(true);

    const again = await monitor.agent
      .get('/api/v1/sessions/board?date=2026-11-09&tz=Africa/Cairo')
      .set('If-None-Match', etag);
    expect(again.status).toBe(304);
    await m2Session(ctx, e, '2026-11-09T10:00:00Z');
    const changed = await monitor.agent
      .get('/api/v1/sessions/board?date=2026-11-09&tz=Africa/Cairo')
      .set('If-None-Match', etag);
    expect(changed.status).toBe(200);
  });

  it('scopes the board for a teacher and denies users without sessions.view', async () => {
    await seedDay();
    const asTeacher = await signInAs(ctx, teacher.user);
    const mine = await asTeacher.get('/sessions/board?date=2026-11-10&tz=Africa/Cairo');
    expect(mine.body.data.counters.total).toBe(1);
    const { client } = await signedIn(ctx, 'accounts');
    expect((await client.get('/sessions/board')).status).toBe(403);
  });

  it('counts pending requests and marks the row in the next delta', async () => {
    const s = await m2Session(ctx, e, '2026-11-10T16:00:00Z');
    const cursor = (await monitor.get('/sessions/board?date=2026-11-10&tz=Africa/Cairo')).body.data
      .cursor;

    clock(ctx).set('2026-11-10T14:30:00Z');
    const student = await ctx.prisma.student.findUniqueOrThrow({
      where: { id: s.studentId },
      include: { family: { include: { user: true } } },
    });
    const asParent = await signInAs(ctx, student.family.user);
    expect(
      (await asParent.post('/session-requests', { type: 'leave', sessionId: s.id, reason: 'sick' }))
        .status,
    ).toBe(201);

    const delta = (
      await monitor.get(`/sessions/board?date=2026-11-10&tz=Africa/Cairo&since=${cursor}`)
    ).body.data;
    expect(delta.counters.pending_requests).toBe(1);
    expect(delta.sessions.find((x: { id: number }) => x.id === s.id).attention).toContain(
      'pending_request',
    );
  });
});
