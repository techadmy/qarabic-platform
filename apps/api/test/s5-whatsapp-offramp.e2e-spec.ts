import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Client,
  clock,
  createTestApp,
  createUser,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  makeFamily,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';
import { fbTicket } from './n4-helpers.js';

/*
| S5 (docs/32 §7): deep links staff paste instead of handling a request on WhatsApp, saved
| replies with `{link}` / `{name}`, and the channel report (on-behalf share, target < 10 %).
| Nothing is ever sent to a family from here (auto-reply waits for B50).
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let manager: Client;
let monitor: Client;

beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set(new Date('2026-11-16T09:00:00Z'));
  manager = (await signedIn(ctx, 'senior_manager')).client;
  monitor = (await signedIn(ctx, 'monitor')).client;
});

const reply = (extra: Record<string, unknown> = {}) =>
  manager.post('/support/saved-replies', {
    key: 'reschedule',
    titleAr: 'تغيير موعد حصة',
    titleEn: 'Change a class time',
    bodyAr: 'مرحبًا {name}، غيّر الموعد من هنا: {link}',
    bodyEn: 'Hello {name}, change the time here: {link}',
    link: { card: 'classes', choice: 'reschedule' },
    ...extra,
  });

describe('S5 deep links', () => {
  it('builds the family’s links: the hub, the cards, the next classes and open invoices', async () => {
    const student = await m2Student(ctx, 'Europe/London');
    const teacher = await m2Teacher(ctx);
    const enrollment = await m2Enrollment(ctx, student, teacher);
    const session = await m2Session(ctx, enrollment, '2026-11-17T17:00:00Z');
    const res = await monitor.get(`/support/links?familyId=${student.familyId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.general[0].url).toMatch(/\/contact$/);
    expect(res.body.data.general.map((l: { key: string }) => l.key)).toContain('card:billing');
    expect(res.body.data.classes).toHaveLength(3);
    expect(res.body.data.classes[0]).toMatchObject({
      key: `class:${session.id}:reschedule`,
      url: expect.stringMatching(
        new RegExp(`/contact\\?card=classes&choice=reschedule&session=${session.id}$`),
      ),
      detail: expect.stringContaining('2026-11-17 17:00'),
    });
    expect(res.body.data.invoices).toEqual([]);
    expect((await monitor.get('/support/links?familyId=999999')).status).toBe(404);
  });
});

describe('S5 saved replies', () => {
  it('managers add, edit, archive and restore; staff render with the family’s name and link', async () => {
    const created = await reply();
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect((await reply()).status).toBe(422); // same key
    expect((await reply({ key: 'x2', link: { card: 'classes', choice: 'nope' } })).status).toBe(
      422,
    );
    const family = await makeFamily(ctx, { user: { name: 'Umm Zaid' } });
    const rendered = await monitor.post(`/support/saved-replies/${id}/render`, {
      familyId: family.id,
      sessionId: 77,
    });
    expect(rendered.status).toBe(200);
    expect(rendered.body.data.ar).toMatch(
      /^مرحبًا Umm Zaid، غيّر الموعد من هنا: http.*\/contact\?card=classes&choice=reschedule&session=77$/,
    );
    expect(rendered.body.data.en).toContain('Hello Umm Zaid');

    const edited = await manager.patch(`/support/saved-replies/${id}`, { titleEn: 'Reschedule' });
    expect(edited.body.data.title.en).toBe('Reschedule');
    await manager.post(`/support/saved-replies/${id}/archive`);
    expect((await monitor.get('/support/saved-replies')).body.data).toEqual([]);
    expect((await manager.get('/support/saved-replies?all=1')).body.data).toHaveLength(1);
    await manager.post(`/support/saved-replies/${id}/restore`);
    expect((await monitor.get('/support/saved-replies')).body.data).toHaveLength(1);
    // Monitors use them but do not edit them.
    expect((await monitor.post('/support/saved-replies', {})).status).toBe(403);
    expect((await monitor.post(`/support/saved-replies/${id}/archive`)).status).toBe(403);
    // Nothing went to the family.
    expect(ctx.mailer.sent).toHaveLength(0);
  });
});

describe('S5 channel report', () => {
  it('counts requests by origin and week, the on-behalf share, and who files on behalf', async () => {
    const family = await makeFamily(ctx);
    const csr = await createUser(ctx, 'csr');
    await fbTicket(ctx, family.user, {}, 'The class link does not open on my phone');
    await fbTicket(ctx, family.user, {}, 'Another problem with the class page today');
    await fbTicket(ctx, csr, { channel: 'whatsapp' }, 'Family asked on WhatsApp about the time', {
      type: undefined,
      category: 'classes',
      familyId: family.id,
      context: {},
    });
    const res = await manager.get('/support/channels');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      from: '2026-09-22',
      to: '2026-11-16',
      targetPct: 10,
      total: {
        total: 3,
        onBehalf: 1,
        onBehalfPct: 33.3,
        byOrigin: { in_app: 2, whatsapp: 1, staff: 0, phone: 0, class_request: 0 },
      },
      weeks: [expect.objectContaining({ weekStart: '2026-11-16', total: 3, onBehalf: 1 })],
      byStaff: [{ user: { id: csr.id, name: expect.any(String) }, count: 1 }],
    });
  });

  it('staff only: 401 signed out, 403 for a parent or teacher', async () => {
    const anon = await new Client(ctx.app).init();
    for (const path of [
      '/support/channels',
      '/support/saved-replies',
      '/support/links?familyId=1',
    ]) {
      expect((await anon.get(path)).status).toBe(401);
    }
    const parent = await signInAs(ctx, (await makeFamily(ctx)).user);
    expect((await parent.get('/support/channels')).status).toBe(403);
    expect((await parent.get('/support/links?familyId=1')).status).toBe(403);
    const { client: teacher } = await signedIn(ctx, 'teacher');
    expect((await teacher.get('/support/saved-replies')).status).toBe(403);
  });
});
