import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionGenerator } from '../src/sessions/generator.js';
import { SessionJobs } from '../src/sessions/jobs.js';
import { Actor, SessionStateMachine } from '../src/sessions/state-machine.js';
import {
  authUser,
  clock,
  createTestApp,
  createUser,
  m2Enrollment,
  m2Slot,
  m2Student,
  m2Teacher,
  makeFamily,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';

/* Port of Laravel tests/Feature/M2/GeneratorTest.php (D40, docs/14 §4), plus US DST cases. */

let ctx: TestContext;
let generator: SessionGenerator;

beforeAll(async () => {
  ctx = await createTestApp();
  generator = ctx.app.get(SessionGenerator);
});
afterAll(async () => {
  await ctx.app.close();
});

let teacher: Awaited<ReturnType<typeof m2Teacher>>;
let family: Awaited<ReturnType<typeof makeFamily>>;
let enrollment: Awaited<ReturnType<typeof m2Enrollment>>;
let slot: Awaited<ReturnType<typeof m2Slot>>;

beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-09T08:00:00Z'); // Monday
  teacher = await m2Teacher(ctx, 'Africa/Cairo');
  family = await makeFamily(ctx, { timezone: 'Europe/London' });
  enrollment = await m2Enrollment(ctx, await m2Student(ctx, 'Europe/London', family), teacher, {
    startsOn: '2026-11-01',
  });
  slot = await m2Slot(ctx, enrollment, 1, '17:00', { validFrom: '2026-11-01' }); // Mondays 17:00 London
});

const rows = () =>
  ctx.prisma.classSession.findMany({ where: { deletedAt: null }, orderBy: { startsAt: 'asc' } });
const dates = async () => (await rows()).map((s) => s.occurrenceDate!.toISOString().slice(0, 10));
const starts = async (where = {}) =>
  (
    await ctx.prisma.classSession.findMany({
      where: { deletedAt: null, ...where },
      orderBy: { startsAt: 'asc' },
    })
  ).map((s) => s.startsAt.toISOString().replace('.000Z', 'Z'));

describe('generator (GeneratorTest)', () => {
  it('generates the horizon with each occurrence in UTC from the local wall time', async () => {
    const r = await generator.run();
    expect(await dates()).toEqual(['2026-11-09', '2026-11-16', '2026-11-23']);
    expect(r.created).toHaveLength(3);
    const first = (await rows())[0]!;
    expect(first.startsAt.toISOString()).toBe('2026-11-09T17:00:00.000Z');
    expect(first.source).toBe('generated');
    expect(await ctx.prisma.sessionEvent.count({ where: { type: 'generated' } })).toBe(3);
  });

  it('is idempotent: a second run creates nothing', async () => {
    await generator.run();
    const r = await generator.run();
    expect(r.created).toEqual([]);
    expect(r.skipped).toBe(3);
    expect(await ctx.prisma.classSession.count()).toBe(3);
    expect(await ctx.prisma.sessionEvent.count()).toBe(3);
  });

  it('never re-creates a class that was removed or changed by hand', async () => {
    await generator.run();
    const [first, second] = await rows();
    await ctx.prisma.classSession.update({
      where: { id: first!.id },
      data: { deletedAt: new Date() },
    });
    await ctx.prisma.classSession.update({
      where: { id: second!.id },
      data: {
        startsAt: new Date('2026-11-16T18:00:00Z'),
        endsAt: new Date('2026-11-16T18:30:00Z'),
        isDetached: true,
      },
    });
    await generator.run();
    expect(await ctx.prisma.classSession.count({ where: { deletedAt: null } })).toBe(2);
    expect(await ctx.prisma.classSession.count()).toBe(3);
  });

  it('does not backfill the past silently, but does with an explicit from (CLI --from)', async () => {
    clock(ctx).set('2026-11-10T08:00:00Z');
    await generator.run();
    expect(await dates()).toEqual(['2026-11-16', '2026-11-23']);

    await ctx.app.get(SessionJobs).generate({ from: '2026-11-02', to: '2026-11-09' });
    expect(await dates()).toEqual(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'sessions_backfill' } })).toBe(1);
  });

  it('respects slot validity and enrollment start/end dates', async () => {
    await ctx.prisma.scheduleSlot.update({
      where: { id: slot.id },
      data: { validTo: new Date('2026-11-15T00:00:00Z') },
    });
    await m2Slot(ctx, enrollment, 1, '18:00', { validFrom: '2026-11-16' });
    await ctx.prisma.enrollment.update({
      where: { id: enrollment.id },
      data: { endsOn: new Date('2026-11-20T00:00:00Z') },
    });
    await generator.run();
    expect(await starts()).toEqual(['2026-11-09T17:00:00Z', '2026-11-16T18:00:00Z']);
  });

  it('creates holiday and suspension rows as cancelled, marked', async () => {
    await ctx.prisma.holiday.create({
      data: { name: 'National day', date: new Date('2026-11-16T00:00:00Z'), paid: true },
    });
    await generator.run();
    const holiday = await ctx.prisma.classSession.findFirstOrThrow({
      where: { occurrenceDate: new Date('2026-11-16T00:00:00Z') },
    });
    expect([holiday.stage, holiday.stageReason]).toEqual(['cancelled', 'holiday']);
    expect(holiday.markedAt).not.toBeNull();

    const other = await m2Enrollment(ctx, await m2Student(ctx), await m2Teacher(ctx), {
      status: 'paused',
      pausedReason: 'family_suspended',
    });
    await m2Slot(ctx, other, 2, '10:00');
    const r = await generator.run();
    expect(r.cancelledByRule).toBe(2);
    const reasons = await ctx.prisma.classSession.findMany({
      where: { enrollmentId: other.id },
      select: { stageReason: true },
    });
    expect([...new Set(reasons.map((x) => x.stageReason))]).toEqual(['family_suspended']);
  });

  it('generates DST-correct instants across the UK clock change', async () => {
    clock(ctx).set('2027-03-20T08:00:00Z');
    await generator.run();
    expect(await starts()).toEqual(['2027-03-22T17:00:00Z', '2027-03-29T16:00:00Z']); // 14-day horizon
  });

  it('keeps a US student at 16:00 New York across the March and November switches', async () => {
    const ny = await m2Enrollment(ctx, await m2Student(ctx, 'America/New_York'), teacher, {
      timezone: 'America/New_York',
      startsOn: '2027-01-01',
    });
    await m2Slot(ctx, ny, 1, '16:00', { validFrom: '2027-01-01' });
    await generator.run({ enrollmentId: ny.id, from: '2027-03-01', to: '2027-03-21' });
    await generator.run({ enrollmentId: ny.id, from: '2027-10-25', to: '2027-11-14' });
    expect(await starts({ enrollmentId: ny.id })).toEqual([
      '2027-03-01T21:00:00Z', // EST
      '2027-03-08T21:00:00Z',
      '2027-03-15T20:00:00Z', // EDT from 14 March
      '2027-10-25T20:00:00Z',
      '2027-11-01T20:00:00Z',
      '2027-11-08T21:00:00Z', // EST from 7 November
    ]);
  });

  it('keeps the local date as occurrence_date when UTC is another day', async () => {
    const sydney = await m2Enrollment(ctx, await m2Student(ctx, 'Australia/Sydney'), teacher, {
      timezone: 'Australia/Sydney',
    });
    await m2Slot(ctx, sydney, 1, '06:30'); // Monday 06:30 Sydney = Sunday 19:30 UTC (AEDT)
    await generator.run({ enrollmentId: sydney.id });
    const first = await ctx.prisma.classSession.findFirstOrThrow({
      where: { enrollmentId: sydney.id },
      orderBy: { startsAt: 'asc' },
    });
    expect(first.occurrenceDate!.toISOString().slice(0, 10)).toBe('2026-11-16');
    expect(first.startsAt.toISOString()).toBe('2026-11-15T19:30:00.000Z');
  });

  it('holds the unique key when two runs race', async () => {
    const [a, b] = await Promise.all([generator.run(), generator.run()]);
    expect(a.created.length + b.created.length).toBe(3);
    expect(await ctx.prisma.classSession.count()).toBe(3);
    expect(await ctx.prisma.sessionEvent.count({ where: { type: 'generated' } })).toBe(3);
  });

  it('re-syncs future untouched classes on a family status change and leaves touched ones alone', async () => {
    await generator.run();
    const [a, b, c] = await rows();
    // b was touched by a person: leave taken
    const monitor = await createUser(ctx, 'monitor');
    await ctx.app
      .get(SessionStateMachine)
      .apply(b!.id, 'mark_leave', await Actor.of(ctx.prisma, await authUser(ctx, monitor)), {});

    const { client } = await signedIn(ctx, 'manager');
    const suspend = await client.post(`/families/${family.id}/status`, {
      status: 'suspended',
      reason: 'Unpaid invoice',
    });
    expect(suspend.status).toBe(200);
    const get = (id: number) => ctx.prisma.classSession.findUniqueOrThrow({ where: { id } });
    expect([(await get(a!.id)).stage, (await get(a!.id)).stageReason]).toEqual([
      'cancelled',
      'family_suspended',
    ]);
    expect((await get(b!.id)).stage).toBe('leave');
    expect((await get(c!.id)).stage).toBe('cancelled');
    expect(
      (await ctx.prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status,
    ).toBe('paused');

    // back to regular → resumed and re-scheduled
    expect((await client.post(`/families/${family.id}/status`, { status: 'regular' })).status).toBe(
      200,
    );
    expect((await get(a!.id)).stage).toBe('scheduled');
    expect((await get(a!.id)).markedAt).toBeNull();
    expect((await get(b!.id)).stage).toBe('leave');
  });

  it('ends the live enrollments of a deactivated family and removes their future classes', async () => {
    await generator.run();
    const { client } = await signedIn(ctx, 'manager');
    await client.post(`/families/${family.id}/status`, {
      status: 'deactivated',
      reason: 'Left the academy',
    });
    const e = await ctx.prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(e.status).toBe('ended');
    expect(e.endsOn?.toISOString().slice(0, 10)).toBe('2026-11-09');
    expect(await ctx.prisma.classSession.count({ where: { deletedAt: null } })).toBe(0);
  });

  it('re-syncs teacher changes and closed slots', async () => {
    await generator.run();
    const fresh = await m2Teacher(ctx);
    const { client } = await signedIn(ctx, 'monitor');
    const res = await client.patch(`/enrollments/${enrollment.id}`, {
      teacherId: fresh.id,
      effectiveFrom: '2026-11-16',
      acknowledgeWarnings: ['dst_shift'],
    });
    expect(res.status).toBe(200);
    // the old-slot rows from the 16th are no longer wanted → removed, replaced by the new slot's rows
    expect((await rows()).map((s) => s.teacherId)).toEqual([teacher.id, fresh.id, fresh.id]);
    expect(await ctx.prisma.classSession.count({ where: { deletedAt: { not: null } } })).toBe(2);
  });

  it('cancels on a new holiday and restores when it is removed', async () => {
    await generator.run();
    const { client } = await signedIn(ctx, 'admin');
    const created = await client.post('/holidays', { name: 'Eid', date: '2026-11-16' });
    expect(created.status).toBe(201);
    const row = await ctx.prisma.classSession.findFirstOrThrow({
      where: { occurrenceDate: new Date('2026-11-16T00:00:00Z') },
    });
    expect([row.stage, row.stageReason]).toEqual(['cancelled', 'holiday']);

    expect((await client.delete(`/holidays/${created.body.data.id}`)).status).toBe(204);
    expect((await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: row.id } })).stage).toBe(
      'scheduled',
    );
  });

  it('records health and syncs one day from the board button (dry run first)', async () => {
    expect((await generator.health()).stale).toBe(true);
    await ctx.app.get(SessionJobs).generate();
    expect((await generator.health()).stale).toBe(false);
    await ctx.prisma.$executeRawUnsafe('TRUNCATE "class_sessions" RESTART IDENTITY CASCADE');

    const { client } = await signedIn(ctx, 'admin');
    const dry = await client.post('/sessions/generate', { date: '2026-11-16', dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.data.toCreate).toHaveLength(1);
    expect(dry.body.data.created).toEqual([]);
    expect(dry.body.data.toCreate[0].startsAt).toBe('2026-11-16T17:00:00Z');
    expect(await ctx.prisma.classSession.count()).toBe(0);

    const real = await client.post('/sessions/generate', { date: '2026-11-16' });
    expect(real.status).toBe(200);
    expect(real.body.data.toCreate).toHaveLength(1);
    expect(
      await ctx.prisma.classSession.count({
        where: { occurrenceDate: new Date('2026-11-16T00:00:00Z') },
      }),
    ).toBe(1);

    const asTeacher = await signInAs(ctx, teacher.user);
    expect((await asTeacher.post('/sessions/generate', { date: '2026-11-16' })).status).toBe(403);
  });
});
