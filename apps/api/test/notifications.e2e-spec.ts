import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, resetState, signedIn, type TestContext } from './helpers.js';

/*
| `/me/notifications`: the top-bar bell. One table for every module (N5 lead alerts first); a user
| only ever reads and marks their own rows.
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

async function alert(userId: number, minutesAgo: number, read = false) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  return ctx.prisma.notification.create({
    data: {
      userId,
      kind: 'lead',
      event: 'assigned',
      data: { kind: 'lead', event: 'assigned', leadId: 7, parentName: 'Parent' },
      createdAt: at,
      readAt: read ? at : null,
    },
  });
}

describe('/me/notifications', () => {
  it('lists my own alerts newest first with the unread count', async () => {
    const me = await signedIn(ctx, 'csr');
    const other = await signedIn(ctx, 'csr');
    const older = await alert(me.user.id, 30);
    const newer = await alert(me.user.id, 5);
    await alert(me.user.id, 60, true);
    await alert(other.user.id, 1);

    const res = await me.client.get('/me/notifications');
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ unread: 2 });
    expect(res.body.data.map((n: { id: number }) => n.id).slice(0, 2)).toEqual([
      newer.id,
      older.id,
    ]);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[0]).toMatchObject({
      kind: 'lead',
      event: 'assigned',
      readAt: null,
      data: { leadId: 7, parentName: 'Parent' },
    });

    const unread = await me.client.get('/me/notifications?unread=1&limit=1');
    expect(unread.body.data).toHaveLength(1);
    expect(unread.body.data[0].id).toBe(newer.id);
    expect((await me.client.get('/me/notifications?limit=0')).status).toBe(422);
  });

  it('marks one read (idempotent) and refuses another user’s row with 404', async () => {
    const me = await signedIn(ctx, 'csr');
    const other = await signedIn(ctx, 'csr');
    const mine = await alert(me.user.id, 5);
    const theirs = await alert(other.user.id, 5);

    expect((await me.client.post(`/me/notifications/${mine.id}/read`)).status).toBe(204);
    expect((await me.client.post(`/me/notifications/${mine.id}/read`)).status).toBe(204);
    expect((await me.client.post(`/me/notifications/${theirs.id}/read`)).status).toBe(404);
    expect(
      (await ctx.prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt,
    ).toBeNull();
    expect((await me.client.get('/me/notifications')).body.meta.unread).toBe(0);
  });

  it('marks all of mine read, nobody else’s', async () => {
    const me = await signedIn(ctx, 'csr');
    const other = await signedIn(ctx, 'csr');
    await alert(me.user.id, 5);
    await alert(me.user.id, 6);
    await alert(other.user.id, 5);
    const res = await me.client.post('/me/notifications/read-all');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ updated: 2 });
    expect((await other.client.get('/me/notifications')).body.meta.unread).toBe(1);
  });

  it('needs a session and the CSRF token', async () => {
    const me = await signedIn(ctx, 'parent');
    const row = await alert(me.user.id, 5);
    expect(
      (await me.client.post(`/me/notifications/${row.id}/read`, {}, { csrf: false })).status,
    ).toBe(403);
    expect((await me.client.get('/me/notifications')).status).toBe(200);
  });

  it('a real lead assignment lands in the assignee’s bell', async () => {
    const admin = await signedIn(ctx, 'admin');
    const csr = await signedIn(ctx, 'csr');
    const created = await admin.client.post('/leads', {
      parentName: 'Bell Parent',
      phone: '+201001234567',
      source: 'phone',
      assignedTo: csr.user.id,
    });
    expect(created.status).toBe(201);
    const res = await csr.client.get('/me/notifications');
    expect(res.body.meta.unread).toBe(1);
    expect(res.body.data[0]).toMatchObject({ kind: 'lead', event: 'assigned' });
  });
});
