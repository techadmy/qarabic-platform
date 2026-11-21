import request from 'supertest';
import { teacherMonthSchema } from '@qarabic/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Client,
  createTestApp,
  makeFamily,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';
import { m6At, m6Enrollment, m6Session, m6Teacher, userWithRole } from './payroll-helpers.js';

/*
 * D155: «ساعاتي هذا الشهر» on the teacher home — `GET /teacher-portal/month`. The signed-in
 * teacher's own payroll month so far: paid classes, hours as the payroll run counts them, and the
 * payroll calculator's expected net (null with no salary profile). Never another teacher's data.
 */

let ctx: TestContext;
let accounts: Client;
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
  teacher = await m6Teacher(ctx, { hourlyRate: '300.00' });
  const e = await m6Enrollment(ctx, teacher);
  await m6Session(ctx, e, '2026-10-30T10:00:00Z', 'taken'); // last month: not counted
  await m6Session(ctx, e, '2026-11-02T10:00:00Z', 'taken');
  await m6Session(ctx, e, '2026-11-03T10:00:00Z', 'taken');
  await m6Session(ctx, e, '2026-11-04T10:00:00Z', 'absent');
  await m6Session(ctx, e, '2026-11-20T10:00:00Z', 'scheduled'); // not held yet
});

describe('GET /teacher-portal/month (D155)', () => {
  it('answers 401 without a session and 403 to a parent, staff and a user with no role', async () => {
    const anon = await request(ctx.app.getHttpServer()).get('/api/v1/teacher-portal/month');
    expect(anon.status).toBe(401);
    const family = await makeFamily(ctx);
    const parent = await signInAs(ctx, family.user);
    expect((await parent.get('/teacher-portal/month')).status).toBe(403);
    expect((await accounts.get('/teacher-portal/month')).status).toBe(403);
    const { client: nobody } = await signedIn(ctx, null);
    expect((await nobody.get('/teacher-portal/month')).status).toBe(403);
  });

  it('gives the teacher their own month, with hours and pay exactly as the payroll preview', async () => {
    // Another teacher's classes the same month never leak in.
    const other = await m6Teacher(ctx, { hourlyRate: '900.00' });
    const oe = await m6Enrollment(ctx, other);
    await m6Session(ctx, oe, '2026-11-05T10:00:00Z', 'taken');
    await m6Session(ctx, oe, '2026-11-06T10:00:00Z', 'taken');
    await m6Session(ctx, oe, '2026-11-07T10:00:00Z', 'taken');

    const t = await signInAs(ctx, teacher.user);
    const res = await t.get('/teacher-portal/month');
    expect(res.status).toBe(200);
    const month = teacherMonthSchema.parse(res.body.data);

    const preview = await accounts.get('/payroll/runs/preview?period=2026-11');
    expect(preview.status).toBe(200);
    const slip = (
      preview.body.data.payslips as Array<{
        user: { id: number };
        paidHours: string;
        paidClasses: number;
        net: string;
        currency: string;
      }>
    ).find((s) => s.user.id === teacher.userId)!;

    expect(month).toEqual({
      month: '2026-11',
      classesHeld: slip.paidClasses,
      hours: slip.paidHours,
      expectedPay: { amount: slip.net, currency: slip.currency },
      final: false,
    });
    // The two taken classes and the absent one (the teacher waited, D41) are paid; the future
    // one and last month's are not.
    expect(month.classesHeld).toBe(3);
    expect(Number(month.hours)).toBeGreaterThan(0);
    // Only the documented keys: no names, no other teachers, no academy money.
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['classesHeld', 'expectedPay', 'final', 'hours', 'month'].sort(),
    );

    const o = await signInAs(ctx, other.user);
    const theirs = (await o.get('/teacher-portal/month')).body.data;
    expect(theirs.classesHeld).toBe(3);
    expect(theirs.expectedPay.amount).not.toBe(month.expectedPay!.amount);
  });

  it('shows hours but no expected pay when the teacher has no salary profile or rate', async () => {
    await ctx.prisma.payProfile.update({
      where: { userId: teacher.userId },
      data: { active: false },
    });
    const t = await signInAs(ctx, teacher.user);
    const off = (await t.get('/teacher-portal/month')).body.data;
    expect(off).toMatchObject({
      month: '2026-11',
      classesHeld: 3,
      expectedPay: null,
      final: false,
    });

    await ctx.prisma.payProfile.update({
      where: { userId: teacher.userId },
      data: { active: true, hourlyRate: '0' },
    });
    const noRate = (await t.get('/teacher-portal/month')).body.data;
    expect(noRate.expectedPay).toBeNull();
    expect(noRate.hours).toBe(off.hours);
  });
});
