import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ZoomHttp, type ZoomResponse } from '../src/zoom/zoom.api.js';
import { ZoomConfig } from '../src/zoom/zoom.config.js';
import {
  type Client,
  clock,
  createTestApp,
  m2Teacher,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';

/*
| D151 (b): with the Zoom app on, the account's licensed users are synced into the host pool; staff
| assign one to a teacher, which sets the teacher's link and PMI. Zoom is the fake HTTP edge only:
| no request leaves a test.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

interface FakeUser {
  id: string;
  email: string;
  type: number;
  pmi: number;
  url?: string;
  status?: string;
}
let zoomUsers: FakeUser[];
let calls: string[];

function on() {
  ctx.app.get(ZoomConfig).use({
    accountId: 'acc',
    clientId: 'cid',
    clientSecret: 'csecret',
    webhookSecret: 'whsec',
  });
  ctx.app.get(ZoomHttp).use((req): Promise<ZoomResponse> => {
    calls.push(`${req.method} ${req.url.split('?')[0]}`);
    const ok = (json: unknown) => Promise.resolve({ status: 200, headers: {}, json });
    if (req.url.startsWith('https://zoom.us/oauth/token')) {
      return ok({ access_token: 'tok', expires_in: 3600 });
    }
    const url = new URL(req.url);
    if (url.pathname === '/v2/users') {
      // Two pages, to prove paging.
      const token = url.searchParams.get('next_page_token');
      const half = Math.ceil(zoomUsers.length / 2);
      const page = token ? zoomUsers.slice(half) : zoomUsers.slice(0, half);
      return ok({
        users: page.map((u) => ({ id: u.id, email: u.email, type: u.type })),
        next_page_token: token ? '' : 'p2',
      });
    }
    const id = decodeURIComponent(url.pathname.replace('/v2/users/', ''));
    const u = zoomUsers.find((x) => x.id === id);
    if (!u) return Promise.resolve({ status: 404, headers: {}, json: null });
    return ok({
      id: u.id,
      email: u.email,
      type: u.type,
      status: u.status ?? 'active',
      display_name: `Zoom ${u.id}`,
      pmi: u.pmi,
      personal_meeting_url: u.url ?? `https://us02web.zoom.us/j/${u.pmi}?pwd=pw${u.id}`,
    });
  });
}

let admin: Client;
beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-10T08:00:00Z');
  admin = (await signedIn(ctx, 'admin')).client;
  calls = [];
  zoomUsers = [
    { id: 'zu1', email: 'one@zoom.test', type: 2, pmi: 1111111111 },
    { id: 'zu2', email: 'two@zoom.test', type: 2, pmi: 2222222222 },
    { id: 'zu3', email: 'basic@zoom.test', type: 1, pmi: 3333333333 },
  ];
});

const hosts = async () =>
  (await admin.get('/zoom-hosts/account')).body.data.hosts as Array<{
    id: number;
    zoomUserId: string;
    pmiMeetingId: string | null;
    isActive: boolean;
    teacher: { id: number } | null;
  }>;

describe('Zoom off', () => {
  it('lists `{ enabled: false }` and refuses a sync (503); no request is made', async () => {
    const res = await admin.get('/zoom-hosts/account');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ enabled: false });
    const sync = await admin.post('/zoom-hosts/sync');
    expect(sync.status).toBe(503);
    expect(sync.body.code).toBe('zoom_unavailable');
    expect(calls).toEqual([]);
  });
});

describe('sync', () => {
  it('upserts the licensed users only, with their PMI and encrypted link, and marks the gone', async () => {
    on();
    const res = await admin.post('/zoom-hosts/sync');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ synced: 2, deactivated: 0, conflicts: [] });
    expect(calls).toContain('GET https://api.zoom.us/v2/users');

    const list = await admin.get('/zoom-hosts/account');
    expect(list.body.data.enabled).toBe(true);
    expect(list.body.data.lastSyncedAt).toBe('2026-11-10T08:00:00.000Z');
    expect(list.body.data.hosts).toHaveLength(2);
    expect(list.body.data.hosts[0]).toMatchObject({
      zoomUserId: 'zu1',
      email: 'one@zoom.test',
      displayName: 'Zoom zu1',
      pmiMeetingId: '1111111111',
      licenseType: 'licensed',
      isActive: true,
      teacher: null,
    });
    // The link (with its passcode) is stored encrypted and never listed.
    expect(JSON.stringify(list.body)).not.toContain('pwzu1');
    const row = await ctx.prisma.zoomHost.findUniqueOrThrow({ where: { zoomUserId: 'zu1' } });
    expect(row.joinUrl).toMatch(/^v1:/);

    // Next day: zu2 lost its licence; the sync updates and deactivates, nothing is duplicated.
    clock(ctx).set('2026-11-11T03:20:00Z');
    zoomUsers[1]!.type = 1;
    const again = await admin.post('/zoom-hosts/sync');
    expect(again.body.data).toMatchObject({ synced: 1, deactivated: 1 });
    expect(await ctx.prisma.zoomHost.count()).toBe(2);
    const two = (await hosts()).find((h) => h.zoomUserId === 'zu2')!;
    expect(two.isActive).toBe(false);
  });

  it('adopts a teacher whose typed link is a licensed user’s meeting; reports a real clash', async () => {
    const t = await m2Teacher(ctx);
    await admin.patch(`/teachers/${t.id}`, { zoomJoinUrl: 'https://zoom.us/j/1111111111' });
    const other = await ctx.prisma.zoomHost.create({
      data: { zoomUserId: 'manual-x', email: 'x@example.test', pmiMeetingId: '2222222222' },
    });
    on();
    const res = await admin.post('/zoom-hosts/sync');
    expect(res.body.data.conflicts).toEqual([
      { email: 'two@zoom.test', pmiMeetingId: '2222222222' },
    ]);
    const list = await hosts();
    expect(list.find((h) => h.zoomUserId === 'zu1')!.teacher?.id).toBe(t.id);
    // The teacher's placeholder host is gone: one host per teacher.
    expect(await ctx.prisma.zoomHost.count({ where: { teacherId: t.id } })).toBe(1);
    expect(list.find((h) => h.zoomUserId === 'zu2')!.pmiMeetingId).toBeNull();
    expect(await ctx.prisma.zoomHost.findUnique({ where: { id: other.id } })).not.toBeNull();
  });
});

describe('PUT /zoom-hosts/:id/teacher', () => {
  it('assigns: the teacher gets the host’s link and PMI; frees: the link is cleared', async () => {
    on();
    await admin.post('/zoom-hosts/sync');
    const [one, two] = await hosts();
    const t = await m2Teacher(ctx, 'Africa/Cairo', 'Amina');
    const u = await m2Teacher(ctx, 'Africa/Cairo', 'Bilal');

    const res = await admin.put(`/zoom-hosts/${one!.id}/teacher`, { teacherId: t.id });
    expect(res.status).toBe(200);
    expect(res.body.data.hosts[0].teacher).toMatchObject({ id: t.id, name: expect.any(String) });
    const profile = await admin.get(`/teachers/${t.id}`);
    expect(profile.body.data).toMatchObject({
      hasZoomLink: true,
      zoomJoinUrl: 'https://us02web.zoom.us/j/1111111111?pwd=pwzu1',
    });
    expect(
      (await ctx.prisma.teacher.findUniqueOrThrow({ where: { id: t.id } })).zoomMeetingId,
    ).toBe('1111111111');

    // One host belongs to one teacher.
    const taken = await admin.put(`/zoom-hosts/${one!.id}/teacher`, { teacherId: u.id });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('zoom_host_taken');

    // Moving the teacher to another host frees the first.
    await admin.put(`/zoom-hosts/${two!.id}/teacher`, { teacherId: t.id });
    const after = await hosts();
    expect(after.find((h) => h.id === one!.id)!.teacher).toBeNull();
    expect(after.find((h) => h.id === two!.id)!.teacher?.id).toBe(t.id);
    expect(
      (await ctx.prisma.teacher.findUniqueOrThrow({ where: { id: t.id } })).zoomMeetingId,
    ).toBe('2222222222');

    const freed = await admin.put(`/zoom-hosts/${two!.id}/teacher`, { teacherId: null });
    expect(freed.status).toBe(200);
    expect((await admin.get(`/teachers/${t.id}`)).body.data.hasZoomLink).toBe(false);
  });

  it('refuses a host Zoom no longer lists (409), a bad teacher (422), and an unknown host (404)', async () => {
    on();
    await admin.post('/zoom-hosts/sync');
    zoomUsers = zoomUsers.slice(1);
    await admin.post('/zoom-hosts/sync');
    const gone = (await hosts()).find((h) => h.zoomUserId === 'zu1')!;
    const t = await m2Teacher(ctx);
    const inactive = await admin.put(`/zoom-hosts/${gone.id}/teacher`, { teacherId: t.id });
    expect(inactive.status).toBe(409);
    expect(inactive.body.code).toBe('zoom_host_inactive');
    const live = (await hosts()).find((h) => h.zoomUserId === 'zu2')!;
    expect((await admin.put(`/zoom-hosts/${live.id}/teacher`, { teacherId: 999999 })).status).toBe(
      422,
    );
    expect((await admin.put('/zoom-hosts/999999/teacher', { teacherId: t.id })).status).toBe(404);
  });
});

describe('permissions', () => {
  it('settings or teacher admins only; 403 for the rest; 401 without a session', async () => {
    on();
    const t = await m2Teacher(ctx);
    for (const role of ['monitor', 'csr', 'billing', 'parent']) {
      const { client } = await signedIn(ctx, role);
      expect((await client.get('/zoom-hosts/account')).status, role).toBe(403);
      expect((await client.post('/zoom-hosts/sync')).status, role).toBe(403);
      expect((await client.put('/zoom-hosts/1/teacher', { teacherId: t.id })).status, role).toBe(
        403,
      );
    }
    const teacher = await signInAs(ctx, t.user);
    expect((await teacher.get('/zoom-hosts/account')).status).toBe(403);
    expect((await request(ctx.app.getHttpServer()).get('/api/v1/zoom-hosts/account')).status).toBe(
      401,
    );
  });
});
