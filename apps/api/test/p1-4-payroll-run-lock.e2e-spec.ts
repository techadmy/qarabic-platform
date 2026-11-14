import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetState, type TestContext } from './helpers.js';
import { m6At, m6Profile, userWithRole } from './payroll-helpers.js';

/*
| P1-4 (docs/39 BIL-4): an adjustment written while the month is being approved either is refused
| (409 period_locked / the approval fails on a run back in draft) or lands on the approved
| payslip — never an approved adjustment left out of an approved month.
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

describe('P1-4 approve vs a new adjustment, at the same time', () => {
  it('never commits an approved adjustment that is missing from the approved payslip', async () => {
    for (let round = 0; round < 5; round++) {
      await resetState(ctx);
      m6At(ctx, '2026-12-02T08:00:00Z');
      const { client: accounts } = await userWithRole(ctx, 'accounts');
      const { client: senior } = await userWithRole(ctx, 'senior_manager');
      const { user: teacher } = await userWithRole(ctx, 'teacher');
      await m6Profile(ctx, teacher.id);
      const run = await accounts.post('/payroll/runs', { period: '2026-11' });
      const id = run.body.data.id;
      expect((await senior.post(`/payroll/runs/${id}/review`, {})).status).toBe(200);

      const [approve, bonus] = await Promise.all([
        accounts.post(`/payroll/runs/${id}/approve`, {}),
        accounts.post('/payroll/adjustments', {
          userId: teacher.id,
          type: 'bonus',
          amount: '100.00',
          effectiveOn: '2026-11-20',
          reason: 'Late bonus',
        }),
      ]);
      expect([200, 409]).toContain(approve.status);
      expect([201, 409]).toContain(bonus.status);
      if (bonus.status === 409) expect(bonus.body.code).toBe('period_locked');

      const state = await ctx.prisma.payrollRun.findUniqueOrThrow({ where: { id } });
      const orphan = await ctx.prisma.payAdjustment.count({
        where: { status: 'approved', payslipId: null, effectiveOn: new Date('2026-11-20') },
      });
      if (state.status === 'approved') expect(orphan).toBe(0);
    }
  });

  it('an input to an approved month is refused with 409 period_locked', async () => {
    m6At(ctx, '2026-12-02T08:00:00Z');
    const { client: accounts } = await userWithRole(ctx, 'accounts');
    const { client: senior } = await userWithRole(ctx, 'senior_manager');
    const { user: teacher } = await userWithRole(ctx, 'teacher');
    await m6Profile(ctx, teacher.id);
    const id = (await accounts.post('/payroll/runs', { period: '2026-11' })).body.data.id;
    await senior.post(`/payroll/runs/${id}/review`, {});
    expect((await accounts.post(`/payroll/runs/${id}/approve`, {})).status).toBe(200);
    const late = await accounts.post('/payroll/adjustments', {
      userId: teacher.id,
      type: 'bonus',
      amount: '100.00',
      effectiveOn: '2026-11-20',
      reason: 'Too late',
    });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('period_locked');
  });
});
