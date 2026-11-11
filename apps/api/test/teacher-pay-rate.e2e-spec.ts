import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SettingsService } from '../src/settings/settings.service.js';
import { createTestApp, resetState, signedIn, type TestContext } from './helpers.js';

/*
| Port of Laravel tests/Feature/People/TeacherPayRateTest.php and the People parts of
| PilotPeopleGapsTest.php: the hourly rate on the teacher form always carries its currency, EGP by
| default, and People never sets another currency. Pay profiles and the payroll run that reads them
| arrive with N7 (the rate then moves to the pay profile, D89).
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

describe('teacher hourly rate', () => {
  it('stores the hourly rate in EGP when a teacher is created', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const res = await client.post('/teachers', payload({ hourlyRate: 120 }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ hourlyRate: '120.00', hourlyRateCurrency: 'EGP' });
    const row = await ctx.prisma.teacher.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(row.hourlyRate?.toString()).toBe('120');
    expect(row.hourlyRateCurrency).toBe('EGP');
  });

  it('updates the rate from the teacher form, always in EGP, and leaves it alone otherwise', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const id = (await client.post('/teachers', payload({ hourlyRate: 120 }))).body.data.id;

    const edit = await client.patch(`/teachers/${id}`, {
      hourlyRate: '150.5',
      hourlyRateCurrency: 'egp',
    });
    expect(edit.status).toBe(200);
    expect(edit.body.data).toMatchObject({ hourlyRate: '150.50', hourlyRateCurrency: 'EGP' });

    const other = await client.patch(`/teachers/${id}`, { lastName: 'Hasan' });
    expect(other.body.data).toMatchObject({ hourlyRate: '150.50', hourlyRateCurrency: 'EGP' });
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

  it('allows no rate, and clearing it', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const res = await client.post('/teachers', payload({ hourlyRate: null }));
    expect(res.status).toBe(201);
    expect(res.body.data.hourlyRate).toBeNull();
    const set = await client.patch(`/teachers/${res.body.data.id}`, { hourlyRate: 90 });
    expect(set.body.data.hourlyRate).toBe('90.00');
    const cleared = await client.patch(`/teachers/${res.body.data.id}`, { hourlyRate: '' });
    expect(cleared.body.data.hourlyRate).toBeNull();
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
