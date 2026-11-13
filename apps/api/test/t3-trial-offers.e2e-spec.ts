import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TrialOffers } from '../src/crm/offers.service.js';
import { SettingsService } from '../src/settings/settings.service.js';
import {
  Client,
  clock,
  createTestApp,
  m2Teacher,
  makeCourse,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
  zoomDriver,
} from './helpers.js';
import { crmAt, crmLead, resetCrm } from './n5-helpers.js';

/*
| T3 open trial offers (docs/33 §4.3, D136): the CSR offers a trial to the eligible teachers;
| the first to accept is booked (atomic), or teachers volunteer and the CSR picks; offers expire
| and the CSR is told. Teachers never see the family. Now: Mon 2026-11-16 09:00 UTC; the trial is
| Wed 2026-11-18 17:00 London (19:00 Cairo).
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let csr: Client;
let csrId: number;
let leadId: number;
let courseId: number;
let studentId: number;

interface T {
  id: number;
  userId: number;
  client: Client;
}

const teacher = async (name: string, teaches = true): Promise<T> => {
  const t = await m2Teacher(ctx, 'Africa/Cairo', name);
  if (teaches) await ctx.prisma.teacherCourse.create({ data: { teacherId: t.id, courseId } });
  const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: t.userId } });
  return { id: t.id, userId: t.userId, client: await signInAs(ctx, user) };
};

const offer = (extra: Record<string, unknown> = {}) =>
  csr.post(`/leads/${leadId}/trial-offers`, {
    studentId,
    courseId,
    localDate: '2026-11-18',
    localTime: '17:00',
    ...extra,
  });

const leadNotices = (event: string) =>
  ctx.prisma.notification.count({ where: { userId: csrId, kind: 'lead', event } });

beforeEach(async () => {
  await resetState(ctx);
  resetCrm(ctx);
  zoomDriver(ctx, 'fake');
  crmAt(ctx, '2026-11-16T09:00:00Z');
  const signed = await signedIn(ctx, 'csr');
  csr = signed.client;
  csrId = signed.user.id;
  leadId = (
    await crmLead(ctx, {
      status: 'contacted',
      assignedToId: csrId,
      parentName: 'Umm Maryam',
      countryCode: 'GB',
      email: 'umm.maryam@example.com',
    })
  ).id;
  courseId = (await makeCourse(ctx)).id;
  const account = await csr.post(`/leads/${leadId}/account`, {
    parentName: 'Umm Maryam',
    email: 'umm.maryam@example.com',
    phone: '+447700900123',
    timezone: 'Europe/London',
    countryCode: 'GB',
    children: [{ name: 'Maryam', age: 8, gender: 'female', courseId }],
  });
  expect(account.status).toBe(201);
  studentId = account.body.data.students[0].id;
});

describe('T3 first to accept wins', () => {
  it('offers to the eligible teachers, who see only course, time and the child', async () => {
    const a = await teacher('Amina');
    const b = await teacher('Basma');
    const other = await teacher('Dalia', false);
    const res = await offer({ note: 'Beginner, shy child' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'open',
      policy: 'first_accept',
      audience: 'eligible',
      familyLocal: { date: '2026-11-18', time: '17:00' },
      expiresAt: '2026-11-16T11:00:00.000Z',
    });
    expect(
      res.body.data.teachers.map((t: { teacher: { id: number } }) => t.teacher.id).sort(),
    ).toEqual([a.id, b.id].sort());
    const notices = await ctx.prisma.notification.findMany({
      where: { kind: 'trial', event: 'trial_offer' },
    });
    expect(notices.map((n) => n.userId).sort()).toEqual([a.userId, b.userId].sort());

    const mine = await a.client.get('/me/trial-offers');
    expect(mine.status).toBe(200);
    expect(mine.body.data).toEqual([
      expect.objectContaining({
        id: res.body.data.id,
        state: 'open',
        teacherZone: 'Africa/Cairo',
        teacherLocal: { date: '2026-11-18', time: '19:00' },
        student: { age: 8, gender: 'female', level: null },
        note: 'Beginner, shy child',
        myResponse: null,
        sessionId: null,
      }),
    ]);
    const seen =
      JSON.stringify(mine.body) + JSON.stringify(notices) + JSON.stringify(ctx.mailer.sent);
    expect(seen).not.toMatch(/Maryam|umm\.maryam|7700900123/);

    // Not offered to Dalia: nothing to see, nothing to accept.
    expect((await other.client.get('/me/trial-offers')).body.data).toEqual([]);
    expect((await other.client.post(`/me/trial-offers/${res.body.data.id}/accept`)).status).toBe(
      404,
    );
  });

  it('books the first teacher to accept; the others see it taken', async () => {
    const a = await teacher('Amina');
    const b = await teacher('Basma');
    const id = (await offer()).body.data.id;
    const won = await a.client.post(`/me/trial-offers/${id}/accept`);
    expect(won.status).toBe(200);
    expect(won.body.data).toMatchObject({ state: 'mine', myResponse: 'accept' });
    const session = await ctx.prisma.classSession.findUniqueOrThrow({
      where: { id: won.body.data.sessionId },
    });
    expect(session).toMatchObject({ teacherId: a.id, kind: 'trial', studentId });
    expect(session.startsAt.toISOString()).toBe('2026-11-18T17:00:00.000Z');
    expect((await ctx.prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe(
      'trial_scheduled',
    );

    const lost = await b.client.post(`/me/trial-offers/${id}/accept`);
    expect(lost.status).toBe(409);
    expect(lost.body.code).toBe('offer_taken');
    expect((await b.client.get('/me/trial-offers')).body.data[0].state).toBe('taken');
    expect(await leadNotices('trial_offer_claimed')).toBe(1);
    const shown = await csr.get(`/trial-offers/${id}`);
    expect(shown.body.data).toMatchObject({
      status: 'claimed',
      claimedTeacher: { id: a.id },
      sessionId: session.id,
    });
  });

  it('lets only one of two simultaneous accepts win', async () => {
    const a = await teacher('Amina');
    const b = await teacher('Basma');
    const id = (await offer()).body.data.id;
    const results = await Promise.all([
      a.client.post(`/me/trial-offers/${id}/accept`),
      b.client.post(`/me/trial-offers/${id}/accept`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await ctx.prisma.classSession.count({ where: { kind: 'trial' } })).toBe(1);
  });

  it('re-opens the offer when the teacher can no longer take it', async () => {
    const a = await teacher('Amina');
    const id = (await offer()).body.data.id;
    await ctx.prisma.teacherBlock.create({
      data: {
        teacherId: a.id,
        kind: 'one_off',
        startsAt: new Date('2026-11-18T16:30:00Z'),
        endsAt: new Date('2026-11-18T18:00:00Z'),
      },
    });
    const res = await a.client.post(`/me/trial-offers/${id}/accept`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('offer_unavailable');
    expect((await csr.get(`/trial-offers/${id}`)).body.data.status).toBe('open');
    expect(await ctx.prisma.classSession.count()).toBe(0);
  });

  it('holds back a teacher who already holds the most offers', async () => {
    await ctx.app.get(SettingsService).set('crm.trial_offer_max_open_claims', 1, null);
    const a = await teacher('Amina');
    const first = (await offer()).body.data.id;
    expect((await a.client.post(`/me/trial-offers/${first}/accept`)).status).toBe(200);
    // A second lead, same teacher.
    const lead2 = (await crmLead(ctx, { status: 'contacted', assignedToId: csrId })).id;
    const acc = await csr.post(`/leads/${lead2}/account`, {
      parentName: 'Abu Zaid',
      email: 'abu.zaid@example.com',
      timezone: 'Europe/London',
      children: [{ name: 'Zaid', age: 9, gender: 'male', courseId }],
    });
    const second = await csr.post(`/leads/${lead2}/trial-offers`, {
      studentId: acc.body.data.students[0].id,
      courseId,
      localDate: '2026-11-19',
      localTime: '17:00',
    });
    expect(second.status).toBe(201);
    const res = await a.client.post(`/me/trial-offers/${second.body.data.id}/accept`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('claim_limit');
  });

  it('a decline is recorded and the offer stays open', async () => {
    const a = await teacher('Amina');
    const id = (await offer()).body.data.id;
    const res = await a.client.post(`/me/trial-offers/${id}/decline`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ state: 'open', myResponse: 'decline' });
    expect((await csr.get(`/trial-offers/${id}`)).body.data.teachers[0].response).toBe('decline');
  });
});

describe('T3 volunteers, shortlist and limits', () => {
  it('volunteers, then the CSR assigns one of the offer’s teachers', async () => {
    const a = await teacher('Amina');
    const b = await teacher('Basma');
    const outsider = await teacher('Dalia', false);
    const id = (await offer({ policy: 'volunteer' })).body.data.id;
    const vol = await a.client.post(`/me/trial-offers/${id}/accept`);
    expect(vol.status).toBe(200);
    expect(vol.body.data).toMatchObject({ state: 'open', myResponse: 'volunteer' });
    expect(await ctx.prisma.classSession.count()).toBe(0);
    expect(await leadNotices('trial_offer_volunteer')).toBe(1);

    const wrong = await csr.post(`/trial-offers/${id}/assign`, { teacherId: outsider.id });
    expect(wrong.status).toBe(422);
    const ok = await csr.post(`/trial-offers/${id}/assign`, {
      teacherId: a.id,
      acknowledgeWarnings: ['outside_work_hours'],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'claimed', claimedTeacher: { id: a.id } });
    expect((await b.client.get('/me/trial-offers')).body.data[0].state).toBe('taken');
  });

  it('a shortlist goes only to the chosen eligible teachers', async () => {
    const a = await teacher('Amina');
    await teacher('Basma');
    const outsider = await teacher('Dalia', false);
    const bad = await offer({ audience: 'shortlist', teacherIds: [a.id, outsider.id] });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.teacherIds).toBeDefined();
    expect((await offer({ audience: 'shortlist' })).status).toBe(422);
    const ok = await offer({ audience: 'shortlist', teacherIds: [a.id] });
    expect(ok.status).toBe(201);
    expect(ok.body.data.teachers).toHaveLength(1);
  });

  it('one open offer per student; nobody eligible; too close to the trial', async () => {
    expect((await offer()).status).toBe(422); // no teacher at all
    expect((await offer()).body.code).toBe('no_eligible_teachers');
    await teacher('Amina');
    expect((await offer()).status).toBe(201);
    const again = await offer();
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('offer_open');
    // Today 13:00 London is only 4 h away (< 6 h + 15 min).
    const late = await offer({ localDate: '2026-11-16', localTime: '13:00' });
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('offer_too_late');
  });

  it('closes at the deadline, tells the CSR once, and can be sent again or cancelled', async () => {
    const a = await teacher('Amina');
    const id = (await offer({ expiresInMinutes: 30 })).body.data.id;
    clock(ctx).set(new Date('2026-11-16T09:31:00Z'));
    const tooLate = await a.client.post(`/me/trial-offers/${id}/accept`);
    expect(tooLate.status).toBe(409);
    expect(tooLate.body.code).toBe('offer_closed');
    const jobs = ctx.app.get(TrialOffers);
    expect(await jobs.expireDue()).toBe(1);
    expect(await jobs.expireDue()).toBe(0);
    expect(await leadNotices('trial_offer_expired')).toBe(1);
    expect((await a.client.get('/me/trial-offers')).body.data[0].state).toBe('closed');

    const resent = await csr.post(`/trial-offers/${id}/resend`, {});
    expect(resent.status).toBe(200);
    expect(resent.body.data).toMatchObject({
      status: 'open',
      expiresAt: '2026-11-16T11:31:00.000Z',
    });
    expect((await a.client.get('/me/trial-offers')).body.data[0].state).toBe('open');
    const cancelled = await csr.post(`/trial-offers/${id}/cancel`, { reason: 'Booked by phone' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect((await csr.post(`/trial-offers/${id}/cancel`, {})).status).toBe(409);
    expect((await csr.post(`/trial-offers/${id}/resend`, {})).status).toBe(409);
    // A new offer for the student is possible again.
    expect((await offer()).status).toBe(201);
  });
});

describe('T3 access', () => {
  it('401 signed out; 403 for the wrong side; 404 for an unknown offer', async () => {
    await teacher('Amina');
    const id = (await offer()).body.data.id;
    const anon = await new Client(ctx.app).init();
    expect((await anon.get('/me/trial-offers')).status).toBe(401);
    expect((await anon.post(`/leads/${leadId}/trial-offers`, {})).status).toBe(401);
    expect((await anon.post(`/me/trial-offers/${id}/accept`)).status).toBe(401);

    const { client: parent } = await signedIn(ctx, 'parent');
    expect((await parent.get('/me/trial-offers')).status).toBe(403);
    expect((await csr.get('/me/trial-offers')).status).toBe(403);
    // An admin has every permission but no teacher profile.
    const { client: admin } = await signedIn(ctx, 'admin');
    const notTeacher = await admin.get('/me/trial-offers');
    expect(notTeacher.status).toBe(403);
    expect(notTeacher.body.code).toBe('not_a_teacher');

    const { client: t } = await signedIn(ctx, 'teacher');
    expect((await t.post(`/leads/${leadId}/trial-offers`, {})).status).toBe(403);
    expect((await t.get(`/trial-offers/${id}`)).status).toBe(403);
    expect((await t.post(`/trial-offers/${id}/cancel`, {})).status).toBe(403);
    expect((await csr.get('/trial-offers/999999')).status).toBe(404);
    expect((await csr.get(`/leads/${leadId}/trial-offers`)).body.data).toHaveLength(1);
  });
});
