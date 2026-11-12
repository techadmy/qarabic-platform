import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Period } from '../src/payroll/period.js';
import { PayrollRunsService } from '../src/payroll/runs.service.js';
import { SettingsService } from '../src/settings/settings.service.js';
import { type Client, createTestApp, resetState, signInAs, type TestContext } from './helpers.js';
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
| Port of Laravel tests/Feature/M6/RunLifecycleTest.php (D92, D93, D95): draft → reviewed →
| approved → paid, locked after approval, reopen with a reason, wallet credit / debit and the
| outbox. Plus idempotent compute, concurrent creation, preview, payslip emails and the CLI.
| Nothing here moves money: a payment is recorded only.
*/

let ctx: TestContext;
let accounts: Client;
let senior: Client;
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
  accounts = (await userWithRole(ctx, 'accounts')).client;
  senior = (await userWithRole(ctx, 'senior_manager')).client;
  teacher = await m6Teacher(ctx, { hourlyRate: '300.00' });
  const e = await m6Enrollment(ctx, teacher);
  await m6Session(ctx, e, '2026-10-05T10:00:00Z', 'taken');
  await m6Session(ctx, e, '2026-10-06T10:00:00Z', 'taken');
});

async function run(): Promise<number> {
  const res = await accounts.post('/payroll/runs', { period: '2026-10' });
  expect(res.status).toBe(201);
  return (res.body as { data: { id: number } }).data.id;
}

async function review(id: number): Promise<void> {
  const res = await senior.post(`/payroll/runs/${id}/review`);
  expect(res.status).toBe(200);
  expect(res.body.data.status).toBe('reviewed');
}

const walletSum = async (userId: number) =>
  (
    await ctx.prisma.walletTransaction.aggregate({ where: { userId }, _sum: { amount: true } })
  )._sum.amount?.toFixed(2) ?? '0.00';

describe('payroll run lifecycle (D92)', () => {
  it('refuses a second run for the month and a month that has not started', async () => {
    await run();
    const dup = await accounts.post('/payroll/runs', { period: '2026-10' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('run_exists');
    const future = await accounts.post('/payroll/runs', { period: '2026-12' });
    expect(future.status).toBe(422);
    expect(future.body.code).toBe('period_not_started');
    const bad = await accounts.post('/payroll/runs', { period: '2026-13' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('validation_failed');
  });

  it('creates one run when two requests race for the same month', async () => {
    const results = await Promise.all([
      accounts.post('/payroll/runs', { period: '2026-10' }),
      accounts.post('/payroll/runs', { period: '2026-10' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await ctx.prisma.payrollRun.count()).toBe(1);
    expect(await ctx.prisma.payslip.count()).toBe(1);
  });

  it('shows the run with totals per currency and its payslips', async () => {
    const id = await run();
    const res = await accounts.get(`/payroll/runs/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      period: '2026-10',
      totals: [{ currency: 'PKR', net: '300.00', people: 1 }],
      can: { review: false, recompute: true }, // accounts prepares, the senior manager reviews
    });
    expect(res.body.data.payslips[0].user.id).toBe(teacher.userId);
    expect((await accounts.get('/payroll/runs')).body.data[0].period).toBe('2026-10');
    expect((await accounts.get('/payroll/runs/999999')).status).toBe(404);
  });

  it('pays a profile without a currency in EGP and blocks the review on a negative net', async () => {
    const { user: broke } = await userWithRole(ctx, 'monitor');
    await m6Profile(ctx, broke.id, {
      salaryType: 'monthly',
      currency: null,
      hourlyRate: '0',
      monthlySalary: '1.00',
      tax: '5.00',
    });
    const id = await run();
    expect(
      (await ctx.prisma.payslip.findFirstOrThrow({ where: { userId: broke.id } })).currency,
    ).toBe('EGP');

    const res = await senior.post(`/payroll/runs/${id}/review`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('payroll_blocked');
    expect(res.body.data[0].errors[0].code).toBe('negative_net');
    expect((await ctx.prisma.payrollRun.findUniqueOrThrow({ where: { id } })).status).toBe('draft');
  });

  it('runs the whole cycle: review, approve (wallet credit, lock), pay (wallet debit), paid', async () => {
    const id = await run();
    await review(id);

    // Any change after the review sends the run back to draft.
    expect(
      (
        await accounts.post('/payroll/adjustments', {
          userId: teacher.userId,
          type: 'bonus',
          amount: '50.00',
          effectiveOn: '2026-10-31',
          reason: 'Good month',
        })
      ).status,
    ).toBe(201);
    expect((await ctx.prisma.payrollRun.findUniqueOrThrow({ where: { id } })).status).toBe('draft');
    const early = await accounts.post(`/payroll/runs/${id}/approve`);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('invalid_run_status');

    await review(id);
    const approved = await accounts.post(`/payroll/runs/${id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('approved');

    const slip = await m6Slip(ctx, teacher.userId);
    expect(slip.status).toBe('approved');
    expect(slip.net.toFixed(2)).toBe('350.00');
    expect(await walletSum(teacher.userId)).toBe('350.00');
    expect(
      (await ctx.prisma.payAdjustment.findFirstOrThrow({ where: { type: 'bonus' } })).payslipId,
    ).toBe(slip.id);
    expect(await ctx.prisma.payrollEvent.count({ where: { type: 'payslip.approved' } })).toBe(1);
    const runEvent = await ctx.prisma.payrollEvent.findFirstOrThrow({
      where: { type: 'payroll_run.approved' },
    });
    expect(runEvent.payload).toMatchObject({ netByCurrency: { PKR: '350.00' } });

    // Locked: no recompute, no new adjustment for October, no attendance change in October.
    expect((await accounts.post(`/payroll/runs/${id}/recompute`)).status).toBe(409);
    const late = await accounts.post('/payroll/adjustments', {
      userId: teacher.userId,
      type: 'gift',
      amount: '0.01',
      effectiveOn: '2026-10-31',
      reason: 'late',
    });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('period_locked');
    const { client: manager } = await userWithRole(ctx, 'manager');
    const mark = await manager.put(`/attendance/${teacher.userId}/2026-10-10`, {
      status: 'absent',
      reason: 'missed day',
    });
    expect(mark.status).toBe(409);
    expect(mark.body.code).toBe('period_locked');

    // Record the payment (reference required except for cash). Nothing is transferred.
    expect(
      (
        await accounts.post(`/payslips/${slip.id}/payments`, {
          method: 'vodafone_cash',
          paidOn: '2026-11-15',
        })
      ).status,
    ).toBe(422);
    const paid = await accounts.post(`/payslips/${slip.id}/payments`, {
      method: 'vodafone_cash',
      reference: 'VC-778',
      paidOn: '2026-11-15',
    });
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({
      status: 'paid',
      paymentReference: 'VC-778',
      paidOn: '2026-11-15',
    });
    const twice = await accounts.post(`/payslips/${slip.id}/payments`, {
      method: 'cash',
      paidOn: '2026-11-15',
    });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('payslip_already_paid');

    expect(await walletSum(teacher.userId)).toBe('0.00');
    expect((await ctx.prisma.payrollRun.findUniqueOrThrow({ where: { id } })).status).toBe('paid');
    const paidEvent = await ctx.prisma.payrollEvent.findFirstOrThrow({
      where: { type: 'payslip.paid' },
    });
    expect(paidEvent.payload).toMatchObject({
      net: '350.00',
      method: 'vodafone_cash',
      period: '2026-10',
    });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'payslip_paid' } })).toBe(1);

    // Reopen is refused once a payslip is paid.
    expect((await accounts.post(`/payroll/runs/${id}/reopen`, { note: 'wrong rate' })).status).toBe(
      409,
    );
  });

  it('reopens an approved run with a reason, reversing the wallet and unlocking adjustments', async () => {
    const id = await run();
    await review(id);
    await accounts.post(`/payroll/runs/${id}/approve`);

    expect((await accounts.post(`/payroll/runs/${id}/reopen`)).status).toBe(422);
    const res = await accounts.post(`/payroll/runs/${id}/reopen`, { note: 'Wrong hourly rate' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('draft');

    expect(await walletSum(teacher.userId)).toBe('0.00');
    expect(await ctx.prisma.walletTransaction.count({ where: { type: 'reversal' } })).toBe(1);
    const reversed = await ctx.prisma.payrollEvent.findFirstOrThrow({
      where: { type: 'payslip.reversed' },
    });
    expect(reversed.payload).toMatchObject({ reason: 'Wrong hourly rate' });
    expect((await ctx.prisma.payslip.findFirstOrThrow()).status).toBe('draft');
  });

  it('keeps the wallet ledger append-only', async () => {
    const id = await run();
    await review(id);
    await accounts.post(`/payroll/runs/${id}/approve`);
    await expect(
      ctx.prisma.walletTransaction.updateMany({ data: { reference: 'x' } }),
    ).rejects.toThrow(/append-only/);
    await expect(ctx.prisma.walletTransaction.deleteMany()).rejects.toThrow(/append-only/);
  });

  it('marks a zero-net payslip paid at approval and settles the run', async () => {
    const idle = await m6Teacher(ctx, { hourlyRate: '300.00' }); // no classes
    const id = await run();
    await review(id);
    await accounts.post(`/payroll/runs/${id}/approve`);
    expect(
      (await ctx.prisma.payslip.findFirstOrThrow({ where: { userId: idle.userId } })).status,
    ).toBe('paid');
    expect((await ctx.prisma.payrollRun.findUniqueOrThrow({ where: { id } })).status).toBe(
      'approved',
    );
  });

  it("warns on the next month when an approved month's class changes afterwards (B49)", async () => {
    const id = await run();
    await review(id);
    await accounts.post(`/payroll/runs/${id}/approve`);

    // A late correction: a third October class is marked taken after approval.
    await m6Session(ctx, await m6Enrollment(ctx, teacher), '2026-10-20T10:00:00Z', 'taken');
    expect((await accounts.post('/payroll/runs', { period: '2026-11' })).status).toBe(201);

    const nov = await m6Slip(ctx, teacher.userId, '2026-11');
    expect(
      (nov.warnings as Array<{ code: string }>).find((w) => w.code === 'prior_period_changed'),
    ).toEqual({
      code: 'prior_period_changed',
      period: '2026-10',
      deltaHours: '0.50',
    });
  });

  it('recomputes a draft when classes change', async () => {
    const id = await run();
    await m6Session(ctx, await m6Enrollment(ctx, teacher), '2026-10-21T10:00:00Z', 'absent');
    expect((await accounts.post(`/payroll/runs/${id}/recompute`)).status).toBe(200);
    expect((await m6Slip(ctx, teacher.userId)).net.toFixed(2)).toBe('450.00');
  });
});

describe('idempotent compute, preview, emails, CLI', () => {
  it('recomputes in place: same payslip ids, same lines, same totals', async () => {
    const id = await run();
    const before = await ctx.prisma.payslip.findMany({ include: { lines: true, sessions: true } });
    for (let i = 0; i < 3; i++) {
      expect((await accounts.post(`/payroll/runs/${id}/recompute`)).status).toBe(200);
    }
    const after = await ctx.prisma.payslip.findMany({ include: { lines: true, sessions: true } });
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(after.map((s) => [s.net.toFixed(2), s.lines.length, s.sessions.length])).toEqual(
      before.map((s) => [s.net.toFixed(2), s.lines.length, s.sessions.length]),
    );
    expect(await ctx.prisma.payslipLine.count()).toBe(1);
    expect(await ctx.prisma.payslipSession.count()).toBe(2);
  });

  it('drops the payslip of a deactivated profile on recompute', async () => {
    const other = await m6Teacher(ctx, { hourlyRate: '100.00' });
    const id = await run();
    expect(await ctx.prisma.payslip.count({ where: { runId: id } })).toBe(2);
    await ctx.prisma.payProfile.update({
      where: { userId: other.userId },
      data: { active: false },
    });
    await accounts.post(`/payroll/runs/${id}/recompute`);
    expect(await ctx.prisma.payslip.count({ where: { runId: id } })).toBe(1);
  });

  it('previews a month without storing anything', async () => {
    const res = await senior.get('/payroll/runs/preview?period=2026-10');
    expect(res.status).toBe(200);
    expect(res.body.data.payslips).toHaveLength(1);
    expect(res.body.data.payslips[0]).toMatchObject({
      net: '300.00',
      paidHours: '1.00',
      lines: [{ code: 'hour_earning', quantity: '1.00', rate: '300.00', amount: '300.00' }],
    });
    expect(res.body.data.totals).toEqual([
      {
        currency: 'PKR',
        people: 1,
        earnings: '300.00',
        deductions: '0.00',
        net: '300.00',
        paid: '0.00',
      },
    ]);
    expect(await ctx.prisma.payrollRun.count()).toBe(0);
    expect(await ctx.prisma.payslip.count()).toBe(0);
    expect((await senior.get('/payroll/runs/preview?period=2026-1')).status).toBe(422);
  });

  it('sends no payslip email unless the setting is on (then to the in-memory mailer only)', async () => {
    const id = await run();
    await review(id);
    await accounts.post(`/payroll/runs/${id}/approve`);
    expect(ctx.mailer.sent.filter((m) => m.kind === 'payslip_approved')).toHaveLength(0);

    await ctx.app.get(SettingsService).set('payroll.payslip_emails', true, null);
    await accounts.post(`/payroll/runs/${id}/reopen`, { note: 'Test the emails' });
    await review(id);
    await accounts.post(`/payroll/runs/${id}/approve`);
    const mails = ctx.mailer.sent.filter((m) => m.kind === 'payslip_approved');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe(teacher.user.email);
    expect(mails[0]!.text).toContain('300.00 PKR');
  });

  it('payroll:compute creates the run, then recomputes it, and leaves an approved month alone', async () => {
    const svc = ctx.app.get(PayrollRunsService);
    const first = await svc.computePeriod(Period.parse('2026-10'));
    expect(first.action).toBe('created');
    expect((await svc.computePeriod(Period.parse('2026-10'))).action).toBe('recomputed');
    await review(first.runId);
    expect((await svc.computePeriod(Period.parse('2026-10'))).action).toBe('recomputed');
    expect(
      (await ctx.prisma.payrollRun.findUniqueOrThrow({ where: { id: first.runId } })).status,
    ).toBe('draft');
    await review(first.runId);
    await accounts.post(`/payroll/runs/${first.runId}/approve`);
    expect((await svc.computePeriod(Period.parse('2026-10'))).action).toBe('locked');
    expect((await svc.currentPeriod()).toString()).toBe('2026-11');
  });
});

describe('payslips and wallet for the teacher', () => {
  it('lets the teacher see the payslip lines and wallet history once approved', async () => {
    const id = await run();
    await review(id);
    await accounts.post(`/payroll/runs/${id}/approve`);
    const client = await signInAs(ctx, teacher.user);
    const mine = await client.get('/me/payslips');
    expect(mine.body.data).toHaveLength(1);
    const detail = await client.get(`/payslips/${mine.body.data[0].id}`);
    expect(detail.body.data.sessions).toHaveLength(2);
    expect(detail.body.data.warnings).toEqual([]);
    const wallet = await client.get('/me/wallet');
    expect(wallet.body.data.balances).toEqual([{ currency: 'PKR', balance: '300.00' }]);
    const { client: walletAdmin } = await userWithRole(ctx, 'accounts');
    const all = await walletAdmin.get('/wallets');
    expect(all.body.data).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ id: teacher.userId }),
        balance: '300.00',
      }),
    ]);
  });
});
