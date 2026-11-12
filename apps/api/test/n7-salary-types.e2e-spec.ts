import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { slotTier } from '../src/payroll/calculator.js';
import { PayRuleEngine } from '../src/payroll/pay-rules.js';
import { Period } from '../src/payroll/period.js';
import { SessionGenerator } from '../src/sessions/generator.js';
import {
  type Client,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Slot,
  m2Student,
  m2Teacher,
  resetState,
  signInAs,
  signedIn,
  type TestContext,
} from './helpers.js';
import {
  m6At,
  m6Enrollment,
  m6Lines,
  m6Profile,
  m6Session,
  m6Slip,
  m6Teacher,
  userWithRole,
} from './payroll-helpers.js';

/*
| Port of Laravel tests/Feature/M6/SalaryTypesTest.php (docs/21 §4: one worked month per salary
| type, to the minor unit) and tests/Feature/M2/PayRuleEngineTest.php (D41), plus the pay rule
| set API and the snapshot the class state machine / generator write.
| Clock pinned to 2026-11-15 (Cairo); the month under test is 2026-10.
*/

let ctx: TestContext;
let accounts: Client;

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
});

const runOctober = async () =>
  expect((await accounts.post('/payroll/runs', { period: '2026-10' })).status).toBe(201);

describe('salary types (docs/21 §4)', () => {
  it('computes an hourly month from the class pay snapshots (B5 declined, B22 trial, B23 extra, holiday, boundaries)', async () => {
    const teacher = await m6Teacher(ctx, { hourlyRate: '300.00' });
    const e = await m6Enrollment(ctx, teacher);
    const oct = Period.parse('2026-10');
    const z = 'Africa/Cairo';
    const at = (ms: number) => new Date(ms).toISOString();

    await m6Session(ctx, e, at(oct.fromUtc(z).getTime() + 30 * 60_000), 'taken'); // 1 Oct 00:30 Cairo → October, 0.5
    await m6Session(ctx, e, at(oct.fromUtc(z).getTime() - 30 * 60_000), 'taken'); // 30 Sep 23:30 Cairo → September
    await m6Session(ctx, e, '2026-10-05T10:00:00Z', 'taken'); // 0.5
    await m6Session(ctx, e, '2026-10-06T10:00:00Z', 'taken', { durationMinutes: 60 }); // 1.0
    await m6Session(ctx, e, '2026-10-07T10:00:00Z', 'absent'); // 0.5
    await m6Session(ctx, e, '2026-10-08T10:00:00Z', 'declined'); // 0.5 (B5)
    await m6Session(ctx, e, '2026-10-09T10:00:00Z', 'leave', { stageReason: 'student' }); // 0
    await m6Session(ctx, e, '2026-10-10T10:00:00Z', 'taken', { kind: 'trial' }); // 0 (B22)
    await m6Session(ctx, e, '2026-10-11T10:00:00Z', 'taken', { kind: 'extra' }); // 0.5 (B23)
    await m6Session(ctx, e, '2026-10-12T10:00:00Z', 'cancelled', { stageReason: 'holiday' }); // 0.5 paid holiday
    await m6Session(ctx, e, '2026-10-13T10:00:00Z', 'cancelled', { stageReason: 'admin' }); // 0
    await m6Session(ctx, e, '2026-10-14T10:00:00Z', 'moved_out', { stageReason: 'rescheduled' }); // 0
    await m6Session(ctx, e, '2026-10-15T10:00:00Z', 'scheduled'); // unmarked → warning
    await m6Session(ctx, e, at(oct.toUtc(z).getTime() + 30 * 60_000), 'taken'); // 1 Nov 00:30 Cairo → November

    const res = await accounts.post('/payroll/runs', { period: '2026-10' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'draft', people: 1 });

    const slip = await m6Slip(ctx, teacher.userId);
    expect(slip.paidHours.toFixed(2)).toBe('4.00');
    expect(slip.paidClasses).toBe(7);
    expect(m6Lines(slip)).toEqual({ hour_earning: '1200.00' });
    expect(slip.net.toFixed(2)).toBe('1200.00');
    expect(slip.currency).toBe('PKR');
    expect(
      (slip.warnings as Array<{ code: string; count?: number }>).find(
        (w) => w.code === 'unmarked_sessions',
      )?.count,
    ).toBe(1);
    expect(await ctx.prisma.payslipSession.count({ where: { payslipId: slip.id } })).toBe(7);
  });

  it('rounds an hourly line half-up once (3.33 per hour × 0.5 h = 1.67)', async () => {
    const teacher = await m6Teacher(ctx, { hourlyRate: '3.33' });
    await m6Session(ctx, await m6Enrollment(ctx, teacher), '2026-10-05T10:00:00Z', 'taken');
    await runOctober();
    expect((await m6Slip(ctx, teacher.userId)).net.toFixed(2)).toBe('1.67');
  });

  it('computes a monthly salary with allowance, tax, every adjustment type and the /30 leave deduction', async () => {
    const { user: employee } = await userWithRole(ctx, 'monitor');
    await m6Profile(ctx, employee.id, {
      salaryType: 'monthly',
      currency: 'EGP',
      hourlyRate: '0',
      monthlySalary: '30000.00',
      allowance: '5000.00',
      tax: '1000.00',
    });
    // Attendance: 1 absent + 2 unpaid leave days deduct; a paid (sick) leave day does not.
    const day = (d: string) => new Date(`${d}T00:00:00Z`);
    await ctx.prisma.staffAttendance.createMany({
      data: [
        { userId: employee.id, workDate: day('2026-10-04'), status: 'absent', source: 'staff' },
        {
          userId: employee.id,
          workDate: day('2026-10-05'),
          status: 'leave',
          paidLeave: false,
          source: 'leave',
        },
        {
          userId: employee.id,
          workDate: day('2026-10-06'),
          status: 'leave',
          paidLeave: false,
          source: 'leave',
        },
        {
          userId: employee.id,
          workDate: day('2026-10-07'),
          status: 'leave',
          paidLeave: true,
          source: 'leave',
        },
        { userId: employee.id, workDate: day('2026-11-02'), status: 'absent', source: 'staff' }, // other month
      ],
    });

    // Fines come from the fines workflow (manager); the rest from Accounts.
    const { client: manager } = await userWithRole(ctx, 'manager');
    const fine = await manager.post('/payroll/adjustments', {
      userId: employee.id,
      type: 'fine',
      amount: '500.00',
      effectiveOn: '2026-10-20',
      reason: 'Late twice',
    });
    expect(fine.body.data.status).toBe('approved');
    for (const [type, amount] of [
      ['bonus', '2000.00'],
      ['advance', '10000.00'],
      ['gift', '100.00'],
      ['other_deduction', '50.00'],
      ['arrears', '70.00'],
      ['other_addition', '30.00'],
    ]) {
      const res = await accounts.post('/payroll/adjustments', {
        userId: employee.id,
        type,
        amount,
        effectiveOn: '2026-10-20',
        reason: `October ${type}`,
      });
      expect(res.status, type).toBe(201);
      expect(res.body.data).toMatchObject({ status: 'approved', currency: 'EGP' });
    }
    // A proposed fine does not count yet (warning only).
    await ctx.prisma.payAdjustment.create({
      data: {
        userId: employee.id,
        type: 'fine',
        amount: '999.99',
        currency: 'EGP',
        effectiveOn: day('2026-10-21'),
        reason: 'proposed',
        status: 'proposed',
      },
    });

    await runOctober();
    const slip = await m6Slip(ctx, employee.id);
    expect(m6Lines(slip)).toEqual({
      monthly_salary: '30000.00',
      allowance: '5000.00',
      fine: '-500.00',
      bonus: '2000.00',
      advance: '-10000.00',
      gift: '100.00',
      other_deduction: '-50.00',
      arrears: '70.00',
      other_addition: '30.00',
      leave_deduction: '-3000.00',
      tax: '-1000.00',
    });
    expect(slip.deductionDays).toBe(3);
    expect(slip.earnings.toFixed(2)).toBe('37200.00');
    expect(slip.deductions.toFixed(2)).toBe('14550.00');
    expect(slip.net.toFixed(2)).toBe('22650.00');
    expect(
      (slip.warnings as Array<{ code: string; count?: number }>).find(
        (w) => w.code === 'fines_pending',
      )?.count,
    ).toBe(1);
  });

  it('computes a per-class month: classes with pay hours × class rate', async () => {
    const teacher = await m6Teacher(ctx, {
      salaryType: 'per_class',
      classRate: '250.00',
      hourlyRate: '0',
    });
    const e = await m6Enrollment(ctx, teacher);
    await m6Session(ctx, e, '2026-10-05T10:00:00Z', 'taken');
    await m6Session(ctx, e, '2026-10-06T10:00:00Z', 'taken', { durationMinutes: 60 });
    await m6Session(ctx, e, '2026-10-07T10:00:00Z', 'absent');
    await m6Session(ctx, e, '2026-10-08T10:00:00Z', 'declined');
    await m6Session(ctx, e, '2026-10-09T10:00:00Z', 'leave', { stageReason: 'teacher' });
    await runOctober();
    const slip = await m6Slip(ctx, teacher.userId);
    expect(m6Lines(slip)).toEqual({ class_earning: '1000.00' });
    expect(slip.lines[0]!.quantity!.toFixed(2)).toBe('4.00');
    expect(slip.lines[0]!.rate!.toFixed(2)).toBe('250.00');
  });

  it('computes a per-slot month with the old flat tier rule', async () => {
    const tiers = [
      { minSlots: 0, amount: '100.00' },
      { minSlots: 2, amount: '500.00' },
      { minSlots: 4, amount: '900.00' },
    ];
    const teacher = await m6Teacher(ctx, { salaryType: 'slot', slotTiers: tiers, hourlyRate: '0' });
    const e = await m6Enrollment(ctx, teacher);
    for (let day = 1; day <= 6; day++) {
      await m6Session(ctx, e, `2026-10-${String(day + 1).padStart(2, '0')}T10:00:00Z`, 'taken'); // 6 × 0.5 = 3 slots
    }
    await runOctober();
    expect(m6Lines(await m6Slip(ctx, teacher.userId))).toEqual({ slot_earning: '500.00' });
    // Exactly on a threshold takes that tier.
    expect(slotTier(tiers, 400)).toBe(90000);
    expect(slotTier(tiers, 399)).toBe(50000);
    expect(slotTier([], 400)).toBeNull();
  });

  it('adds CSR commission as conversions × the CSR rate (B46)', async () => {
    const { user: csr } = await userWithRole(ctx, 'csr');
    await m6Profile(ctx, csr.id, {
      salaryType: 'monthly',
      currency: 'EGP',
      hourlyRate: '0',
      monthlySalary: '10000.00',
      csrRate: '500.00',
    });
    const res = await accounts.post('/payroll/adjustments', {
      userId: csr.id,
      type: 'csr_conversions',
      quantity: 3,
      effectiveOn: '2026-10-31',
      reason: '3 families became regular',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ amount: '1500.00', quantity: 3 });
    await runOctober();
    expect(m6Lines(await m6Slip(ctx, csr.id))).toEqual({
      monthly_salary: '10000.00',
      csr_conversions: '1500.00',
    });
    // No CSR rate → 422 no_csr_rate; no quantity → 422.
    await m6Profile(ctx, csr.id, { salaryType: 'monthly', monthlySalary: '1.00', csrRate: '0' });
    const none = await accounts.post('/payroll/adjustments', {
      userId: csr.id,
      type: 'csr_conversions',
      quantity: 1,
      effectiveOn: '2026-11-01',
      reason: 'one more',
    });
    expect(none.body.code).toBe('no_csr_rate');
    const noQty = await accounts.post('/payroll/adjustments', {
      userId: csr.id,
      type: 'csr_conversions',
      effectiveOn: '2026-11-01',
      reason: 'one more',
    });
    expect(noQty.status).toBe(422);
    expect(noQty.body.errors).toHaveProperty('quantity');
  });

  it('defines the month in the academy zone', async () => {
    const p = Period.parse('2026-10');
    expect(p.fromUtc('Africa/Cairo').toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(p.toUtc('Africa/Cairo').toISOString()).toBe('2026-10-31T22:00:00.000Z'); // DST ended 30 Oct
    expect(p.endsOn()).toBe('2026-10-31');
    expect(await ctx.prisma.payrollRun.count()).toBe(0);
  });
});

describe('pay rule engine (D41)', () => {
  const engine = () => ctx.app.get(PayRuleEngine);
  const pay = (attrs: {
    kind?: string;
    stage: string;
    stageReason?: string | null;
    startsAt?: string;
  }) =>
    engine().snapshot({
      kind: attrs.kind ?? 'regular',
      stage: attrs.stage,
      stageReason: attrs.stageReason ?? null,
      durationMinutes: 30,
      startsAt: new Date(attrs.startsAt ?? '2026-11-10T15:00:00Z'),
    });

  it.each([
    ['taken', 'regular', 'taken', null, '0.50', true, 'taken'],
    ['absent', 'regular', 'absent', null, '0.50', true, 'absent'],
    ['declined', 'regular', 'declined', null, '0.50', true, 'declined'],
    ['leave', 'regular', 'leave', 'student', '0.00', false, 'leave'],
    ['cancelled admin', 'regular', 'cancelled', 'admin', '0.00', false, 'cancelled'],
    ['trial taken', 'trial', 'taken', null, '0.00', false, 'trial:*'],
    ['extra taken', 'extra', 'taken', null, '0.50', true, 'taken'],
    ['moved out', 'regular', 'moved_out', 'rescheduled', '0.00', false, 'moved_out'],
  ])('applies the seeded rules: %s', async (_n, kind, stage, reason, hours, billable, key) => {
    const s = await pay({ kind, stage, stageReason: reason });
    expect(s).toMatchObject({ payHours: hours, billable, payRuleKey: key });
  });

  it('uses the seeded set #1 of the migration (and the built-in defaults when no set exists)', async () => {
    expect((await pay({ stage: 'taken' })).payRuleSetId).toBeNull(); // tables are truncated in tests
    const set = await ctx.prisma.payRuleSet.create({
      data: {
        effectiveFrom: new Date('2000-01-01T00:00:00Z'),
        rules: { taken: { factor: 1, billable: true } },
      },
    });
    expect((await pay({ stage: 'taken' })).payRuleSetId).toBe(set.id);
  });

  it('pays a holiday only when the holiday is paid', async () => {
    const h = await ctx.prisma.holiday.create({
      data: { name: 'Eid', date: new Date('2026-11-10T00:00:00Z'), paid: true },
    });
    expect((await pay({ stage: 'cancelled', stageReason: 'holiday' })).payHours).toBe('0.50');
    await ctx.prisma.holiday.update({ where: { id: h.id }, data: { paid: false } });
    expect((await pay({ stage: 'cancelled', stageReason: 'holiday' })).payHours).toBe('0.00');
  });

  it('uses the rule set in force at the class time, so new sets never rewrite history', async () => {
    await ctx.prisma.payRuleSet.create({
      data: {
        effectiveFrom: new Date('2000-01-01T00:00:00Z'),
        rules: { taken: { factor: 1, billable: true } },
      },
    });
    await ctx.prisma.payRuleSet.create({
      data: {
        effectiveFrom: new Date('2026-12-01T00:00:00Z'),
        rules: { taken: { factor: 2, billable: true } },
      },
    });
    expect((await pay({ stage: 'taken' })).payHours).toBe('0.50');
    expect((await pay({ stage: 'taken', startsAt: '2026-12-02T10:00:00Z' })).payHours).toBe('1.00');
  });

  it('prefers kind-specific keys over stage keys', async () => {
    await ctx.prisma.payRuleSet.create({
      data: {
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        rules: {
          'trial:taken': { factor: 1, billable: false },
          'trial:*': { factor: 0, billable: false },
          taken: { factor: 1, billable: true },
        },
      },
    });
    expect((await pay({ kind: 'trial', stage: 'taken' })).payRuleKey).toBe('trial:taken');
    expect((await pay({ kind: 'trial', stage: 'absent' })).payRuleKey).toBe('trial:*');
  });

  it('makes pay rule sets immutable', async () => {
    const set = await ctx.prisma.payRuleSet.create({
      data: { effectiveFrom: new Date('2026-01-01T00:00:00Z'), rules: {} },
    });
    await expect(
      ctx.prisma.payRuleSet.update({ where: { id: set.id }, data: { note: 'x' } }),
    ).rejects.toThrow(/append-only/);
  });

  it('snapshots pay when the state machine decides a class and clears it on revert', async () => {
    const teacher = await m2Teacher(ctx);
    const e = await m2Enrollment(ctx, await m2Student(ctx), teacher);
    const s = await m2Session(ctx, e, '2026-11-15T06:00:00Z', {
      activatedAt: '2026-11-15T06:00:00Z',
      stage: 'activated',
    });
    const { client: staff } = await signedIn(ctx, 'admin');
    const marked = await staff.post(`/sessions/${s.id}/transitions`, {
      action: 'mark_absent',
      expectedStage: 'activated',
      note: 'No show',
    });
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);
    let row = await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: s.id } });
    expect([row.payHours?.toFixed(2), row.payRuleKey, row.billable]).toEqual([
      '0.50',
      'absent',
      true,
    ]);
    expect((await staff.get(`/sessions/${s.id}`)).body.data.pay).toEqual({
      hours: '0.50',
      ruleKey: 'absent',
      billable: true,
    });
    const family = await ctx.prisma.family.findFirstOrThrow({ include: { user: true } });
    const parent = await signInAs(ctx, family.user);
    expect((await parent.get(`/sessions/${s.id}`)).body.data).not.toHaveProperty('pay');
    const reverted = await staff.post(`/sessions/${s.id}/transitions`, {
      action: 'revert',
      expectedStage: 'absent',
      reason: 'Wrong class',
    });
    expect(reverted.status).toBe(200);
    row = await ctx.prisma.classSession.findUniqueOrThrow({ where: { id: s.id } });
    expect([row.payHours, row.payRuleKey, row.billable]).toEqual([null, null, null]);
  });

  it('snapshots a class the generator creates cancelled on a paid holiday', async () => {
    const teacher = await m2Teacher(ctx);
    const e = await m2Enrollment(ctx, await m2Student(ctx, 'Africa/Cairo'), teacher);
    await m2Slot(ctx, e, 1, '10:00'); // Mondays
    await ctx.prisma.holiday.create({
      data: { name: 'Holiday', date: new Date('2026-11-16T00:00:00Z'), paid: true },
    });
    await ctx.app.get(SessionGenerator).run({ from: '2026-11-16', to: '2026-11-16' });
    const row = await ctx.prisma.classSession.findFirstOrThrow({ where: { enrollmentId: e.id } });
    expect(row.stage).toBe('cancelled');
    expect([row.payHours?.toFixed(2), row.payRuleKey]).toEqual(['0.50', 'cancelled:holiday']);
  });
});

describe('pay rule sets API', () => {
  it('lists the versions and adds one from today or later (never edits)', async () => {
    const { client: admin } = await signedIn(ctx, 'admin');
    const past = await admin.post('/pay-rule-sets', {
      effectiveFrom: '2026-11-01T00:00:00Z',
      rules: { taken: { factor: 1, billable: true } },
    });
    expect(past.status).toBe(422);
    expect(past.body.errors).toHaveProperty('effectiveFrom');
    const badKey = await admin.post('/pay-rule-sets', {
      effectiveFrom: '2026-12-01T00:00:00Z',
      rules: { 'Taken!': { factor: 1, billable: true } },
    });
    expect(badKey.status).toBe(422);
    const created = await admin.post('/pay-rule-sets', {
      effectiveFrom: '2026-12-01T00:00:00Z',
      rules: { taken: { factor: 1.5, billable: true } },
      note: 'Raise',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.rules).toEqual({
      taken: { factor: 1.5, billable: true },
      default: { factor: 0, billable: false },
    });
    const list = await admin.get('/pay-rule-sets');
    expect(list.body.data).toHaveLength(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'pay_rule_set_created' } })).toBe(1);
    const { client: teacherClient } = await (async () => {
      const t = await m6Teacher(ctx);
      return { client: await signInAs(ctx, t.user) };
    })();
    expect((await teacherClient.get('/pay-rule-sets')).status).toBe(403);
  });
});
