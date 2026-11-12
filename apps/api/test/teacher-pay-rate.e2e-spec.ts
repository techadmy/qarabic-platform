import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SettingsService } from '../src/settings/settings.service.js';
import { createTestApp, makeTeacher, resetState, signedIn, type TestContext } from './helpers.js';
import { m6Profile } from './payroll-helpers.js';

/*
| Port of Laravel tests/Feature/People/TeacherPayRateTest.php (+ the People parts of
| PilotPeopleGapsTest.php). A teacher's hourly rate has one source of truth: the pay profile (D89).
| The teacher form reads / writes it, and the rate always carries its currency (EGP by default) so
| the app never shows "$120" for 120 EGP. N7 moved `teachers.hourly_rate` into `pay_profiles`.
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

const payload = (overrides: Record<string, unknown> = {}) => ({
  firstName: 'Omar',
  lastName: 'Hassan',
  email: 'omar.rate@example.com',
  phone: '+201001234999',
  timezone: 'Africa/Cairo',
  ...overrides,
});

const profileOf = async (teacherId: number) => {
  const t = await ctx.prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
  return ctx.prisma.payProfile.findUnique({ where: { userId: t.userId } });
};

describe('teacher hourly rate (pay profile)', () => {
  it('writes the hourly rate to an EGP pay profile when a teacher is created', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const res = await client.post('/teachers', payload({ hourlyRate: 120 }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ hourlyRate: '120.00', hourlyRateCurrency: 'EGP' });
    const profile = await profileOf(res.body.data.id);
    expect(profile).toMatchObject({
      salaryType: 'hourly',
      currency: 'EGP',
      teacherId: res.body.data.id,
    });
    expect(profile!.hourlyRate.toFixed(2)).toBe('120.00');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'salary_profile_saved' } })).toBe(1);
  });

  it('updates the pay profile rate from the teacher form, always in EGP, and leaves it alone otherwise', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const id = (await client.post('/teachers', payload({ hourlyRate: 120 }))).body.data.id;

    const edit = await client.patch(`/teachers/${id}`, {
      hourlyRate: '150.5',
      hourlyRateCurrency: 'egp',
    });
    expect(edit.status).toBe(200);
    expect(edit.body.data).toMatchObject({ hourlyRate: '150.50', hourlyRateCurrency: 'EGP' });
    expect((await profileOf(id))!.hourlyRate.toFixed(2)).toBe('150.50');

    const other = await client.patch(`/teachers/${id}`, { lastName: 'Hasan' });
    expect(other.body.data).toMatchObject({ hourlyRate: '150.50', hourlyRateCurrency: 'EGP' });
    expect(await ctx.prisma.payProfile.count()).toBe(1);
  });

  it('never sets a non-EGP currency from People; only the salary profile screen can', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const id = (await client.post('/teachers', payload({ hourlyRate: 120 }))).body.data.id;
    const teacher = await ctx.prisma.teacher.findUniqueOrThrow({ where: { id } });

    const pkr = await client.patch(`/teachers/${id}`, {
      hourlyRate: 150,
      hourlyRateCurrency: 'PKR',
    });
    expect(pkr.status).toBe(422);
    expect(pkr.body.errors).toHaveProperty('hourlyRateCurrency');
    expect((await profileOf(id))!.currency).toBe('EGP');

    // payroll.manage sets PKR explicitly; a later rate edit from People keeps it.
    const saved = await client.put(`/salary-profiles/${teacher.userId}`, {
      salaryType: 'hourly',
      currency: 'PKR',
      hourlyRate: '700.00',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.teacherId).toBe(id);
    const edit = await client.patch(`/teachers/${id}`, { hourlyRate: 800 });
    expect(edit.body.data).toMatchObject({ hourlyRate: '800.00', hourlyRateCurrency: 'PKR' });
    const profile = await profileOf(id);
    expect([profile!.currency, profile!.hourlyRate.toFixed(2)]).toEqual(['PKR', '800.00']);
  });

  it('refuses an unknown or non-EGP currency, and a bad amount', async () => {
    const { client } = await signedIn(ctx, 'admin');
    for (const currency of ['XYZ', 'USD', 'PKR', 'eg']) {
      const res = await client.post('/teachers', payload({ hourlyRateCurrency: currency }));
      expect(res.status, currency).toBe(422);
      expect(res.body.errors).toHaveProperty('hourlyRateCurrency');
    }
    for (const rate of [-1, '12.345', 'abc', 100_001]) {
      const res = await client.post('/teachers', payload({ hourlyRate: rate }));
      expect(res.status, String(rate)).toBe(422);
      expect(res.body.errors).toHaveProperty('hourlyRate');
    }
  });

  it('allows no rate (no empty profile), and clearing it', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const res = await client.post('/teachers', payload({ hourlyRate: null }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ hourlyRate: null, hourlyRateCurrency: 'EGP' });
    expect(await profileOf(res.body.data.id)).toBeNull();
    const set = await client.patch(`/teachers/${res.body.data.id}`, { hourlyRate: 90 });
    expect(set.body.data.hourlyRate).toBe('90.00');
    const cleared = await client.patch(`/teachers/${res.body.data.id}`, { hourlyRate: '' });
    expect(cleared.body.data.hourlyRate).toBeNull();
    expect((await profileOf(res.body.data.id))!.hourlyRate.toFixed(2)).toBe('0.00');
  });

  it('keeps a monthly profile monthly when the rate is edited from People', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const teacher = await makeTeacher(ctx);
    await m6Profile(ctx, teacher.userId, {
      teacherId: teacher.id,
      salaryType: 'monthly',
      currency: 'EGP',
      monthlySalary: '8000.00',
      hourlyRate: '0',
    });
    const res = await client.patch(`/teachers/${teacher.id}`, { hourlyRate: 50 });
    expect(res.body.data).toMatchObject({ hourlyRate: '50.00', hourlyRateCurrency: 'EGP' });
    const profile = await profileOf(teacher.id);
    expect(profile!.salaryType).toBe('monthly');
    expect(profile!.monthlySalary.toFixed(2)).toBe('8000.00');
  });

  it('reads a pay profile without a currency as EGP and fills it in on the next edit', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const teacher = await makeTeacher(ctx);
    await m6Profile(ctx, teacher.userId, {
      teacherId: teacher.id,
      currency: null,
      hourlyRate: '120.00',
    });
    expect((await client.get(`/teachers/${teacher.id}`)).body.data).toMatchObject({
      hourlyRate: '120.00',
      hourlyRateCurrency: 'EGP',
    });
    expect((await client.get(`/salary-profiles/${teacher.userId}`)).body.data.currency).toBe('EGP');
    expect((await client.get('/teachers')).body.data[0].hourlyRateCurrency).toBe('EGP');
    await client.patch(`/teachers/${teacher.id}`, { hourlyRate: 125 });
    expect((await profileOf(teacher.id))!.currency).toBe('EGP');
  });

  it('follows the academy pay currency setting', async () => {
    await ctx.app.get(SettingsService).set('payroll.default_currency', 'PKR', null);
    const { client } = await signedIn(ctx, 'admin');
    expect((await client.post('/teachers', payload({ hourlyRateCurrency: 'EGP' }))).status).toBe(
      422,
    );
    const res = await client.post('/teachers', payload({ hourlyRate: 800 }));
    expect(res.body.data.hourlyRateCurrency).toBe('PKR');
    expect((await client.get('/people/lookups')).body.data.defaultPayCurrency).toBe('PKR');
  });
});
