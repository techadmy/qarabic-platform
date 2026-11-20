import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PasswordsService } from '../src/auth/passwords.service.js';
import { InvoiceService } from '../src/billing/invoices.service.js';
import { MailGateway } from '../src/mail/mailer.js';
import { Period } from '../src/payroll/period.js';
import { PayrollRunsService } from '../src/payroll/runs.service.js';
import {
  DEMO_PERSONAS,
  DemoAccountsError,
  ensureDemoAccounts,
} from '../src/people/demo-accounts.js';
import { SessionJobs } from '../src/sessions/jobs.js';
import {
  clock,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  makeCourse,
  PASSWORD,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';
import { m6Profile } from './payroll-helpers.js';
import { billingFamily, makeFeePackage, resetBilling } from './n6-helpers.js';

/*
| D153: the permanent demo accounts (`cli demo:accounts`). Safe to re-run, only ever on
| `@demo.qarabic.test`, and kept out of the dashboard, payroll, invoicing and outbound mail.
*/

let ctx: TestContext;
let hash: string;
beforeAll(async () => {
  ctx = await createTestApp();
  hash = await new PasswordsService().hash(PASSWORD);
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await resetState(ctx);
  resetBilling(ctx);
  clock(ctx).set('2026-11-02T09:00:00Z');
  await makeCourse(ctx, { category: 'regular' });
});

const ensure = (personas = DEMO_PERSONAS) =>
  ensureDemoAccounts(ctx.prisma, hash, clock(ctx).nowMs(), personas);

/** Row counts of everything the script writes. */
const snapshot = async () => ({
  users: await ctx.prisma.user.count(),
  teachers: await ctx.prisma.teacher.count(),
  payProfiles: await ctx.prisma.payProfile.count(),
  families: await ctx.prisma.family.count(),
  students: await ctx.prisma.student.count(),
  enrollments: await ctx.prisma.enrollment.count(),
  slots: await ctx.prisma.scheduleSlot.count(),
});

const demoTeacher = () =>
  ctx.prisma.teacher.findFirstOrThrow({ where: { user: { email: DEMO_PERSONAS.teacher.email } } });
const demoFamily = () =>
  ctx.prisma.family.findFirstOrThrow({
    where: { user: { email: DEMO_PERSONAS.parent.email } },
    include: { students: true },
  });

describe('demo:accounts script', () => {
  it('creates the teacher, the family, two students and their weekly classes, all flagged demo', async () => {
    const result = await ensure();
    expect(result.created).toEqual(
      expect.arrayContaining([DEMO_PERSONAS.teacher.email, DEMO_PERSONAS.parent.email]),
    );
    const users = await ctx.prisma.user.findMany({ include: { role: true } });
    expect(users.map((u) => [u.email, u.role?.name, u.isDemo]).sort()).toEqual(
      [
        [DEMO_PERSONAS.parent.email, 'parent', true],
        [DEMO_PERSONAS.teacher.email, 'teacher', true],
      ].sort(),
    );
    const family = await demoFamily();
    expect(family.students.map((s) => s.name).sort()).toEqual(['طالب تجريبي 1', 'طالب تجريبي 2']);
    const teacher = await demoTeacher();
    expect(teacher.zoomJoinUrl).toBeNull();
    const enrollments = await ctx.prisma.enrollment.findMany({ include: { slots: true } });
    expect(enrollments).toHaveLength(2);
    for (const e of enrollments) {
      expect(e).toMatchObject({ teacherId: teacher.id, status: 'active', sessionMinutes: 30 });
      expect(e.slots).toHaveLength(2);
      expect(e.slots.every((s) => s.timezone === 'Africa/Cairo')).toBe(true);
    }
    const pay = await ctx.prisma.payProfile.findUniqueOrThrow({
      where: { userId: teacher.userId },
    });
    expect(pay.salaryType).toBe('hourly');

    // Both log in with the password given; the class generator makes their classes.
    for (const email of [DEMO_PERSONAS.teacher.email, DEMO_PERSONAS.parent.email]) {
      await signInAs(ctx, { email });
    }
    await ctx.app.get(SessionJobs).generate();
    expect(
      await ctx.prisma.classSession.count({ where: { teacherId: teacher.id } }),
    ).toBeGreaterThan(0);
  });

  it('is idempotent: a second run creates nothing and changes no counts', async () => {
    await ensure();
    const before = await snapshot();
    const again = await ensure();
    expect(again.created).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('puts drifted demo records back in shape and leaves other records alone', async () => {
    const { user: real } = await signedIn(ctx, 'admin');
    await ensure();
    const family = await demoFamily();
    const teacher = await demoTeacher();
    await ctx.prisma.user.update({ where: { id: teacher.userId }, data: { isActive: false } });
    await ctx.prisma.student.update({
      where: { id: family.students[0]!.id },
      data: { archivedAt: new Date(), archiveReason: 'drift' },
    });
    await ctx.prisma.family.update({ where: { id: family.id }, data: { status: 'suspended' } });
    const realBefore = await ctx.prisma.user.findUniqueOrThrow({ where: { id: real.id } });

    await ensure();
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: teacher.userId } })).isActive,
    ).toBe(true);
    const repaired = await demoFamily();
    expect(repaired.status).toBe('regular');
    expect(repaired.students.every((s) => s.archivedAt === null)).toBe(true);
    expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: real.id } })).toEqual(realBefore);
  });

  it('refuses any address outside @demo.qarabic.test and writes nothing', async () => {
    const before = await snapshot();
    for (const personas of [
      { ...DEMO_PERSONAS, teacher: { ...DEMO_PERSONAS.teacher, email: 'teacher@qarabic.com' } },
      {
        ...DEMO_PERSONAS,
        parent: { ...DEMO_PERSONAS.parent, email: 'demo@demo.qarabic.test.evil.com' },
      },
    ]) {
      await expect(ensure(personas)).rejects.toBeInstanceOf(DemoAccountsError);
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe('demo records are left out (D153)', () => {
  it('of the dashboard numbers', async () => {
    await ensure();
    const teacher = await m2Teacher(ctx);
    const real = await m2Enrollment(ctx, await m2Student(ctx), teacher, { startsOn: '2026-11-01' });
    await m2Session(ctx, real, '2026-11-02T10:00:00Z', { stage: 'taken' });
    const demo = await ctx.prisma.enrollment.findFirstOrThrow({
      where: { teacherId: (await demoTeacher()).id },
    });
    await m2Session(ctx, demo, '2026-11-03T10:00:00Z', { stage: 'taken' });
    await m2Session(ctx, demo, '2026-11-04T10:00:00Z', { stage: 'absent' });

    const { client: admin } = await signedIn(ctx, 'admin');
    const d = (await admin.get('/dashboard/metrics?from=2026-11-01&to=2026-11-30')).body.data;
    expect(d.kpis.active_students.value).toBe(1);
    expect(d.kpis.teachers_on_duty.value).toBe(1);
    expect(d.kpis.attendance_rate.value).toBe(1); // the demo absence does not count
    expect(d.kpis.new_students.value).toBe(1);
    const outcomes = d.series.class_outcomes as Array<{ taken: number; absent: number }>;
    expect(outcomes.reduce((s, p) => s + p.taken + p.absent, 0)).toBe(1);
  });

  it('of payroll runs', async () => {
    await ensure();
    const teacher = await m2Teacher(ctx);
    await m6Profile(ctx, teacher.userId, { teacherId: teacher.id });
    const preview = await ctx.app
      .get(PayrollRunsService)
      .preview(Period.parse('2026-11'), undefined);
    const ids = preview.payslips.map((p) => p.user.id);
    expect(ids).toContain(teacher.userId);
    expect(ids).not.toContain((await demoTeacher()).userId);
  });

  it('of invoice generation', async () => {
    await ensure();
    const pkg = await makeFeePackage(ctx, { USD: '60.00' });
    const real = await billingFamily(ctx, 'USD', [pkg]);
    const family = await demoFamily();
    await ctx.prisma.familyBillingProfile.create({
      data: { familyId: family.id, currency: 'USD', billingDay: 1, enabled: true },
    });
    for (const s of family.students) {
      await ctx.prisma.studentFeePackage.create({
        data: { studentId: s.id, feePackageId: pkg.id },
      });
    }
    const rows = await ctx.app.get(InvoiceService).preview('2026-12', 1);
    expect(rows.map((r) => r.familyId)).toEqual([real.id]);
  });

  it('of outbound mail', async () => {
    const mail = ctx.app.get(MailGateway);
    await mail.send({ to: DEMO_PERSONAS.parent.email, subject: 's', text: 't', kind: 'test' });
    await mail.send({
      to: 'Demo-Teacher@DEMO.qarabic.test',
      subject: 's',
      text: 't',
      kind: 'test',
    });
    expect(ctx.mailer.sent).toHaveLength(0);
    await mail.send({ to: 'someone@example.com', subject: 's', text: 't', kind: 'test' });
    expect(ctx.mailer.sent).toHaveLength(1);
  });
});
