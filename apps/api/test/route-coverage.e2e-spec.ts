import { Controller, Get } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditRoutes } from '../src/common/route-audit.js';
import { createTestApp, resetState, signedIn, type TestContext } from './helpers.js';

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
      'POST auth/logout',
    ]);
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
      expect.arrayContaining(['/api/v1/auth/login', '/api/v1/roles']),
    );
  });
});
