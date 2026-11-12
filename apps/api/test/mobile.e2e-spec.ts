import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakePush, PushGateway } from '../src/common/push.js';
import { buildOpenApiDocument, openApiPath } from '../src/common/openapi.js';
import { auditRoutes } from '../src/common/route-audit.js';
import {
  Client,
  createTestApp,
  createUser,
  resetState,
  signInAs,
  type TestContext,
} from './helpers.js';

/*
| Mobile readiness (docs/17 §5): push devices per person, push through the notification centre
| (driver swapped for the fake one), and an OpenAPI document that covers every route.
*/

let ctx: TestContext;
let push: FakePush;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await resetState(ctx);
  ctx.app.get(PushGateway).use((push = new FakePush()));
});

async function staff(role: string) {
  const user = await createUser(ctx, role);
  return { user, client: await signInAs(ctx, user) };
}

const TOKEN = 'fcm-token-0123456789abcdef';

describe('devices (/me/devices)', () => {
  it('registers, refreshes, lists own devices without the token, and unregisters', async () => {
    const a = await staff('csr');
    const first = await a.client.post('/me/devices', {
      token: TOKEN,
      platform: 'android',
      appVersion: '1.0.0',
      deviceName: 'Pixel',
    });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      platform: 'android',
      appVersion: '1.0.0',
      deviceName: 'Pixel',
    });
    expect(first.body.data.token).toBeUndefined();

    const again = await a.client.post('/me/devices', {
      token: TOKEN,
      platform: 'android',
      appVersion: '1.1.0',
    });
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(again.body.data.appVersion).toBe('1.1.0');
    expect((await a.client.get('/me/devices')).body.data).toHaveLength(1);

    expect((await a.client.post('/me/devices', { token: 'short', platform: 'ios' })).status).toBe(
      422,
    );
    expect(
      (await a.client.post('/me/devices', { token: TOKEN, platform: 'blackberry' })).status,
    ).toBe(422);

    // The same phone signed in by someone else moves to them.
    const b = await staff('monitor');
    await b.client.post('/me/devices', { token: TOKEN, platform: 'android' });
    expect((await a.client.get('/me/devices')).body.data).toEqual([]);
    const theirs = (await b.client.get('/me/devices')).body.data[0].id as number;
    expect((await a.client.delete(`/me/devices/${theirs}`)).status).toBe(404);
    expect((await b.client.delete(`/me/devices/${theirs}`)).status).toBe(204);
    expect((await b.client.get('/me/devices')).body.data).toEqual([]);
  });

  it('keeps at most 10 devices per person (the oldest goes) and answers 401 without a session', async () => {
    const a = await staff('csr');
    for (let i = 0; i < 12; i++) {
      await a.client.post('/me/devices', {
        token: `${TOKEN}-${String(i).padStart(2, '0')}`,
        platform: 'ios',
      });
    }
    expect(await ctx.prisma.deviceToken.count({ where: { userId: a.user.id } })).toBe(10);
    const anonymous = await new Client(ctx.app).init();
    expect((await anonymous.get('/me/devices')).status).toBe(401);
    expect((await anonymous.post('/me/devices', { token: TOKEN, platform: 'ios' })).status).toBe(
      401,
    );
    expect((await anonymous.delete('/me/devices/1')).status).toBe(401);
  });
});

describe('push through the notification centre', () => {
  it('pushes ids only, follows the preference, and forgets tokens the service reports gone', async () => {
    const issuer = await staff('csr');
    const doer = await staff('monitor');
    await doer.client.post('/me/devices', { token: TOKEN, platform: 'android' });
    await doer.client.post('/me/devices', { token: 'invalid-0123456789abcdef', platform: 'ios' });
    const prefs = (await doer.client.get('/me/notification-preferences')).body;
    expect(prefs.channels).toMatchObject({ push: true });
    expect(prefs.data.find((p: { kind: string }) => p.kind === 'task').push).toBe(true);

    const task = (
      await issuer.client.post('/tasks', { title: 'Call the family', assigneeId: doer.user.id })
    ).body.data;
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]).toMatchObject({
      token: TOKEN,
      title: 'Call the family',
      data: { kind: 'task', event: 'assigned', taskId: String(task.id) },
    });
    expect(Object.keys(push.sent[0]!.data!)).toEqual(['kind', 'event', 'taskId']);
    expect(await ctx.prisma.deviceToken.count({ where: { userId: doer.user.id } })).toBe(1);

    // Push off for tasks (older clients may omit `push`: it defaults to on).
    await doer.client.put('/me/notification-preferences', {
      preferences: [{ kind: 'task', inApp: true, email: false, push: false, whatsapp: false }],
    });
    push.clear();
    await issuer.client.post('/tasks', { title: 'Second', assigneeId: doer.user.id });
    expect(push.sent).toEqual([]);
    const legacy = await doer.client.put('/me/notification-preferences', {
      preferences: [{ kind: 'task', inApp: true, email: false, whatsapp: false }],
    });
    expect(legacy.body.data.find((p: { kind: string }) => p.kind === 'task').push).toBe(true);
  });

  it('sends nothing with the `none` driver and says so in the channels', async () => {
    ctx.app.get(PushGateway).use(new (await import('../src/common/push.js')).NonePush());
    const doer = await staff('monitor');
    expect((await doer.client.get('/me/notification-preferences')).body.channels.push).toBe(false);
  });
});

describe('OpenAPI (docs/17 §5)', () => {
  it('documents every route with a tag, its access, and a request body where it reads one', () => {
    const doc = buildOpenApiDocument(ctx.app);
    const missing: string[] = [];
    const untagged: string[] = [];
    for (const r of auditRoutes(ctx.app)) {
      const [method, route] = r.route.split(' ') as [string, string];
      const op = doc.paths[openApiPath(route)]?.[method.toLowerCase() as 'get'];
      if (!op) {
        missing.push(r.route);
        continue;
      }
      if (!op.tags?.length) untagged.push(r.route);
      expect((op as unknown as Record<string, unknown>)['x-access']).toBe(r.access);
    }
    // Provider webhooks (Stripe, PayPal, Meta) are hidden on purpose (`@ApiExcludeController`):
    // they are called by those services, never by an app.
    expect(missing.filter((r) => !/^(GET|POST) webhooks\//.test(r))).toEqual([]);
    expect(untagged).toEqual([]);
    const tasks = doc.paths['/api/v1/tasks']!.post!;
    expect(tasks.requestBody).toBeDefined();
    expect((tasks as unknown as Record<string, unknown>)['x-permissions']).toEqual([
      'tasks.manage',
    ]);
    expect(doc.paths['/api/v1/auth/login']!.post!.security).toEqual([]);
  });

  it('every route that validates a body documents it', () => {
    const doc = buildOpenApiDocument(ctx.app);
    expect(bodyRoutes(ctx)).toContain('POST me/devices');
    const undocumented = bodyRoutes(ctx).filter((route) => {
      const [method, path] = route.split(' ') as [string, string];
      if (path.startsWith('webhooks/')) return false;
      return !doc.paths[openApiPath(path)]?.[method.toLowerCase() as 'post']?.requestBody;
    });
    expect(undocumented).toEqual([]);
  });
});

/** Routes whose handler reads a body (`@ZodBody`). */
function bodyRoutes(c: TestContext): string[] {
  return auditRoutes(c.app)
    .filter((r) => r.body)
    .map((r) => r.route);
}
