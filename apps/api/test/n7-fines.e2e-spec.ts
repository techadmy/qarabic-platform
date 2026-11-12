import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetState, signInAs, type TestContext } from './helpers.js';
import {
  m6At,
  m6Enrollment,
  m6Profile,
  m6Session,
  m6Slip,
  m6Teacher,
  userWithRole,
} from './payroll-helpers.js';

/*
| Port of Laravel tests/Feature/M6/FinesTest.php (D91): the monitor proposes a fine, a manager
| approves or rejects it; nothing is deleted; a fine already locked in an approved month is waived
| with a fine reduction (old type 5).
*/

let ctx: TestContext;
let teacher: Awaited<ReturnType<typeof m6Teacher>>;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await resetState(ctx);
  m6At(ctx, '2026-11-15T08:00:00Z');
  teacher = await m6Teacher(ctx, { hourlyRate: '300.00' });
  await m6Session(ctx, await m6Enrollment(ctx, teacher), '2026-10-05T10:00:00Z', 'taken');
});

const fine = (overrides: Record<string, unknown> = {}) => ({
  userId: teacher.userId,
  type: 'fine',
  amount: '50.00',
  effectiveOn: '2026-10-07',
  reason: 'Late more than 5 minutes',
  sessionId: null,
  ...overrides,
});

describe('fines (D91)', () => {
  it('lets a monitor propose a fine that only counts after a manager approves it', async () => {
    const { client: monitor } = await userWithRole(ctx, 'monitor');
    const res = await monitor.post('/payroll/adjustments', fine());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'proposed',
      currency: 'PKR',
      sign: -1,
      amount: '50.00',
    });
    const id = res.body.data.id;

    // The monitor cannot approve, and cannot add a bonus.
    expect((await monitor.post(`/payroll/adjustments/${id}/approve`)).status).toBe(403);
    const bonus = await monitor.post('/payroll/adjustments', fine({ type: 'bonus' }));
    expect(bonus.status).toBe(403);
    expect(bonus.body.code).toBe('forbidden_type');

    const { client: manager } = await userWithRole(ctx, 'manager');
    const ok = await manager.post(`/payroll/adjustments/${id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('approved');
    const { client: accounts } = await userWithRole(ctx, 'accounts');
    expect((await accounts.post('/payroll/runs', { period: '2026-10' })).status).toBe(201);

    expect((await m6Slip(ctx, teacher.userId)).net.toFixed(2)).toBe('100.00'); // 150 − 50
  });

  it('requires a note to reject and keeps the rejected fine', async () => {
    const { client: monitor } = await userWithRole(ctx, 'monitor');
    const id = (await monitor.post('/payroll/adjustments', fine())).body.data.id;
    const { client: manager } = await userWithRole(ctx, 'manager');

    expect((await manager.post(`/payroll/adjustments/${id}/reject`)).status).toBe(422);
    const rejected = await manager.post(`/payroll/adjustments/${id}/reject`, {
      note: 'The teacher had told the monitor',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('rejected');
    const again = await manager.post(`/payroll/adjustments/${id}/approve`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_adjustment_status');
    expect(await ctx.prisma.payAdjustment.count()).toBe(1);
  });

  it('cancels an open fine and waives a locked one with a fine reduction in the first open month', async () => {
    const { client: manager } = await userWithRole(ctx, 'manager');
    const open = (await manager.post('/payroll/adjustments', fine({ effectiveOn: '2026-11-03' })))
      .body.data.id;
    const cancelled = await manager.post(`/payroll/adjustments/${open}/cancel`, {
      note: 'Entered twice',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.adjustment.status).toBe('cancelled');
    expect(cancelled.body.data.reduction).toBeNull();

    const locked = (await manager.post('/payroll/adjustments', fine())).body.data.id;
    const { client: accounts } = await userWithRole(ctx, 'accounts');
    const { client: senior } = await userWithRole(ctx, 'senior_manager');
    const runId = (await accounts.post('/payroll/runs', { period: '2026-10' })).body.data.id;
    expect((await senior.post(`/payroll/runs/${runId}/review`)).status).toBe(200);
    expect((await accounts.post(`/payroll/runs/${runId}/approve`)).status).toBe(200);

    const waived = await manager.post(`/payroll/adjustments/${locked}/cancel`, {
      note: 'Zoom outage, not the teacher',
    });
    expect(waived.status).toBe(201);
    expect(waived.body.data.adjustment).toMatchObject({ status: 'approved', locked: true });
    expect(waived.body.data.reduction).toMatchObject({
      type: 'fine_reduction',
      effectiveOn: '2026-11-15',
      amount: '50.00',
      reversesId: locked,
      sign: 1,
    });
    const twice = await manager.post(`/payroll/adjustments/${locked}/cancel`, { note: 'again' });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('already_waived');

    // November pays the fine back.
    expect((await accounts.post('/payroll/runs', { period: '2026-11' })).status).toBe(201);
    const nov = await m6Slip(ctx, teacher.userId, '2026-11');
    expect(nov.lines.map((l) => l.code)).toContain('fine_reduction');
    expect(nov.net.toFixed(2)).toBe('50.00');
  });

  it('refuses to cancel a bonus of a locked month (period_locked)', async () => {
    const { client: accounts } = await userWithRole(ctx, 'accounts');
    const bonus = (
      await accounts.post('/payroll/adjustments', fine({ type: 'bonus', reason: 'Good month' }))
    ).body.data.id;
    const { client: senior } = await userWithRole(ctx, 'senior_manager');
    const runId = (await accounts.post('/payroll/runs', { period: '2026-10' })).body.data.id;
    await senior.post(`/payroll/runs/${runId}/review`);
    await accounts.post(`/payroll/runs/${runId}/approve`);
    const res = await accounts.post(`/payroll/adjustments/${bonus}/cancel`, {
      note: 'Changed mind',
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'period_locked', data: { period: '2026-10' } });
  });

  it("shows teachers only their own decided fines and staff everyone's fines", async () => {
    const { client: manager } = await userWithRole(ctx, 'manager');
    const { client: monitor } = await userWithRole(ctx, 'monitor');
    expect((await manager.post('/payroll/adjustments', fine())).status).toBe(201);
    expect((await monitor.post('/payroll/adjustments', fine({ amount: '7.77' }))).status).toBe(201);
    const other = await m6Teacher(ctx);
    expect(
      (await manager.post('/payroll/adjustments', fine({ userId: other.userId }))).status,
    ).toBe(201);

    const teacherClient = await signInAs(ctx, teacher.user);
    const own = await teacherClient.get('/payroll/adjustments');
    expect(own.status).toBe(200);
    expect(own.body.data).toHaveLength(1);
    expect(own.body.data[0]).toMatchObject({
      amount: '50.00',
      can: { cancel: false, decide: false },
    });
    expect((await teacherClient.post('/payroll/adjustments', fine())).status).toBe(403);
    // Another person's fine and an own proposed fine answer 404.
    const othersFine = await ctx.prisma.payAdjustment.findFirstOrThrow({
      where: { userId: other.userId },
    });
    expect((await teacherClient.get(`/payroll/adjustments/${othersFine.id}`)).status).toBe(404);
    const proposed = await ctx.prisma.payAdjustment.findFirstOrThrow({
      where: { status: 'proposed' },
    });
    expect((await teacherClient.get(`/payroll/adjustments/${proposed.id}`)).status).toBe(404);

    const pending = await monitor.get('/payroll/adjustments?status=proposed');
    expect(pending.body.data).toHaveLength(1);
    expect(pending.body.meta.counts.proposed).toBe(1);
    expect((await monitor.get('/payroll/adjustments')).body.data).toHaveLength(3);
    // The monitor who proposed may withdraw it while proposed.
    expect(
      (await monitor.post(`/payroll/adjustments/${proposed.id}/cancel`, { note: 'My mistake' }))
        .status,
    ).toBe(200);
  });

  it('keeps payroll-only items (bonus …) out of the fine staff list', async () => {
    const { client: accounts } = await userWithRole(ctx, 'accounts');
    await accounts.post('/payroll/adjustments', fine({ type: 'bonus', reason: 'Good month' }));
    const { client: monitor } = await userWithRole(ctx, 'monitor');
    await monitor.post('/payroll/adjustments', fine());
    const list = await monitor.get('/payroll/adjustments');
    expect(list.body.data.map((a: { type: string }) => a.type)).toEqual(['fine']);
    const bonusId = (await ctx.prisma.payAdjustment.findFirstOrThrow({ where: { type: 'bonus' } }))
      .id;
    expect((await monitor.get(`/payroll/adjustments/${bonusId}`)).status).toBe(404);
    expect((await accounts.get('/payroll/adjustments')).body.data).toHaveLength(2);
  });

  it('rejects an adjustment for a person without a salary profile', async () => {
    const { user: nobody } = await userWithRole(ctx, 'monitor');
    const { client: manager } = await userWithRole(ctx, 'manager');
    const res = await manager.post('/payroll/adjustments', fine({ userId: nobody.id }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('no_pay_profile');
    expect((await manager.post('/payroll/adjustments', fine({ amount: '0' }))).status).toBe(422);
    expect((await manager.post('/payroll/adjustments', fine({ userId: 999999 }))).status).toBe(422);
  });

  it('pays and fines a teacher whose profile has no currency in EGP (the payroll default)', async () => {
    await m6Profile(ctx, teacher.userId, { currency: null, teacherId: teacher.id });
    const { client: monitor } = await userWithRole(ctx, 'monitor');
    const res = await monitor.post('/payroll/adjustments', fine());
    expect(res.status).toBe(201);
    expect(res.body.data.currency).toBe('EGP');
    const { client: accounts } = await userWithRole(ctx, 'accounts');
    expect((await accounts.post('/payroll/runs', { period: '2026-10' })).status).toBe(201);

    const slip = await m6Slip(ctx, teacher.userId);
    expect(slip.currency).toBe('EGP');
    expect(slip.net.toFixed(2)).toBe('150.00');
    expect(slip.errors).toEqual([]);
  });
});
