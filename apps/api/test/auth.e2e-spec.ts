import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REMEMBER_TTL_MS } from '../src/auth/sessions.service.js';
import { sha256 } from '../src/auth/tokens.js';
import {
  Client,
  createTestApp,
  createUser,
  PASSWORD,
  resetState,
  setCookies,
  signedIn,
  type TestContext,
} from './helpers.js';

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

const sessionCookie = (res: request.Response) =>
  setCookies(res).find((c) => c.startsWith('qarabic_session='));

describe('POST /auth/login', () => {
  it('signs in, returns me, and sets a hardened session cookie (remember = 30 days)', async () => {
    const user = await createUser(ctx, 'manager');
    const client = await new Client(ctx.app).init();
    const res = await client.login(user.email);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: user.id, email: user.email, roles: ['manager'] });
    const cookie = sessionCookie(res)!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Secure/); // Secure only in production
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
    expect(maxAge).toBe(REMEMBER_TTL_MS / 1000);

    // Only the sha256 of the token is stored.
    const token = /qarabic_session=([^;]+)/.exec(cookie)![1]!;
    const session = await ctx.prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.id).toBe(sha256(token));
    expect(session.id).not.toBe(token);
    // A fresh XSRF-TOKEN, readable by JS.
    const xsrf = setCookies(res).find((c) => c.startsWith('XSRF-TOKEN='))!;
    expect(xsrf).not.toMatch(/HttpOnly/);
  });

  it('without remember: browser-session cookie and a 12 hour server-side expiry', async () => {
    const user = await createUser(ctx, 'manager');
    const client = await new Client(ctx.app).init();
    const res = await client.login(user.email, PASSWORD, false);

    expect(res.status).toBe(200);
    const cookie = sessionCookie(res)!;
    expect(cookie).not.toMatch(/Max-Age|Expires/);
    const session = await ctx.prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    const hours = (session.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);
  });

  it('rejects a wrong password with a generic 422', async () => {
    const user = await createUser(ctx, 'manager');
    const client = await new Client(ctx.app).init();
    const res = await client.login(user.email, 'Wrong-password-1');

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      message: 'These credentials do not match our records.',
      code: 'invalid_credentials',
      errors: { email: ['These credentials do not match our records.'] },
    });
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('gives an unknown email exactly the same answer (no enumeration)', async () => {
    const client = await new Client(ctx.app).init();
    const res = await client.login('nobody@example.test', 'Whatever-123');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_credentials');
  });

  it('accepts a pasted email and password with invisible marks and stray spaces', async () => {
    const user = await createUser(ctx, 'manager');
    const client = await new Client(ctx.app).init();
    const res = await client.login(
      `  ${user.email.toUpperCase()}\u200F `,
      `\u200F${PASSWORD}\u200E\uFEFF\n`,
    );
    expect(res.status).toBe(200);
  });

  it('rejects an inactive user with the same generic 422', async () => {
    const user = await createUser(ctx, 'manager', { isActive: false });
    const client = await new Client(ctx.app).init();
    const res = await client.login(user.email);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_credentials');
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('validates the body (422 validation_failed)', async () => {
    const client = await new Client(ctx.app).init();
    const res = await client.post('/auth/login', { email: 'not-an-email' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(Object.keys(res.body.errors).sort()).toEqual(['email', 'password']);
  });

  it('throttles after 5 attempts per minute for the same email and IP (429)', async () => {
    const user = await createUser(ctx, 'manager');
    const client = await new Client(ctx.app).init();
    for (let i = 0; i < 5; i++) {
      expect((await client.login(user.email, 'Wrong-password-1')).status).toBe(422);
    }
    const blocked = await client.login(user.email); // even the right password
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('too_many_requests');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // Another email from the same IP is not blocked by that counter.
    const other = await createUser(ctx, 'manager');
    expect((await client.login(other.email)).status).toBe(200);
  });

  it('accepts a Laravel bcrypt hash once and re-hashes it with argon2id', async () => {
    const laravelHash = (await bcrypt.hash(PASSWORD, 10)).replace(/^\$2b\$/, '$2y$');
    const user = await createUser(ctx, 'teacher', { passwordHash: laravelHash });
    const client = await new Client(ctx.app).init();

    expect((await client.login(user.email)).status).toBe(200);
    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash.startsWith('$argon2id$')).toBe(true);

    const again = await new Client(ctx.app).init();
    expect((await again.login(user.email)).status).toBe(200);
  });
});

describe('CSRF (double submit)', () => {
  it('rejects an unsafe request without the X-XSRF-TOKEN header (403)', async () => {
    const { client } = await signedIn(ctx, 'manager');
    const res = await client.post('/auth/logout', {}, { csrf: false });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('csrf_mismatch');
  });

  it('rejects login without the token, and a forged token that is not signed by us', async () => {
    const user = await createUser(ctx, 'manager');
    const bare = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: PASSWORD });
    expect(bare.status).toBe(403);

    const forged = 'attacker-chosen-nonce.attacker-signature';
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Cookie', `XSRF-TOKEN=${forged}`)
      .set('X-XSRF-TOKEN', forged)
      .send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it('lets safe methods through without a token', async () => {
    const { client } = await signedIn(ctx, 'manager');
    expect((await client.get('/auth/me')).status).toBe(200);
  });
});

describe('sessions', () => {
  it('GET /auth/me returns the meSchema shape with role and expanded permissions', async () => {
    const { user, client } = await signedIn(ctx, 'monitor');
    const res = await client.get('/auth/me');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'email',
        'id',
        'locale',
        'name',
        'permissions',
        'phone',
        'role',
        'roles',
        'teacherId',
        'timezone',
      ].sort(),
    );
    expect(res.body).toMatchObject({
      id: user.id,
      roles: ['monitor'],
      role: { name: 'monitor', kind: 'staff' },
      locale: 'ar',
    });
    expect(res.body.permissions).toEqual(
      expect.arrayContaining(['schedule.view', 'schedule.manage']),
    );
    expect(res.body.permissions).not.toContain('roles.view');
  });

  it('401 without a session', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: 'Unauthenticated.', code: 'unauthenticated' });
  });

  it('401 with a made-up session cookie', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', 'qarabic_session=' + 'a'.repeat(43));
    expect(res.status).toBe(401);
  });

  it('logout deletes the session; the old cookie no longer works', async () => {
    const { user, client } = await signedIn(ctx, 'manager');
    expect(await ctx.prisma.session.count({ where: { userId: user.id } })).toBe(1);

    const res = await client.post('/auth/logout');
    expect(res.status).toBe(204);
    expect(await ctx.prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect((await client.get('/auth/me')).status).toBe(401);
  });

  it('a replayed cookie after logout is rejected', async () => {
    const user = await createUser(ctx, 'manager');
    const client = await new Client(ctx.app).init();
    const login = await client.login(user.email);
    const raw = sessionCookie(login)!.split(';')[0]!;
    await client.post('/auth/logout');
    const replay = await request(ctx.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', raw);
    expect(replay.status).toBe(401);
  });

  it('rejects an expired session and deletes it', async () => {
    const { user, client } = await signedIn(ctx, 'manager');
    await ctx.prisma.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await client.get('/auth/me')).status).toBe(401);
    expect(await ctx.prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('signs out a user who was deactivated after login', async () => {
    const { user, client } = await signedIn(ctx, 'manager');
    await ctx.prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expect((await client.get('/auth/me')).status).toBe(401);
  });
});

describe('permissions', () => {
  it('403 when the role lacks the permission', async () => {
    const { client } = await signedIn(ctx, 'manager');
    const res = await client.get('/roles');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  it('a user without a role can sign in but holds no permission', async () => {
    const { client } = await signedIn(ctx, null);
    const me = await client.get('/auth/me');
    expect(me.body).toMatchObject({ roles: [], permissions: [] });
    expect((await client.get('/roles')).status).toBe(403);
  });

  it('teacher privacy (D138): no staff.view, families.view or roles access', async () => {
    const { client } = await signedIn(ctx, 'teacher');
    const me = await client.get('/auth/me');
    for (const p of ['staff.view', 'families.view', 'schedule.view', 'roles.view', 'users.view']) {
      expect(me.body.permissions).not.toContain(p);
    }
    expect(me.body.permissions).toEqual(
      expect.arrayContaining(['sessions.view', 'sessions.conduct']),
    );
    expect((await client.get('/roles')).status).toBe(403);
  });

  it('the owner gets every permission, even one missing from its role rows', async () => {
    const { client } = await signedIn(ctx, 'admin');
    await ctx.prisma.rolePermission.deleteMany({ where: { role: { name: 'admin' } } });
    const me = await client.get('/auth/me');
    expect(me.body.permissions).toContain('roles.manage');
    expect((await client.get('/roles')).status).toBe(200);
  });
});

describe('session fixation', () => {
  it('signing in again drops the session the browser already had', async () => {
    const { user, client } = await signedIn(ctx, 'manager');
    expect((await client.login(user.email)).status).toBe(200);
    expect(await ctx.prisma.session.count({ where: { userId: user.id } })).toBe(1);
    expect((await client.get('/auth/me')).status).toBe(200);
  });
});
