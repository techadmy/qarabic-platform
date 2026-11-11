import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Client,
  createTestApp,
  createUser,
  makeFamily,
  PASSWORD,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';

/*
| PATCH /me (Laravel `MeController` + `UpdateMeRequest`, D68/D74): the signed-in user's own name,
| language, time zone and phone, plus a password change with the current password.
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

describe('PATCH /me', () => {
  it('updates the own name, language, time zone and phone, and returns me', async () => {
    const { client, user } = await signedIn(ctx, 'teacher');
    const res = await client.patch('/me', {
      name: 'Omar',
      locale: 'en',
      timezone: 'Asia/Karachi',
      phone: '+92 300 1234567',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: user.id,
      name: 'Omar',
      locale: 'en',
      timezone: 'Asia/Karachi',
      phone: '+923001234567',
    });
    expect((await client.get('/me')).body.timezone).toBe('Asia/Karachi');
  });

  it("a parent's phone is the family's contact number", async () => {
    const family = await makeFamily(ctx);
    const client = await signInAs(ctx, family.user);
    await client.patch('/me', { phone: '+447700900555' });
    const { client: csr } = await signedIn(ctx, 'csr');
    expect((await csr.get(`/families/${family.id}`)).body.data.phone).toBe('+447700900555');
  });

  it('validates the fields and needs at least one', async () => {
    const { client } = await signedIn(ctx, 'manager');
    const bad = await client.patch('/me', { timezone: 'Mars/Base', locale: 'fr', phone: '12' });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.errors).sort()).toEqual(['locale', 'phone', 'timezone']);
    expect((await client.patch('/me', {})).status).toBe(422);
    expect((await client.patch('/me', { name: '' })).body.errors).toHaveProperty('name');
  });

  it('changes the password with the current one and signs out the other sessions', async () => {
    const user = await createUser(ctx, 'csr');
    const here = await signInAs(ctx, user);
    const elsewhere = await signInAs(ctx, user);

    const noCurrent = await here.patch('/me', { password: 'New-password-1' });
    expect(noCurrent.status).toBe(422);
    expect(noCurrent.body.errors).toHaveProperty('currentPassword');
    const wrong = await here.patch('/me', {
      currentPassword: 'nope',
      password: 'New-password-1',
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('wrong_password');
    expect((await here.patch('/me', { currentPassword: PASSWORD, password: 'short' })).status).toBe(
      422,
    );

    const ok = await here.patch('/me', { currentPassword: PASSWORD, password: 'New-password-1' });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain('password');
    expect((await here.get('/me')).status).toBe(200);
    expect((await elsewhere.get('/me')).status).toBe(401);

    const fresh = await new Client(ctx.app).init();
    expect((await fresh.login(user.email, PASSWORD)).status).toBe(422);
    expect((await fresh.login(user.email, 'New-password-1')).status).toBe(200);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'password_changed', subjectId: user.id },
      }),
    ).toBe(1);
  });

  it('rate limits password attempts', async () => {
    const { client } = await signedIn(ctx, 'csr');
    for (let i = 0; i < 5; i++) {
      await client.patch('/me', { currentPassword: 'nope', password: 'New-password-1' });
    }
    const res = await client.patch('/me', {
      currentPassword: PASSWORD,
      password: 'New-password-1',
    });
    expect(res.status).toBe(429);
    // Preferences are not throttled.
    expect((await client.patch('/me', { locale: 'en' })).status).toBe(200);
  });

  it('needs a session', async () => {
    const anonymous = await new Client(ctx.app).init();
    expect((await anonymous.patch('/me', { locale: 'en' })).status).toBe(401);
    expect((await anonymous.get('/me')).status).toBe(401);
  });
});
