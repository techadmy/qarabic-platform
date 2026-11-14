import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/cookies.js';
import {
  Client,
  createTestApp,
  createUser,
  resetState,
  signedIn,
  type TestContext,
} from './helpers.js';

/*
| P2-3 (docs/39 RBAC-3, RBAC-4, RBAC-5): the CSRF token belongs to its session; login is capped
| per account across IPs, with counters shared by every API process; custom (staff) roles are not
| copied from the teacher or parent role.
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

const cookie = (res: request.Response, name: string) =>
  ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.slice(name.length + 1);

describe('RBAC-3 a CSRF token is bound to its session', () => {
  it('a token minted for session A is refused with session B', async () => {
    const userA = await createUser(ctx, 'monitor');
    const userB = await createUser(ctx, 'monitor');
    const a = await new Client(ctx.app).init();
    await a.login(userA.email);
    const b = await new Client(ctx.app).init();
    const loginB = await b.login(userB.email);
    const sessionB = cookie(loginB, SESSION_COOKIE)!;
    const tokenA = (a as unknown as { csrf: string }).csrf;
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', `${SESSION_COOKIE}=${sessionB}; XSRF-TOKEN=${encodeURIComponent(tokenA)}`)
      .set('X-XSRF-TOKEN', tokenA);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('csrf_mismatch');
    // B's own token works.
    expect((await b.post('/auth/logout')).status).toBe(204);
  });
});

describe('RBAC-4 one account, many IPs', () => {
  it('10 failed logins from different IPs lock the account for a while', async () => {
    const user = await createUser(ctx, 'monitor');
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const c = await new Client(ctx.app).init();
      const res = await c.agent
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', `198.51.100.${i + 1}`)
        .set('X-XSRF-TOKEN', (c as unknown as { csrf: string }).csrf)
        .send({ email: user.email, password: 'wrong-password-123' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401 || s === 422)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(await ctx.prisma.rateLimitBucket.count()).toBeGreaterThan(0);
  });
});

describe('RBAC-5 custom roles keep row scope', () => {
  it('copying the teacher or parent role into a staff role is refused', async () => {
    const { client: admin } = await signedIn(ctx, 'admin');
    for (const name of ['teacher', 'parent']) {
      const role = await ctx.prisma.role.findUniqueOrThrow({ where: { name } });
      const res = await admin.post('/roles', { labelAr: `نسخة ${name}`, copyFrom: role.id });
      expect(res.status).toBe(422);
      expect(res.body.errors).toHaveProperty('copyFrom');
    }
    const monitor = await ctx.prisma.role.findUniqueOrThrow({ where: { name: 'monitor' } });
    expect(
      (await admin.post('/roles', { labelAr: 'نسخة المشرف', copyFrom: monitor.id })).status,
    ).toBe(201);
  });
});
