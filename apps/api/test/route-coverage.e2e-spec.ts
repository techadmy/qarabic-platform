import { Controller, Get } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditRoutes } from '../src/common/route-audit.js';
import { Client, createTestApp, resetState, signedIn, type TestContext } from './helpers.js';

/** Deliberately unmarked: proves the global guard denies by default. */
@Controller('unmarked')
class UnmarkedController {
  @Get()
  get(): string {
    return 'should never be served';
  }
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp([UnmarkedController]);
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await resetState(ctx);
});

/** The only routes open without a session. Adding one here needs a security review. */
const PUBLIC_ROUTES = [
  'GET auth/csrf',
  'GET health',
  'POST auth/forgot-password',
  'POST auth/login',
  'POST auth/reset-password',
];

describe('route permission coverage', () => {
  it('every route declares @Public, @Can or @Authenticated (except the test-only one)', () => {
    const routes = auditRoutes(ctx.app).filter((r) => r.route !== 'GET unmarked');
    expect(routes.length).toBeGreaterThanOrEqual(9);
    const unprotected = routes.filter((r) => r.access === 'none').map((r) => r.route);
    expect(unprotected).toEqual([]);
  });

  it('only the allow-listed routes are public; only own-account routes skip a permission', () => {
    const routes = auditRoutes(ctx.app);
    expect(routes.filter((r) => r.access === 'public').map((r) => r.route)).toEqual(PUBLIC_ROUTES);
    expect(routes.filter((r) => r.access === 'authenticated').map((r) => r.route)).toEqual([
      'GET auth/me',
      'GET me',
      'PATCH me',
      'POST auth/logout',
    ]);
  });

  it('answers 401 on every non-public route without a session (CSRF token present)', async () => {
    const anonymous = await new Client(ctx.app).init();
    const routes = auditRoutes(ctx.app).filter(
      (r) => r.access !== 'public' && r.route !== 'GET unmarked',
    );
    expect(routes.length).toBeGreaterThanOrEqual(39);
    for (const { route } of routes) {
      const [method, path] = route.split(' ') as [string, string];
      const url = '/' + path.replace(/:\w+/g, '1');
      const res =
        method === 'GET'
          ? await anonymous.get(url)
          : method === 'POST'
            ? await anonymous.post(url, {})
            : method === 'PATCH'
              ? await anonymous.patch(url, {})
              : method === 'PUT'
                ? await anonymous.put(url, {})
                : await anonymous.delete(url, {});
      expect(res.status, route).toBe(401);
      expect(res.body.code, route).toBe('unauthenticated');
    }
  });

  it('every N1 route needs the permission documented in docs/28 and docs/29', () => {
    const byRoute = Object.fromEntries(
      auditRoutes(ctx.app).map((r) => [r.route, `${r.mode ?? ''}:${r.permissions.join('|')}`]),
    );
    expect(byRoute).toMatchObject({
      'GET people/lookups': 'any:families.manage|staff.manage|users.manage',
      'GET families': 'all:families.view',
      'GET families/:id': 'all:families.view',
      'POST families': 'all:families.manage',
      'PATCH families/:id': 'all:families.manage',
      'POST families/:id/status': 'all:families.manage',
      'DELETE families/:id': 'all:families.manage',
      'POST families/:id/restore': 'all:families.manage',
      'GET students': 'any:families.view|sessions.conduct',
      'GET students/:id': 'any:families.view|sessions.conduct',
      'POST students': 'all:families.manage',
      'PATCH students/:id': 'all:families.manage',
      'POST students/:id/status': 'all:families.manage',
      'DELETE students/:id': 'all:families.manage',
      'POST students/:id/restore': 'all:families.manage',
      'GET teachers': 'all:staff.view',
      'GET teachers/:id': 'all:staff.view',
      'POST teachers': 'all:staff.manage',
      'PATCH teachers/:id': 'all:staff.manage',
      'POST teachers/:id/status': 'all:staff.manage',
      'DELETE teachers/:id': 'all:staff.manage',
      'POST teachers/:id/restore': 'all:staff.manage',
      'GET staff': 'all:users.view',
      'GET staff/:id': 'all:users.view',
      'POST staff': 'all:users.manage',
      'PATCH staff/:id': 'all:users.manage',
      'POST staff/:id/status': 'all:users.manage',
      'DELETE staff/:id': 'all:users.manage',
      'POST staff/:id/restore': 'all:users.manage',
      'GET roles': 'all:roles.view',
      'GET roles/catalog': 'all:roles.view',
      'GET roles/:id': 'all:roles.view',
      'POST roles': 'all:roles.manage',
      'PATCH roles/:id': 'all:roles.manage',
      'DELETE roles/:id': 'all:roles.manage',
    });
  });

  it('answers 403 to a signed-in user with no role on every permission route', async () => {
    const { client } = await signedIn(ctx, null);
    for (const { route } of auditRoutes(ctx.app).filter((r) => r.access === 'permission')) {
      const [method, path] = route.split(' ') as [string, string];
      const url = '/' + path.replace(/:\w+/g, '1');
      const res =
        method === 'GET'
          ? await client.get(url)
          : method === 'POST'
            ? await client.post(url, {})
            : method === 'PATCH'
              ? await client.patch(url, {})
              : method === 'PUT'
                ? await client.put(url, {})
                : await client.delete(url, {});
      expect(res.status, route).toBe(403);
    }
  });

  it('the audit flags an unmarked route', () => {
    expect(auditRoutes(ctx.app).find((r) => r.route === 'GET unmarked')?.access).toBe('none');
  });

  it('an unmarked route is denied: 401 without a session, 403 even for the owner', async () => {
    expect((await request(ctx.app.getHttpServer()).get('/api/v1/unmarked')).status).toBe(401);
    const { client } = await signedIn(ctx, 'admin');
    expect((await client.get('/unmarked')).status).toBe(403);
  });
});

describe('platform', () => {
  it('GET /health is public and pings the database', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok' });
  });

  it('unknown routes answer in the standard error format', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/v1/nope');
    // Deny by default runs first: no session means 401, even for a route that does not exist.
    expect([401, 404]).toContain(res.status);
    expect(Object.keys(res.body).sort()).toEqual(['code', 'message']);
  });

  it('malformed JSON is a 400 in the standard format', async () => {
    const { client } = await signedIn(ctx, 'admin');
    const res = await client.agent
      .post('/api/v1/auth/forgot-password')
      .set('Content-Type', 'application/json')
      .set('X-XSRF-TOKEN', 'x')
      .send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bad_request');
    expect(Object.keys(res.body).sort()).toEqual(['code', 'message']);
  });

  it('sends security headers and CORS for the web origin only', async () => {
    const ok = await request(ctx.app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:3000');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['x-powered-by']).toBeUndefined();

    const evil = await request(ctx.app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves the OpenAPI document outside production', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/api/docs-json');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/auth/login',
        '/api/v1/roles',
        '/api/v1/families',
        '/api/v1/staff/{id}/status',
      ]),
    );
  });
});
