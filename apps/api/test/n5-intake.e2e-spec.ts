import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CrmConfig, signWebLead } from '../src/crm/crm.config.js';
import {
  createTestApp,
  createUser,
  makeCourse,
  makeFamily,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';
import {
  alerts,
  crmAt,
  crmLead,
  publicGet,
  publicPost,
  resetCrm,
  setSetting,
  WEB_SECRET,
  wpPayload,
  wpPost,
} from './n5-helpers.js';

/*
| Port of Laravel tests/Feature/Crm/{LeadIntakeTest, LeadsT1PublicFormTest, WebLeadWebhookTest}:
| one lead per real person, spam parked, duplicates merged (D105, D107); the app's public trial
| form; the website's signed WPForms webhook (docs/33 §3.1).
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
  resetCrm(ctx);
  crmAt(ctx, '2026-11-16T09:00:00Z');
});

const form = (extra: Record<string, unknown> = {}) => ({
  Name: 'Umm Yusuf',
  Email: 'Umm.Yusuf@Example.com',
  Phone: '+1 (555) 000-1111',
  Country: 'CA',
  Gender: 'Female',
  Age: '8',
  Course: 'Quran',
  Notes: 'Evenings please',
  ...extra,
});

describe('LeadIntake: the old public form endpoint (POST /api/class-request, D105)', () => {
  it('turns the public form into a new lead with the country zone', async () => {
    const res = await publicPost(ctx, '/api/class-request', form());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: null });

    const lead = await ctx.prisma.lead.findFirstOrThrow();
    expect(lead).toMatchObject({
      status: 'new',
      email: 'umm.yusuf@example.com',
      phoneDigits: '15550001111',
      countryCode: 'CA',
      timezone: 'America/Toronto',
      courseInterest: 'Quran',
      source: 'web_form',
    });
    expect(lead.ipHash).toHaveLength(64);
    expect(lead.children).toEqual([{ age: 8, gender: 'female' }]);
    const first = await ctx.prisma.leadActivity.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(first.type).toBe('created');
  });

  it('parks spam in its own tab and still answers 200', async () => {
    const res = await publicPost(
      ctx,
      '/api/class-request',
      form({ Notes: "' or 1=1 --", Email: 'bot@example.com' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const lead = await ctx.prisma.lead.findFirstOrThrow();
    expect(lead.status).toBe('spam');
    expect(lead.spamFlags).toContain('sql');
    expect(lead.assignedToId).toBeNull();

    const { client } = await signedIn(ctx, 'csr');
    const list = await client.get('/leads');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(0);
    expect(list.body.meta.counts.spam).toBe(1);
  });

  it('merges a repeat submission into the open lead instead of a new row', async () => {
    await publicPost(ctx, '/api/class-request', form());
    crmAt(ctx, '2026-11-20T09:00:00Z');
    // Same phone, another email.
    await publicPost(
      ctx,
      '/api/class-request',
      form({ Email: 'other@example.com', Notes: 'Any news?' }),
    );

    const lead = await ctx.prisma.lead.findFirstOrThrow();
    expect(await ctx.prisma.lead.count()).toBe(1);
    expect(lead.submissions).toBe(2);
    const again = await ctx.prisma.leadActivity.findFirstOrThrow({
      where: { type: 'resubmitted' },
    });
    expect(again.body).toBe('Any news?');

    // Once closed: a new lead.
    await ctx.prisma.lead.update({
      where: { id: lead.id },
      data: { status: 'lost', lostReason: 'no_response' },
    });
    await publicPost(ctx, '/api/class-request', form());
    expect(await ctx.prisma.lead.count()).toBe(2);
  });

  it('opens a new lead after the 30-day duplicate window', async () => {
    await publicPost(ctx, '/api/class-request', form());
    crmAt(ctx, '2026-12-17T09:00:00Z');
    await publicPost(ctx, '/api/class-request', form());
    expect(await ctx.prisma.lead.count()).toBe(2);
  });

  it('ignores a submission without a name and a filled honeypot', async () => {
    expect((await publicPost(ctx, '/api/class-request', { Email: 'a@b.co' })).status).toBe(200);
    expect(
      (await publicPost(ctx, '/api/class-request', form({ website: 'http://spam.example' })))
        .status,
    ).toBe(200);
    expect(await ctx.prisma.lead.count()).toBe(0);
  });

  it('keeps the referring family when a referral merges into an open lead', async () => {
    await publicPost(ctx, '/api/class-request', { Name: 'Hind', Phone: '+971500000001' });
    const family = await makeFamily(ctx);
    const client = await signInAs(ctx, family.user);

    const res = await client.post('/me/referrals', {
      parentName: 'Hind',
      phone: '+971 50 000 0001',
    });
    expect(res.status).toBe(201);

    const lead = await ctx.prisma.lead.findFirstOrThrow();
    expect(lead.submissions).toBe(2);
    expect(lead.referralFamilyId).toBe(family.id);
  });
});

describe('LeadIntake: referrals and manual leads', () => {
  it('lets a parent refer a friend, linked to their family', async () => {
    const family = await makeFamily(ctx);
    const client = await signInAs(ctx, family.user);

    const res = await client.post('/me/referrals', {
      parentName: 'Hind',
      phone: '+971500000001',
      childrenCount: 2,
      message: 'My neighbour',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ data: { received: true } });

    const lead = await ctx.prisma.lead.findFirstOrThrow();
    expect(lead.source).toBe('referral');
    expect(lead.referralFamilyId).toBe(family.id);
    expect(lead.children).toHaveLength(2);

    const bad = await client.post('/me/referrals', { parentName: 'Hind' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.phone).toBeDefined();
  });

  it('throttles referrals per parent', async () => {
    resetCrm(ctx).referralsPerHour = 2;
    const family = await makeFamily(ctx);
    const client = await signInAs(ctx, family.user);
    for (const i of [1, 2]) {
      const res = await client.post('/me/referrals', {
        parentName: `Friend ${i}`,
        phone: `+97150000000${i}`,
      });
      expect(res.status).toBe(201);
    }
    const res = await client.post('/me/referrals', {
      parentName: 'Friend',
      phone: '+971500000009',
    });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('too_many_requests');
  });

  it('refuses a referral from a user who has no family (403)', async () => {
    const parent = await createUser(ctx, 'parent');
    const client = await signInAs(ctx, parent);
    const res = await client.post('/me/referrals', { parentName: 'Hind', phone: '+971500000001' });
    expect(res.status).toBe(403);
  });

  it('creates a manual lead assigned to the creator, with duplicates shown on the workbench', async () => {
    const existing = await crmLead(ctx, { phone: '+20 100 000 0001' });
    const family = await makeFamily(ctx, { user: { phone: '+201000000001' } });
    const { user: csr, client } = await signedIn(ctx, 'csr');

    const res = await client.post('/leads', {
      parentName: 'Abu Omar',
      phone: '+201000000001',
      source: 'phone',
      countryCode: 'eg',
      children: [{ name: 'Omar', age: 7, gender: 'male' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.assignedTo.id).toBe(csr.id);
    expect(res.body.data.timezone).toBe('Africa/Cairo');
    expect(res.body.data.duplicates.leads[0].id).toBe(existing.id);
    expect(res.body.data.duplicates.families[0].id).toBe(family.id);
    expect(await ctx.prisma.lead.count()).toBe(2);

    const noContact = await client.post('/leads', { parentName: 'No contact', source: 'phone' });
    expect(noContact.status).toBe(422);
    expect(noContact.body.errors.phone).toBeDefined();
    const web = await client.post('/leads', {
      parentName: 'Web',
      phone: '+201000000002',
      source: 'web_form',
    });
    expect(web.status).toBe(422);
    expect(web.body.errors.source).toBeDefined();
  });

  it('lets only leads.assign holders create a lead for someone else', async () => {
    const other = await createUser(ctx, 'csr');
    const { client } = await signedIn(ctx, 'csr');
    const res = await client.post('/leads', {
      parentName: 'Abu Omar',
      phone: '+201000000003',
      source: 'phone',
      assignedTo: other.id,
    });
    expect(res.status).toBe(403);
    const { client: manager } = await signedIn(ctx, 'manager');
    const ok = await manager.post('/leads', {
      parentName: 'Abu Omar',
      phone: '+201000000003',
      source: 'phone',
      assignedTo: other.id,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.assignedTo.id).toBe(other.id);
    expect((await alerts(ctx)).map((a) => [a.userId, a.event])).toEqual([[other.id, 'assigned']]);
  });
});

describe('Leads T1: the app public trial form', () => {
  let courseId: number;
  const trial = (extra: Record<string, unknown> = {}) => ({
    parentName: 'Umm Yusuf',
    phone: '+447700900123',
    email: 'Umm.Yusuf@Example.com',
    countryCode: 'GB',
    timezone: 'Europe/London',
    children: [{ name: 'Yusuf', age: 8, gender: 'male', courseId }],
    preferredDays: [6, 7],
    preferredPeriods: ['evening'],
    preferredNote: 'after 5 pm',
    teacherGenderPref: 'female',
    heardFrom: 'instagram',
    message: 'He knows the alphabet.',
    utm: { source: 'ig', campaign: 'ramadan' },
    locale: 'en',
    ...extra,
  });

  beforeEach(async () => {
    courseId = (await makeCourse(ctx, { nameEn: 'Quran for Kids', nameAr: 'القرآن للأطفال' })).id;
  });

  it('lists courses publicly with no internal fields', async () => {
    await ctx.prisma.course.create({ data: { nameEn: 'Old', nameAr: 'قديم', isActive: false } });
    const res = await publicGet(ctx, '/public/courses');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: courseId, nameAr: 'القرآن للأطفال', nameEn: 'Quran for Kids', category: 'regular' },
    ]);
  });

  it('creates a structured lead from a valid request, with no CSRF token or login', async () => {
    const res = await publicPost(ctx, '/public/trial-requests', trial());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ data: { received: true } });

    const lead = await ctx.prisma.lead.findFirstOrThrow();
    expect(lead).toMatchObject({
      status: 'new',
      source: 'web_form',
      site: 'app_trial',
      email: 'umm.yusuf@example.com',
      phoneDigits: '447700900123',
      timezone: 'Europe/London',
      preferredTimes: 'Sat, Sun · evening · after 5 pm',
      teacherGenderPref: 'female',
      heardFrom: 'instagram',
      courseInterest: 'Quran for Kids',
      contactAttempts: 0,
      firstResponseAt: null,
      preferredLanguage: 'en',
    });
    expect(lead.preferredSchedule).toEqual({
      days: [6, 7],
      periods: ['evening'],
      note: 'after 5 pm',
    });
    expect(lead.children).toEqual([{ name: 'Yusuf', age: 8, gender: 'male', courseId }]);
    expect(lead.utm).toEqual({ source: 'ig', campaign: 'ramadan' });
  });

  it('sends no confirmation by default (D140) and one when the setting is on', async () => {
    await publicPost(ctx, '/public/trial-requests', trial());
    expect(ctx.mailer.sent.filter((m) => m.kind === 'trial_request_received')).toHaveLength(0);

    await setSetting(ctx, 'crm.trial_form_confirmation', true);
    await publicPost(
      ctx,
      '/public/trial-requests',
      trial({ email: 'second@example.com', phone: '+447700900999' }),
    );
    const sent = ctx.mailer.sent.filter((m) => m.kind === 'trial_request_received');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('second@example.com');
  });

  it.each([
    ['phone not E.164', { phone: '07700 900123' }, 'phone'],
    ['no email', { email: null }, 'email'],
    ['bad zone', { timezone: 'Mars/Olympus' }, 'timezone'],
    ['no children', { children: [] }, 'children'],
    ['no days', { preferredDays: [] }, 'preferredDays'],
    ['bad period', { preferredPeriods: ['midnight'] }, 'preferredPeriods.0'],
    ['bad teacher gender', { teacherGenderPref: 'robot' }, 'teacherGenderPref'],
    ['unknown source', { heardFrom: 'tv' }, 'heardFrom'],
  ])('rejects invalid requests field by field: %s', async (_name, override, field) => {
    const res = await publicPost(ctx, '/public/trial-requests', trial(override));
    expect(res.status).toBe(422);
    expect(res.body.errors[field]).toBeDefined();
    expect(await ctx.prisma.lead.count()).toBe(0);
  });

  it('rejects a child course that does not exist', async () => {
    const res = await publicPost(
      ctx,
      '/public/trial-requests',
      trial({ children: [{ name: 'Yusuf', age: 8, gender: 'male', courseId: 999999 }] }),
    );
    expect(res.status).toBe(422);
    expect(res.body.errors['children.0.courseId']).toBeDefined();
  });

  it('answers a filled honeypot like a success and stores nothing', async () => {
    const res = await publicPost(
      ctx,
      '/public/trial-requests',
      trial({ website: 'http://spam.example' }),
    );
    expect(res.status).toBe(200);
    expect(await ctx.prisma.lead.count()).toBe(0);
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('checks the captcha when one is configured', async () => {
    const config = resetCrm(ctx);
    config.captchaDriver = 'turnstile';
    config.turnstileSecret = 'test-turnstile';
    const res = await publicPost(ctx, '/public/trial-requests', trial());
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('captcha_failed');
  });

  it('rate limits the form per IP', async () => {
    resetCrm(ctx).classRequestPerMinute = 2;
    expect((await publicPost(ctx, '/public/trial-requests', trial())).status).toBe(201);
    expect(
      (
        await publicPost(
          ctx,
          '/public/trial-requests',
          trial({ email: 'other@example.com', phone: '+447700900124' }),
        )
      ).status,
    ).toBe(201);
    const res = await publicPost(
      ctx,
      '/public/trial-requests',
      trial({ email: 'third@example.com', phone: '+447700900125' }),
    );
    expect(res.status).toBe(429);
  });

  it('merges a repeat request into the open lead and still answers the same', async () => {
    expect((await publicPost(ctx, '/public/trial-requests', trial())).status).toBe(201);
    expect(
      (await publicPost(ctx, '/public/trial-requests', trial({ message: 'Again' }))).status,
    ).toBe(201);
    expect(await ctx.prisma.lead.count()).toBe(1);
    expect((await ctx.prisma.lead.findFirstOrThrow()).submissions).toBe(2);
  });

  it('auto-assigns leads of the old class-request endpoint too', async () => {
    await setSetting(ctx, 'crm.shift_source', 'hours'); // 09:00Z = 11:00 Cairo, inside 10–22
    const csr = await createUser(ctx, 'csr');
    await publicPost(ctx, '/api/class-request', {
      Name: 'Umm Ali',
      Email: 'ali@example.com',
      Phone: '+201000000001',
    });
    expect((await ctx.prisma.lead.findFirstOrThrow()).assignedToId).toBe(csr.id);
    expect((await alerts(ctx)).map((a) => [a.userId, a.event])).toEqual([[csr.id, 'assigned']]);
    expect(ctx.mailer.sent.map((m) => m.kind)).toEqual(['lead_assigned']);
  });
});

describe('Leads T1: the website WPForms webhook', () => {
  let courseId: number;

  beforeEach(async () => {
    resetCrm(ctx).webhookSecret = WEB_SECRET;
    courseId = (await makeCourse(ctx, { nameEn: 'Quran for Kids' })).id;
  });

  it('creates a mapped lead from a signed entry', async () => {
    const res = await wpPost(ctx, wpPayload());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ data: { received: true, duplicate: false } });

    const lead = await ctx.prisma.lead.findFirstOrThrow();
    expect(lead).toMatchObject({
      source: 'web_form',
      site: 'wpforms:4823',
      externalRef: 'wpforms:4823:1501',
      parentName: 'Umm Adam',
      phone: '+447700900321',
      countryCode: 'GB',
      timezone: 'Europe/London',
      courseInterest: 'Quran for Kids',
      status: 'new',
      message: '[Course for: Your Kids · Children: 2 · Age: 7 and 10]\nWeekends please',
    });
    expect(lead.children).toEqual([
      { age: 7, courseId },
      { age: 10, courseId },
    ]);
    expect(lead.utm).toEqual({
      source: 'google',
      medium: 'cpc',
      campaign: 'kids',
      page: 'https://qarabic.com/free-trial/',
      referer: 'https://www.google.com/',
    });
  });

  it('sends nothing to the family by default (crm.web_lead_confirmation off)', async () => {
    expect((await wpPost(ctx, wpPayload())).status).toBe(201);
    expect(ctx.mailer.sent.filter((m) => m.kind === 'trial_request_received')).toHaveLength(0);

    await setSetting(ctx, 'crm.web_lead_confirmation', true);
    const res = await wpPost(
      ctx,
      wpPayload({ email: 'second@example.com', phone: '+447700900999' }, { entry_id: 1502 }),
    );
    expect(res.status).toBe(201);
    expect(ctx.mailer.sent.filter((m) => m.kind === 'trial_request_received')).toHaveLength(1);
  });

  it('is idempotent on the WPForms entry id, also for a merged duplicate (replay protection)', async () => {
    expect((await wpPost(ctx, wpPayload())).status).toBe(201);
    const again = await wpPost(ctx, wpPayload());
    expect(again.status).toBe(200);
    expect(again.body.data.duplicate).toBe(true);
    expect(await ctx.prisma.lead.count()).toBe(1);
    expect((await ctx.prisma.lead.findFirstOrThrow()).submissions).toBe(1);

    // A second entry from the same family merges into the open lead; replaying it is a no-op too.
    expect((await wpPost(ctx, wpPayload({}, { entry_id: 1600 }))).status).toBe(201);
    const replay = await wpPost(ctx, wpPayload({}, { entry_id: 1600 }));
    expect(replay.status).toBe(200);
    expect(replay.body.data.duplicate).toBe(true);
    expect(await ctx.prisma.lead.count()).toBe(1);
    expect((await ctx.prisma.lead.findFirstOrThrow()).submissions).toBe(2);
  });

  it('treats concurrent deliveries of one entry as one lead', async () => {
    const results = await Promise.all([wpPost(ctx, wpPayload()), wpPost(ctx, wpPayload())]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await ctx.prisma.lead.count()).toBe(1);
  });

  it('rejects a bad signature, a stale or future timestamp, and a missing signature', async () => {
    const now = Math.floor(Date.parse('2026-11-16T09:00:00Z') / 1000);
    for (const res of [
      await wpPost(ctx, wpPayload(), { secret: 'wrong-secret' }),
      await wpPost(ctx, wpPayload(), { timestamp: now - 301 }),
      await wpPost(ctx, wpPayload(), { timestamp: now + 301 }),
      await wpPost(ctx, wpPayload(), { secret: null }),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_signature');
    }
    // Inside the 5-minute window it is accepted.
    expect((await wpPost(ctx, wpPayload(), { timestamp: now - 299 })).status).toBe(201);
  });

  it('rejects a tampered body even with a valid signature of another body', async () => {
    const original = JSON.stringify(wpPayload());
    const tampered = JSON.stringify(wpPayload({ name: 'Someone else' }));
    const ts = String(Math.floor(Date.parse('2026-11-16T09:00:00Z') / 1000));
    const forged = await request(ctx.app.getHttpServer())
      .post('/api/v1/public/web-leads/wpforms')
      .set('Content-Type', 'application/json')
      .set('X-Qarabic-Timestamp', ts)
      .set('X-Qarabic-Signature', signWebLead(WEB_SECRET, ts, original))
      .send(tampered);
    expect(forged.status).toBe(401);
    expect(await ctx.prisma.lead.count()).toBe(0);
  });

  it('is disabled while the secret is not set', async () => {
    resetCrm(ctx).webhookSecret = null;
    const res = await wpPost(ctx, wpPayload(), { secret: '' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('webhook_disabled');
  });

  it('ignores other forms and validates the payload', async () => {
    const other = await wpPost(ctx, wpPayload({}, { form_id: 99 }));
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('unknown_form');
    const noName = await wpPost(ctx, wpPayload({ name: '' }));
    expect(noName.status).toBe(422);
    expect(await ctx.prisma.lead.count()).toBe(0);
  });

  it('keeps an unmapped course as text, and uses the course map first', async () => {
    expect((await wpPost(ctx, wpPayload({ course: 'Learn Tafsir Al-Quran' }))).status).toBe(201);
    const lead = await ctx.prisma.lead.findFirstOrThrow();
    expect(lead.courseInterest).toBe('Learn Tafsir Al-Quran');
    expect((lead.children as Array<{ courseId?: number }>).every((c) => !c.courseId)).toBe(true);

    const tafsir = await makeCourse(ctx, { nameEn: 'Tafsir (adults)' });
    ctx.app.get(CrmConfig).courseMap = { 'pillars of islam': tafsir.id };
    const res = await wpPost(
      ctx,
      wpPayload(
        {
          course: 'Pillars Of Islam',
          email: 'p@example.com',
          phone: '+966500000001',
          course_for: 'You',
          student_age: '35',
        },
        { entry_id: 1700 },
      ),
    );
    expect(res.status).toBe(201);
    const adult = await ctx.prisma.lead.findUniqueOrThrow({
      where: { externalRef: 'wpforms:4823:1700' },
    });
    expect(adult.children).toEqual([{ name: 'Umm Adam', age: 35, courseId: tafsir.id }]);
    expect(adult.countryCode).toBe('SA');
    expect(adult.timezone).toBe('Asia/Riyadh');
  });

  it('throttles the webhook per IP', async () => {
    ctx.app.get(CrmConfig).webLeadsPerMinute = 1;
    expect((await wpPost(ctx, wpPayload())).status).toBe(201);
    expect((await wpPost(ctx, wpPayload({}, { entry_id: 2 }))).status).toBe(429);
  });

  it('needs no session or CSRF token, and never logs anyone in', async () => {
    const res = await wpPost(ctx, wpPayload());
    expect(res.status).toBe(201);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
