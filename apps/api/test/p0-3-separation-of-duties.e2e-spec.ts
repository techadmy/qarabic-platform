import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetState, type TestContext } from './helpers.js';
import { m6At, m6Profile, userWithRole } from './payroll-helpers.js';

/*
| P0-3 (docs/39 RBAC-1, B116): nobody decides anything about themselves — leave, attendance,
| fines and other adjustments, their own pay profile, their own payslip; the reviewer of a payroll
| run is not its approver, and nobody approves a run holding their own payslip. No exceptions:
| a senior manager's or an accountant's own items go to another approver (the admin).
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
  m6At(ctx, '2026-11-15T08:00:00Z');
});

const adjustment = (userId: number, extra: Record<string, unknown> = {}) => ({
  userId,
  type: 'bonus',
  amount: '500.00',
  effectiveOn: '2026-11-15',
  reason: 'Good month',
  ...extra,
});

describe('P0-3 leave and attendance', () => {
  it('a monitor cannot approve their own leave; another approver can', async () => {
    const { user: monitor, client } = await userWithRole(ctx, 'monitor');
    const created = await client.post('/leave-requests', {
      startsOn: '2026-11-20',
      endsOn: '2026-11-20',
      leaveType: 'paid',
      reason: 'Doctor visit',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.can.decide).toBe(false);
    const own = await client.post(`/leave-requests/${created.body.data.id}/approve`);
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('self_decision');
    const { client: admin } = await userWithRole(ctx, 'admin');
    const ok = await admin.post(`/leave-requests/${created.body.data.id}/approve`);
    expect(ok.status).toBe(200);
    expect(
      await ctx.prisma.staffAttendance.count({ where: { userId: monitor.id, status: 'leave' } }),
    ).toBe(1);
  });

  it('nobody marks their own attendance day; others still can', async () => {
    const { user: manager, client } = await userWithRole(ctx, 'manager');
    const self = await client.put(`/attendance/${manager.id}/2026-11-14`, {
      status: 'present',
      reason: 'Forgot to check in',
    });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('self_decision');
    const { user: monitor } = await userWithRole(ctx, 'monitor');
    const other = await client.put(`/attendance/${monitor.id}/2026-11-14`, {
      status: 'present',
      reason: 'Forgot to check in',
    });
    expect(other.status).toBe(200);
  });
});

describe('P0-3 adjustments, pay profile and payslips', () => {
  it('accounts giving themselves a bonus only proposes it; they cannot approve it, the admin can', async () => {
    const { user: accountant, client } = await userWithRole(ctx, 'accounts');
    await m6Profile(ctx, accountant.id);
    const created = await client.post('/payroll/adjustments', adjustment(accountant.id));
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('proposed');
    const id = created.body.data.id;
    const own = await client.post(`/payroll/adjustments/${id}/approve`);
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('self_decision');
    const { client: admin } = await userWithRole(ctx, 'admin');
    expect((await admin.post(`/payroll/adjustments/${id}/approve`)).status).toBe(200);
    // For someone else the same accountant still approves directly.
    const { user: teacher } = await userWithRole(ctx, 'teacher');
    await m6Profile(ctx, teacher.id);
    const forOther = await client.post('/payroll/adjustments', adjustment(teacher.id));
    expect(forOther.body.data.status).toBe('approved');
  });

  it('a senior manager cannot reduce or cancel their own fine; may withdraw their own proposal', async () => {
    const { user: senior, client } = await userWithRole(ctx, 'senior_manager');
    await m6Profile(ctx, senior.id);
    const reduction = await client.post(
      '/payroll/adjustments',
      adjustment(senior.id, { type: 'fine_reduction', reason: 'Reduce my fine' }),
    );
    // Only a proposal, which they cannot approve.
    expect(reduction.body.data.status).toBe('proposed');
    expect(
      (await client.post(`/payroll/adjustments/${reduction.body.data.id}/approve`)).status,
    ).toBe(403);
    // Withdrawing one's own proposal is fine.
    expect(
      (
        await client.post(`/payroll/adjustments/${reduction.body.data.id}/cancel`, {
          note: 'Changed my mind',
        })
      ).status,
    ).toBe(200);
    // A fine on them, approved by someone else: they cannot cancel it.
    const { client: admin } = await userWithRole(ctx, 'admin');
    const fine = await admin.post(
      '/payroll/adjustments',
      adjustment(senior.id, { type: 'fine', reason: 'Late for the meeting' }),
    );
    expect(fine.body.data.status).toBe('approved');
    const cancel = await client.post(`/payroll/adjustments/${fine.body.data.id}/cancel`, {
      note: 'Not fair',
    });
    expect(cancel.status).toBe(403);
    expect(cancel.body.code).toBe('self_decision');
  });

  it('nobody sets their own pay profile', async () => {
    const { user: accountant, client } = await userWithRole(ctx, 'accounts');
    const res = await client.put(`/salary-profiles/${accountant.id}`, {
      salaryType: 'monthly',
      currency: 'EGP',
      monthlySalary: '99999.00',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('self_decision');
  });
});

describe('P0-3 payroll run', () => {
  it('the reviewer cannot approve; nobody approves a run holding their own payslip', async () => {
    const { user: accountant, client: accounts } = await userWithRole(ctx, 'accounts');
    const { client: admin } = await userWithRole(ctx, 'admin');
    const { client: senior } = await userWithRole(ctx, 'senior_manager');
    const { user: teacher } = await userWithRole(ctx, 'teacher');
    await m6Profile(ctx, teacher.id);
    m6At(ctx, '2026-12-02T08:00:00Z');
    const run = await accounts.post('/payroll/runs', { period: '2026-11' });
    expect(run.status).toBe(201);
    const id = run.body.data.id;

    // The admin reviews, so the admin may not also approve.
    expect((await admin.post(`/payroll/runs/${id}/review`, {})).status).toBe(200);
    const same = await admin.post(`/payroll/runs/${id}/approve`, {});
    expect(same.status).toBe(403);
    expect(same.body.code).toBe('same_reviewer');

    // The accountant is paid in this run: they may not approve it either.
    await m6Profile(ctx, accountant.id);
    expect((await accounts.post(`/payroll/runs/${id}/recompute`, {})).status).toBe(200);
    expect((await senior.post(`/payroll/runs/${id}/review`, {})).status).toBe(200);
    const ownSlip = await accounts.post(`/payroll/runs/${id}/approve`, {});
    expect(ownSlip.status).toBe(403);
    expect(ownSlip.body.code).toBe('own_payslip_in_run');

    // The admin: neither the reviewer now nor paid in it.
    expect((await admin.post(`/payroll/runs/${id}/approve`, {})).status).toBe(200);
  });
});
