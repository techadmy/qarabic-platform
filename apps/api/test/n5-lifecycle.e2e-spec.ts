import { permissionsFor } from '@qarabic/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Client,
  createTestApp,
  createUser,
  makeCustomRole,
  makeFamily,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';
import { alerts, crmAt, crmLead, resetCrm } from './n5-helpers.js';

/*
| Port of Laravel tests/Feature/Crm/{LeadLifecycleTest, CrmPermissionsTest}: status transitions,
| timeline, list tabs / filters, today tiles, funnel (D106); who sees and assigns leads (D108).
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

describe('LeadLifecycle', () => {
  let csr: { id: number };
  let client: Client;

  beforeEach(async () => {
    ({ user: csr, client } = await signedIn(ctx, 'csr'));
  });

  it('moves a new lead to contacted on the first call and keeps the timeline', async () => {
    const lead = await crmLead(ctx);

    expect(
      (
        await client.post(`/leads/${lead.id}/activities`, {
          type: 'note',
          body: 'Asked for evenings',
        })
      ).status,
    ).toBe(201);
    expect((await ctx.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
      'new',
    );

    const call = await client.post(`/leads/${lead.id}/activities`, {
      type: 'call',
      callResult: 'reached',
      body: 'Spoke to mother',
      nextFollowUpAt: '2026-11-18T15:00:00Z',
    });
    expect(call.status).toBe(201);
    expect(call.body.data.callResult).toBe('reached');
    expect(call.body.data.user.id).toBe(csr.id);

    const fresh = await ctx.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(fresh.status).toBe('contacted');
    expect(fresh.lastContactedAt?.toISOString()).toBe('2026-11-16T09:00:00.000Z');
    expect(fresh.nextFollowUpAt?.toISOString()).toBe('2026-11-18T15:00:00.000Z');

    const show = await client.get(`/leads/${lead.id}`);
    expect(show.status).toBe(200);
    expect(show.body.data.activities.map((a: { type: string }) => a.type)).toEqual([
      'status_changed',
      'call',
      'note',
    ]);

    const noResult = await client.post(`/leads/${lead.id}/activities`, { type: 'call' });
    expect(noResult.status).toBe(422);
    expect(noResult.body.errors.callResult).toBeDefined();
    expect(
      (await client.post(`/leads/${lead.id}/activities`, { type: 'status_changed' })).status,
    ).toBe(422);
    expect((await client.post(`/leads/${lead.id}/activities`, { type: 'note' })).status).toBe(422);
  });

  it('needs a reason to mark a lead lost and can reopen it (undo)', async () => {
    const lead = await crmLead(ctx, { status: 'contacted', lastContactedAt: new Date() });

    const noReason = await client.post(`/leads/${lead.id}/status`, { status: 'lost' });
    expect(noReason.status).toBe(422);
    expect(noReason.body.errors.lostReason).toBeDefined();

    const lost = await client.post(`/leads/${lead.id}/status`, {
      status: 'lost',
      lostReason: 'price',
      note: 'Too expensive',
    });
    expect(lost.status).toBe(200);
    expect(lost.body.data.status).toBe('lost');
    expect(lost.body.data.lostReason).toBe('price');
    expect(lost.body.data.statusNote).toBe('Too expensive');
    expect(lost.body.data.allowedActions).toContain('reopen');
    expect(lost.body.data.allowedActions).not.toContain('lose');

    const spam = await client.post(`/leads/${lead.id}/status`, { status: 'spam' });
    expect(spam.status).toBe(422);
    expect(spam.body.code).toBe('invalid_transition');

    const reopened = await client.post(`/leads/${lead.id}/status`, { status: 'reopen' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.status).toBe('contacted');
    expect(reopened.body.data.lostReason).toBeNull();

    const fresh = await crmLead(ctx);
    const job = await client.post(`/leads/${fresh.id}/status`, { status: 'job_applicant' });
    expect(job.body.data.status).toBe('job_applicant');
    expect(
      (await client.post(`/leads/${fresh.id}/status`, { status: 'reopen' })).body.data.status,
    ).toBe('new');
    expect(
      (await client.post(`/leads/${fresh.id}/status`, { status: 'contacted' })).body.data.status,
    ).toBe('contacted');
    expect((await client.post(`/leads/${fresh.id}/status`, { status: 'contacted' })).status).toBe(
      422,
    );
  });

  it('never reopens or parks a converted lead', async () => {
    const lead = await crmLead(ctx, { status: 'converted' });
    expect((await client.post(`/leads/${lead.id}/status`, { status: 'reopen' })).status).toBe(422);
    expect((await client.post(`/leads/${lead.id}/status`, { status: 'spam' })).status).toBe(422);
  });

  it('marks spam in bulk and reports the rows it could not change', async () => {
    const a = await crmLead(ctx);
    const b = await crmLead(ctx, { status: 'converted' });
    const res = await client.post('/leads/bulk/status', { ids: [a.id, b.id], status: 'spam' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      updated: [a.id],
      failed: [{ id: b.id, code: 'invalid_transition' }],
    });
    expect(
      (await client.post('/leads/bulk/status', { ids: [a.id], status: 'job_applicant' })).status,
    ).toBe(422);
    expect((await client.post('/leads/bulk/status', { ids: [a.id], status: 'lost' })).status).toBe(
      422,
    );
  });

  it('edits contact data and the follow-up date', async () => {
    const lead = await crmLead(ctx);
    const res = await client.patch(`/leads/${lead.id}`, {
      phone: '+44 7700 900 555',
      timezone: 'Europe/Dublin',
      nextFollowUpAt: '2026-11-17T10:00:00+02:00',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.phone).toBe('+44 7700 900 555');
    expect(res.body.data.timezone).toBe('Europe/Dublin');
    expect(res.body.data.nextFollowUpAt).toBe('2026-11-17T08:00:00Z');
    expect((await ctx.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).phoneDigits).toBe(
      '447700900555',
    );
    const bad = await client.patch(`/leads/${lead.id}`, { timezone: 'Mars/Olympus' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.timezone).toBeDefined();
    expect((await client.get('/leads/999999')).status).toBe(404);
    expect((await client.get('/leads/abc')).status).toBe(404);
  });

  it('lists open leads with tab counts, filters and search', async () => {
    const mine = await crmLead(ctx, {
      parentName: 'Khadija',
      assignedToId: csr.id,
      status: 'contacted',
      nextFollowUpAt: new Date('2026-11-16T20:00:00Z'),
    });
    await crmLead(ctx, { parentName: 'Zainab', source: 'web_form' });
    await crmLead(ctx, { parentName: 'Lost one', status: 'lost', lostReason: 'price' });
    await crmLead(ctx, { parentName: 'Spam', status: 'spam' });

    const all = await client.get('/leads');
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.meta.counts).toMatchObject({ open: 2, lost: 1, spam: 1, all: 4 });
    const ids = async (q: string) =>
      ((await client.get(`/leads${q}`)).body.data as Array<{ id: number; parentName: string }>).map(
        (r) => r.parentName,
      );
    expect(await ids('?assigned=me')).toEqual(['Khadija']);
    expect(await ids(`?assigned=${csr.id}`)).toEqual(['Khadija']);
    expect(await ids('?assigned=none')).toEqual(['Zainab']);
    expect(await ids('?source=web_form')).toEqual(['Zainab']);
    expect(await ids('?status=lost')).toEqual(['Lost one']);
    expect(await ids('?q=khad')).toEqual(['Khadija']);
    // The lead ID matches too (the emails of the other rows hold digits as well).
    expect(await ids(`?status=all&q=${mine.id}`)).toContain('Khadija');
    expect((await client.get(`/leads?q=${encodeURIComponent('7700 900')}`)).status).toBe(200);
    // Due before the end of today in Cairo (22:00Z).
    expect(await ids('?followUp=due&tz=Africa/Cairo')).toEqual(['Khadija']);
    expect((await client.get('/leads?status=bogus')).status).toBe(422);
    expect((await client.get('/leads?assigned=someone')).status).toBe(422);
    // LIKE wildcards are searched literally.
    expect(await ids(`?status=all&q=${encodeURIComponent('%')}`)).toEqual([]);
    expect(await ids('?status=all&q=_')).toEqual([]);
  });

  it('counts the today tiles in the viewer zone', async () => {
    await crmLead(ctx);
    await crmLead(ctx, { status: 'contacted', nextFollowUpAt: new Date('2026-11-16T21:30:00Z') }); // 23:30 Cairo today
    await crmLead(ctx, { status: 'converted', convertedAt: new Date('2026-11-02T10:00:00Z') });
    await crmLead(ctx, { status: 'converted', convertedAt: new Date('2026-10-30T10:00:00Z') });
    await crmLead(ctx, {
      status: 'lost',
      lostReason: 'price',
      statusChangedAt: new Date('2026-11-10T10:00:00Z'),
    });

    const cairo = await client.get('/leads/summary?tz=Africa/Cairo');
    expect(cairo.status).toBe(200);
    expect(cairo.body.data).toMatchObject({
      date: '2026-11-16',
      timezone: 'Africa/Cairo',
      new: 1,
      followUpsDue: 1,
      convertedThisMonth: 1,
      lostThisMonth: 1,
      openTotal: 2,
      unassigned: 2,
    });
    // In Auckland (UTC+13) 16 Nov ends at 11:00Z, so the follow-up is tomorrow's.
    const auckland = await client.get('/leads/summary?tz=Pacific/Auckland');
    expect(auckland.body.data).toMatchObject({ date: '2026-11-16', followUpsDue: 0 });
  });

  it('reports the funnel per source and per assignee', async () => {
    await crmLead(ctx, {
      source: 'web_form',
      assignedToId: csr.id,
      status: 'converted',
      lastContactedAt: new Date(),
    });
    await crmLead(ctx, { source: 'web_form', status: 'spam' });
    await crmLead(ctx, {
      source: 'phone',
      assignedToId: csr.id,
      status: 'contacted',
      lastContactedAt: new Date(),
    });
    await crmLead(ctx, { source: 'phone' });

    const res = await client.get('/leads/funnel?from=2026-11-01&to=2026-11-30');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toMatchObject({ created: 3, contacted: 2, converted: 1, spam: 1 });
    const web = res.body.data.bySource.find((r: { source: string }) => r.source === 'web_form');
    expect(web).toMatchObject({ created: 1, converted: 1, spam: 1 });
    const mine = res.body.data.byAssignee.find(
      (r: { user: { id: number } | null }) => r.user?.id === csr.id,
    );
    expect(mine).toMatchObject({ created: 2, converted: 1 });
    expect((await client.get('/leads/funnel?from=2026-11-30&to=2026-11-01')).status).toBe(422);
    const long = await client.get('/leads/funnel?from=2025-01-01&to=2026-11-30');
    expect(long.status).toBe(422);
    expect(long.body.code).toBe('range_too_long');
  });

  it('writes every lead change to the audit log', async () => {
    const lead = await crmLead(ctx);
    expect((await client.post(`/leads/${lead.id}/status`, { status: 'spam' })).status).toBe(200);
    const row = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { subjectType: 'lead', subjectId: lead.id, action: 'status_changed' },
    });
    expect(row.actorId).toBe(csr.id);
    expect(row.before).toMatchObject({ status: 'new' });
    expect(row.after).toMatchObject({ status: 'spam' });
  });

  it('keeps the timeline append-only in the database', async () => {
    const lead = await crmLead(ctx);
    await client.post(`/leads/${lead.id}/activities`, { type: 'note', body: 'x' });
    await expect(
      ctx.prisma.leadActivity.updateMany({ where: { leadId: lead.id }, data: { body: 'changed' } }),
    ).rejects.toThrow(/append-only/);
  });
});

describe('CrmPermissions (D108)', () => {
  it.each([
    ['admin', 200, 200, 201, 200],
    ['senior_manager', 200, 200, 201, 200],
    ['manager', 200, 200, 201, 200],
    ['csr', 200, 200, 201, 200],
    ['monitor', 403, 403, 403, 403],
    ['billing', 403, 403, 403, 403],
    ['accounts', 403, 403, 403, 403],
    ['teacher', 403, 403, 403, 403],
    ['parent', 403, 403, 403, 403],
  ])('keeps the CRM to sales roles: %s', async (role, list, show, create, summary) => {
    const lead = await crmLead(ctx);
    const { client } = await signedIn(ctx, role);
    expect((await client.get('/leads')).status).toBe(list);
    expect((await client.get(`/leads/${lead.id}`)).status).toBe(show);
    expect(
      (
        await client.post('/leads', {
          parentName: 'Abu Omar',
          phone: '+201000000001',
          source: 'phone',
        })
      ).status,
    ).toBe(create);
    expect((await client.get('/leads/summary')).status).toBe(summary);
  });

  it('gives leads.assign to managers only and leads.refer to parents only', () => {
    expect(permissionsFor('csr')).toContain('leads.manage');
    expect(permissionsFor('csr')).not.toContain('leads.assign');
    expect(permissionsFor('csr')).not.toContain('leads.refer');
    expect(permissionsFor('manager')).toContain('leads.assign');
    expect(permissionsFor('manager')).not.toContain('leads.refer');
    expect(permissionsFor('senior_manager')).toContain('leads.assign');
    expect(permissionsFor('parent')).toContain('leads.refer');
    expect(permissionsFor('parent')).not.toContain('leads.view');
  });

  it('lets a CSR take a free lead and release it, but not give it to someone else', async () => {
    const lead = await crmLead(ctx);
    const { user: csr, client } = await signedIn(ctx, 'csr');
    const other = await createUser(ctx, 'csr');

    const take = await client.post(`/leads/${lead.id}/assign`, { userId: csr.id });
    expect(take.status).toBe(200);
    expect(take.body.data.assignedTo.id).toBe(csr.id);
    expect(take.body.data.allowedActions).toContain('release');
    expect((await client.post(`/leads/${lead.id}/assign`, { userId: other.id })).status).toBe(403);
    const release = await client.post(`/leads/${lead.id}/assign`, { userId: null });
    expect(release.status).toBe(200);
    expect(release.body.data.assignedTo).toBeNull();

    await ctx.prisma.lead.update({ where: { id: lead.id }, data: { assignedToId: other.id } });
    // Taking a colleague's lead.
    expect((await client.post(`/leads/${lead.id}/assign`, { userId: csr.id })).status).toBe(403);
    expect(
      (await client.post('/leads/bulk/assign', { ids: [lead.id], userId: csr.id })).status,
    ).toBe(403);
    // A CSR taking a lead is not told about it.
    expect(await alerts(ctx)).toEqual([]);
  });

  it('lets a manager assign anyone in bulk and reports per-row failures', async () => {
    const lead = await crmLead(ctx);
    const second = await crmLead(ctx);
    const { client } = await signedIn(ctx, 'manager');
    const csr = await createUser(ctx, 'csr');

    const res = await client.post('/leads/bulk/assign', {
      ids: [lead.id, second.id, 999999],
      userId: csr.id,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toEqual([lead.id, second.id]);
    expect(res.body.data.failed[0]).toEqual({ id: 999999, code: 'not_found' });
    expect(await ctx.prisma.lead.count({ where: { assignedToId: csr.id } })).toBe(2);
    expect((await alerts(ctx)).map((a) => [a.userId, a.event])).toEqual([
      [csr.id, 'assigned'],
      [csr.id, 'assigned'],
    ]);

    // Only people who work leads can receive them.
    const teacher = await createUser(ctx, 'teacher');
    const bad = await client.post(`/leads/${lead.id}/assign`, { userId: teacher.id });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.userId).toBeDefined();
    const inactive = await createUser(ctx, 'csr', { isActive: false });
    expect((await client.post(`/leads/${lead.id}/assign`, { userId: inactive.id })).status).toBe(
      422,
    );
    expect(
      (await client.post('/leads/bulk/assign', { ids: [lead.id], userId: teacher.id })).status,
    ).toBe(422);
    expect(
      await ctx.prisma.leadActivity.count({ where: { leadId: lead.id, type: 'assigned' } }),
    ).toBe(1);
  });

  it('lists every assignable person with their open count', async () => {
    const csr = await createUser(ctx, 'csr', { name: 'Sara CSR' });
    await crmLead(ctx, { assignedToId: csr.id });
    await createUser(ctx, 'teacher');
    const { client } = await signedIn(ctx, 'manager');

    const rows = (await client.get('/leads/assignees')).body.data as Array<{
      id: number;
      name: string;
      role: string;
      openCount: number;
    }>;
    expect(rows.find((r) => r.id === csr.id)).toMatchObject({ name: 'Sara CSR', openCount: 1 });
    expect(rows.map((r) => r.role)).not.toContain('teacher');
  });

  it('needs schedule and family permissions on top of leads.manage for account, trial and convert', async () => {
    const lead = await crmLead(ctx);
    // leads.manage only (a custom role): every write of the trial flow is refused.
    const role = await makeCustomRole(ctx, ['leads.view', 'leads.manage']);
    const { client } = await signedIn(ctx, role.name);
    for (const path of ['account', 'trials', 'convert']) {
      expect((await client.post(`/leads/${lead.id}/${path}`, {})).status, path).toBe(403);
    }
    expect((await client.post(`/leads/${lead.id}/trial-outcome`, {})).status).toBe(422);
    expect((await client.get(`/leads/${lead.id}`)).body.data.allowedActions).not.toContain(
      'create_account',
    );
  });

  it('lets a parent refer but not read leads', async () => {
    const family = await makeFamily(ctx);
    const client = await signInAs(ctx, family.user);
    expect((await client.get('/leads')).status).toBe(403);
    expect(
      (await client.post('/me/referrals', { parentName: 'Hind', phone: '+971500000001' })).status,
    ).toBe(201);
    const { client: staff } = await signedIn(ctx, 'csr');
    expect(
      (await staff.post('/me/referrals', { parentName: 'Hind', phone: '+971500000001' })).status,
    ).toBe(403);
  });

  it('lets settings.manage holders change the CRM settings', async () => {
    const manager = await createUser(ctx, 'manager');
    const { client } = await signedIn(ctx, 'admin');
    const before = await client.get('/settings/crm');
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({
      'crm.shift_source': 'any',
      'crm.auto_assign_roles': ['csr'],
      'crm.trial_form_confirmation': false,
      'crm.web_lead_confirmation': false,
    });

    const res = await client.put('/settings/crm', {
      'crm.first_response_minutes': 45,
      'crm.shift_source': 'hours',
      'crm.auto_assign_roles': [],
      'crm.lead_admin_user_id': manager.id,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      'crm.first_response_minutes': 45,
      'crm.auto_assign_roles': [],
      'crm.web_lead_confirmation': false,
    });
    expect((await client.put('/settings/crm', { 'crm.shift_source': 'always' })).status).toBe(422);
    expect(
      (await client.put('/settings/crm', { 'crm.nope': 1 })).body.errors['crm.nope'],
    ).toBeDefined();
    expect(
      (await client.put('/settings/crm', { 'crm.auto_assign_roles': ['ghost'] })).body.errors[
        'crm.auto_assign_roles'
      ],
    ).toBeDefined();

    const { client: csr } = await signedIn(ctx, 'csr');
    expect((await csr.put('/settings/crm', { 'crm.first_response_minutes': 10 })).status).toBe(403);
  });
});
