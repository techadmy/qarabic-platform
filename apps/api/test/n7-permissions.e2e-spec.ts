import { permissionsFor } from '@qarabic/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Client,
  createTestApp,
  makeFamily,
  resetState,
  signInAs,
  type TestContext,
} from './helpers.js';
import { m6At, m6Enrollment, m6Session, m6Teacher, userWithRole } from './payroll-helpers.js';

/*
| Port of Laravel tests/Feature/M6/PayrollPermissionsTest.php (docs/21 §9): who may do what, and a
| teacher sees only their own approved payslips (another person's payslip or a draft answers 404,
| never 403: no existence leak), own attendance, own leave, own decided fines and own wallet.
*/

let ctx: TestContext;
let teacher: Awaited<ReturnType<typeof m6Teacher>>;
let other: Awaited<ReturnType<typeof m6Teacher>>;
let accounts: Client;
let runId: number;
let mine: number;
let theirs: number;

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
  other = await m6Teacher(ctx, { hourlyRate: '400.00' });
  await m6Session(ctx, await m6Enrollment(ctx, teacher), '2026-10-05T10:00:00Z', 'taken');
  await m6Session(ctx, await m6Enrollment(ctx, other), '2026-10-05T11:00:00Z', 'taken');
  accounts = (await userWithRole(ctx, 'accounts')).client;
  runId = (await accounts.post('/payroll/runs', { period: '2026-10' })).body.data.id;
  mine = (await ctx.prisma.payslip.findFirstOrThrow({ where: { userId: teacher.userId } })).id;
  theirs = (await ctx.prisma.payslip.findFirstOrThrow({ where: { userId: other.userId } })).id;
});

async function approveRun(): Promise<void> {
  const { client: senior } = await userWithRole(ctx, 'senior_manager');
  expect((await senior.post(`/payroll/runs/${runId}/review`)).status).toBe(200);
  expect((await accounts.post(`/payroll/runs/${runId}/approve`)).status).toBe(200);
}

describe('payroll permissions (docs/21 §9)', () => {
  it('gives every staff role and the teacher attendance.request and keeps parents out', () => {
    for (const role of [
      'senior_manager',
      'manager',
      'monitor',
      'csr',
      'billing',
      'accounts',
      'teacher',
    ] as const) {
      expect(permissionsFor(role), role).toContain('attendance.request');
    }
    expect(permissionsFor('parent')).not.toContain('attendance.request');
  });

  it.each([
    ['teacher', 403, 403, 403, 403],
    ['parent', 403, 403, 403, 403],
    ['billing (D87)', 403, 403, 403, 403],
    ['monitor', 403, 403, 403, 403],
    ['manager', 403, 403, 403, 403],
    ['senior manager reviews only', 200, 403, 200, 403],
    ['accounts prepares and approves', 200, 201, 403, 409],
  ])('keeps payroll runs to payroll roles: %s', async (label, list, create, review, approve) => {
    const role =
      {
        'billing (D87)': 'billing',
        'senior manager reviews only': 'senior_manager',
        'accounts prepares and approves': 'accounts',
      }[label] ?? label;
    const { client } = await userWithRole(ctx, role);
    expect((await client.get('/payroll/runs')).status).toBe(list);
    expect((await client.post('/payroll/runs', { period: '2026-09' })).status).toBe(create);
    expect((await client.post(`/payroll/runs/${runId}/review`)).status).toBe(review);
    expect((await client.post(`/payroll/runs/${runId}/approve`)).status).toBe(approve);
  });

  it('shows a teacher only their own payslip, and only once approved', async () => {
    const client = await signInAs(ctx, teacher.user);
    expect((await client.get(`/payslips/${mine}`)).status).toBe(404); // still a draft
    expect((await client.get('/me/payslips')).body.data).toHaveLength(0);

    await approveRun();

    const slip = await client.get(`/payslips/${mine}`);
    expect(slip.status).toBe(200);
    expect(slip.body.data).toMatchObject({
      net: '150.00',
      period: '2026-10',
      warnings: [],
      errors: [],
    });
    expect(slip.body.data.lines[0].code).toBe('hour_earning');
    expect(slip.body.data.sessions[0].payHours).toBe('0.50');
    expect((await client.get(`/payslips/${theirs}`)).status).toBe(404);
    const list = await client.get('/me/payslips');
    expect(list.body.data.map((s: { id: number }) => s.id)).toEqual([mine]);
    const wallet = await client.get('/me/wallet');
    expect(wallet.body.data.balances[0].balance).toBe('150.00');
    expect(wallet.body.data.transactions[0]).toMatchObject({
      type: 'salary_credit',
      period: '2026-10',
    });

    expect(
      (await client.post(`/payslips/${mine}/payments`, { method: 'cash', paidOn: '2026-11-15' }))
        .status,
    ).toBe(403);
    expect((await client.get('/wallets')).status).toBe(403);
    expect((await client.get(`/salary-profiles/${teacher.userId}`)).status).toBe(403);
    expect((await client.get('/payroll/runs/preview?period=2026-10')).status).toBe(403);
  });

  it('lets payroll staff see every payslip with its warnings', async () => {
    const { client: senior } = await userWithRole(ctx, 'senior_manager');
    const res = await senior.get(`/payslips/${theirs}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(other.userId);
    expect((await senior.get('/payslips/999999')).status).toBe(404);
  });

  it('lets accounts manage salary profiles with validation and an audit trail', async () => {
    const { user: employee } = await userWithRole(ctx, 'csr');
    const noRate = await accounts.put(`/salary-profiles/${employee.id}`, {
      salaryType: 'hourly',
      currency: 'EGP',
    });
    expect(noRate.status).toBe(422);
    expect(noRate.body.errors).toHaveProperty('hourlyRate');
    const badCurrency = await accounts.put(`/salary-profiles/${employee.id}`, {
      salaryType: 'monthly',
      currency: 'XXX',
      monthlySalary: '0.01',
    });
    expect(badCurrency.status).toBe(422);
    expect(badCurrency.body.errors).toHaveProperty('currency');
    const saved = await accounts.put(`/salary-profiles/${employee.id}`, {
      salaryType: 'slot',
      currency: 'PKR',
      slotTiers: [
        { minSlots: 4, amount: '9.00' },
        { minSlots: 0, amount: '1.00' },
      ],
      reason: 'New CSR',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.slotTiers[0]).toEqual({ minSlots: 0, amount: '1.00' });
    expect(saved.body.data.user.id).toBe(employee.id);

    expect((await accounts.get(`/salary-profiles/${employee.id}`)).body.data.salaryType).toBe(
      'slot',
    );
    expect((await accounts.get('/salary-profiles')).body.data).toHaveLength(3);
    expect((await accounts.get('/salary-profiles/999999')).status).toBe(404);
    const { user: nobody } = await userWithRole(ctx, 'billing');
    expect((await accounts.get(`/salary-profiles/${nobody.id}`)).body.data).toBeNull();
    expect((await accounts.get('/wallets')).status).toBe(200);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'salary_profile_saved', subjectId: saved.body.data.id },
    });
    expect(audit.reason).toBe('New CSR');
    // A parent account has no salary.
    const family = await makeFamily(ctx);
    const parent = await accounts.put(`/salary-profiles/${family.userId}`, {
      salaryType: 'monthly',
      currency: 'EGP',
      monthlySalary: '1.00',
    });
    expect(parent.status).toBe(422);
  });

  it('offers a person picker to fine and attendance staff, not to teachers', async () => {
    const { client: monitor } = await userWithRole(ctx, 'monitor');
    const res = await monitor.get('/payroll/people');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].currency).toBe('PKR');
    expect(res.body.data[0]).not.toHaveProperty('hourlyRate');
    const client = await signInAs(ctx, teacher.user);
    expect((await client.get('/payroll/people')).status).toBe(403);
  });

  it('keeps parents out of every payroll screen', async () => {
    const family = await makeFamily(ctx);
    const parent = await signInAs(ctx, family.user);
    for (const path of [
      '/attendance',
      '/attendance/today',
      '/leave-requests',
      '/payroll/adjustments',
      `/payslips/${mine}`,
      '/me/payslips',
      '/me/wallet',
      '/payroll/people',
    ]) {
      expect((await parent.get(path)).status, path).toBe(403);
    }
    expect((await parent.post('/attendance/check-in')).status).toBe(403);
  });
});
