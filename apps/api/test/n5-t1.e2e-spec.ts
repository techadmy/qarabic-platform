import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LeadAlerts } from '../src/crm/alerts.js';
import { LeadService } from '../src/crm/lead.service.js';
import {
  createTestApp,
  createUser,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';
import { alerts, crmAt, crmLead, resetCrm, setSetting } from './n5-helpers.js';

/*
| Port of Laravel tests/Feature/Crm/{LeadsT1AssignmentTest, LeadsT1AlertsTest} (docs/33 §3.2–3.3,
| B80, B84, D136, D137): round-robin among the CSR pool, lead-admin fallback, the leads.assign
| holders told when nobody can take a lead; first-response SLA and follow-up alerts (idempotent).
| `crm.shift_source=attendance` uses N7 staff attendance: checked in now, not checked out, no
| approved leave that day (Laravel check-in / leave cases).
*/

let ctx: TestContext;
type U = { id: number };

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await resetState(ctx);
  resetCrm(ctx);
  crmAt(ctx, '2026-11-16T09:00:00Z'); // 11:00 Cairo, Monday
});

const intake = async (suffix: string, extra: Record<string, unknown> = {}) =>
  (
    await ctx.app.get(LeadService).intake({
      parentName: `Parent ${suffix}`,
      email: `parent${suffix}@example.com`,
      phone: `+20100000${suffix.padStart(4, '0')}`,
      children: [{ age: 7 }],
      source: 'web_form',
      ...extra,
    })
  ).lead!;

describe('Leads T1: automatic assignment', () => {
  let a: U;
  let b: U;
  let c: U;

  beforeEach(async () => {
    a = await createUser(ctx, 'csr');
    b = await createUser(ctx, 'csr');
    c = await createUser(ctx, 'csr');
  });

  it('rotates new leads among the CSRs in id order', async () => {
    const owners = [];
    for (const i of ['1', '2', '3', '4']) owners.push((await intake(i)).assignedToId);
    expect(owners).toEqual([a.id, b.id, c.id, a.id]);

    const lead = await ctx.prisma.lead.findFirstOrThrow({ orderBy: { id: 'asc' } });
    expect(lead.autoAssignedAt).not.toBeNull();
    const assigned = await ctx.prisma.leadActivity.findFirstOrThrow({
      where: { leadId: lead.id, type: 'assigned' },
    });
    expect(assigned.meta).toMatchObject({ to: a.id, auto: 'round_robin' });
    expect(assigned.userId).toBeNull();
  });

  it('skips inactive and archived CSRs', async () => {
    await ctx.prisma.user.update({ where: { id: a.id }, data: { isActive: false } });
    await ctx.prisma.user.update({ where: { id: b.id }, data: { archivedAt: new Date() } });
    expect((await intake('1')).assignedToId).toBe(c.id);
    expect((await intake('2')).assignedToId).toBe(c.id);
  });

  it('only pools the configured roles (managers are not in the CSR rotation)', async () => {
    await ctx.prisma.user.updateMany({
      where: { id: { in: [a.id, b.id, c.id] } },
      data: { isActive: false },
    });
    const manager = await createUser(ctx, 'manager');
    expect((await intake('1')).assignedToId).toBeNull();

    await setSetting(ctx, 'crm.auto_assign_roles', []);
    expect((await intake('2')).assignedToId).toBe(manager.id);
  });

  it('assigns with no shift limit by default (D137: the owner sees it on their next shift)', async () => {
    crmAt(ctx, '2026-11-16T21:00:00Z'); // 23:00 Cairo
    expect((await intake('1')).assignedToId).toBe(a.id);
    expect((await intake('2')).assignedToId).toBe(b.id);
  });

  it('uses working hours as the shift when configured', async () => {
    await setSetting(ctx, 'crm.shift_source', 'hours');
    expect((await intake('1')).assignedToId).toBe(a.id);
    crmAt(ctx, '2026-11-16T21:00:00Z'); // 23:00 Cairo: outside 10–22
    expect((await intake('2')).assignedToId).toBeNull();
  });

  it('uses N7 attendance as the shift: only CSRs checked in now and not on approved leave', async () => {
    await setSetting(ctx, 'crm.shift_source', 'attendance');
    // Nobody checked in yet → nobody on shift.
    expect((await intake('1')).assignedToId).toBeNull();

    const day = new Date('2026-11-16T00:00:00Z');
    const checkIn = (userId: number, checkInAt: string, checkOutAt: string | null = null) =>
      ctx.prisma.staffAttendance.create({
        data: {
          userId,
          workDate: day,
          status: 'present',
          checkInAt: new Date(checkInAt),
          checkOutAt: checkOutAt ? new Date(checkOutAt) : null,
        },
      });
    await checkIn(a.id, '2026-11-16T07:00:00Z'); // on shift
    await checkIn(b.id, '2026-11-16T06:00:00Z', '2026-11-16T08:00:00Z'); // already checked out
    await checkIn(c.id, '2026-11-16T07:30:00Z'); // checked in, but on approved leave today
    await ctx.prisma.leaveRequest.create({
      data: {
        userId: c.id,
        startsOn: day,
        endsOn: day,
        days: 1,
        leaveType: 'paid',
        reason: 'Family matter',
        status: 'approved',
      },
    });
    expect((await intake('2')).assignedToId).toBe(a.id);
    expect((await intake('3')).assignedToId).toBe(a.id);
  });

  it('falls back to the lead admin when nobody is on shift', async () => {
    await setSetting(ctx, 'crm.shift_source', 'attendance');
    const admin = await createUser(ctx, 'manager');
    await setSetting(ctx, 'crm.lead_admin_user_id', admin.id);

    const lead = await intake('1');
    expect(lead.assignedToId).toBe(admin.id);
    const assigned = await ctx.prisma.leadActivity.findFirstOrThrow({
      where: { leadId: lead.id, type: 'assigned' },
    });
    expect((assigned.meta as { auto: string }).auto).toBe('lead_admin');
    const sent = await alerts(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ userId: admin.id, event: 'assigned' });
    expect(sent[0]!.data).toMatchObject({ kind: 'lead', leadId: lead.id, parentName: 'Parent 1' });

    // A lead admin who cannot work leads (or is inactive) is no fallback.
    await setSetting(ctx, 'crm.lead_admin_user_id', (await createUser(ctx, 'teacher')).id);
    expect((await intake('2')).assignedToId).toBeNull();
  });

  it('leaves the lead unassigned and tells every leads.assign holder when there is no fallback', async () => {
    await setSetting(ctx, 'crm.shift_source', 'attendance');
    const manager = await createUser(ctx, 'manager');
    const senior = await createUser(ctx, 'senior_manager');

    const lead = await intake('1');
    expect(lead.assignedToId).toBeNull();
    const sent = await alerts(ctx);
    expect(sent.map((s) => [s.userId, s.event])).toEqual([
      [manager.id, 'unassigned'],
      [senior.id, 'unassigned'],
    ]);
    expect(sent.some((s) => s.userId === a.id)).toBe(false);
    expect(ctx.mailer.sent.map((m) => m.kind)).toEqual(['lead_unassigned', 'lead_unassigned']);
  });

  it('does not assign spam, merged duplicates, or when auto-assign is off', async () => {
    const spam = (
      await ctx.app.get(LeadService).intake({
        parentName: 'x',
        email: 'a@b.co',
        message: "' or 1=1 --",
        source: 'web_form',
      })
    ).lead!;
    expect(spam.status).toBe('spam');
    expect(spam.assignedToId).toBeNull();

    const first = await intake('1');
    await ctx.prisma.lead.update({ where: { id: first.id }, data: { assignedToId: null } });
    await intake('1'); // same email → merged, no new assignment
    expect(
      (await ctx.prisma.lead.findUniqueOrThrow({ where: { id: first.id } })).assignedToId,
    ).toBeNull();

    await setSetting(ctx, 'crm.auto_assign_enabled', false);
    expect((await intake('2')).assignedToId).toBeNull();
  });

  it('notifies on manual reassignment but not when a CSR takes a lead', async () => {
    const lead = await crmLead(ctx);
    const { user: self, client } = await signedIn(ctx, 'csr');
    expect((await client.post(`/leads/${lead.id}/assign`, { userId: self.id })).status).toBe(200);
    expect(await alerts(ctx)).toEqual([]);

    const { client: manager } = await signedIn(ctx, 'manager');
    expect((await manager.post(`/leads/${lead.id}/assign`, { userId: b.id })).status).toBe(200);
    const sent = await alerts(ctx);
    expect(sent.map((s) => [s.userId, s.event])).toEqual([[b.id, 'assigned']]);
    expect(ctx.mailer.sent.map((m) => [m.kind, m.to])).toEqual([
      ['lead_assigned', (await ctx.prisma.user.findUniqueOrThrow({ where: { id: b.id } })).email],
    ]);
  });

  it('stores the in-app payload the bell shows (no contact details) and mails a link', async () => {
    await setSetting(ctx, 'crm.shift_source', 'attendance');
    const manager = await createUser(ctx, 'manager');
    const lead = await intake('9');
    const [row] = await alerts(ctx);
    expect(row).toEqual({
      userId: manager.id,
      event: 'unassigned',
      data: { kind: 'lead', event: 'unassigned', leadId: lead.id, parentName: 'Parent 9' },
    });
    const mail = ctx.mailer.sent[0]!;
    expect(mail.text).toContain(`/leads/${lead.id}`);
    expect(mail.text).not.toContain('parent9@example.com');
  });
});

describe('Leads T1: alerts (leads:notify)', () => {
  let csr: U;
  let manager: U;
  const run = () => ctx.app.get(LeadAlerts).run();

  beforeEach(async () => {
    csr = await createUser(ctx, 'csr');
    manager = await createUser(ctx, 'manager');
  });

  it('alerts the owner and the leads.assign holders once when the SLA is missed', async () => {
    const lead = await crmLead(ctx, { assignedToId: csr.id, source: 'web_form' });

    crmAt(ctx, '2026-11-16T09:29:00Z');
    expect(await run()).toEqual({ followUps: 0, sla: 0 });
    expect(await alerts(ctx)).toEqual([]);

    crmAt(ctx, '2026-11-16T09:31:00Z');
    expect(await run()).toEqual({ followUps: 0, sla: 1 });
    expect(await run()).toEqual({ followUps: 0, sla: 0 });

    const sent = await alerts(ctx);
    expect(sent.map((s) => [s.userId, s.event]).sort()).toEqual(
      [
        [csr.id, 'sla_breach'],
        [manager.id, 'sla_breach'],
      ].sort(),
    );
    expect(sent.find((s) => s.userId === csr.id)!.data.dueAt).toBe('2026-11-16T09:30:00Z');
    expect(
      (await ctx.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).slaNotifiedAt,
    ).not.toBeNull();
  });

  it('does not alert at night for a lead created after hours until 30 working minutes have passed', async () => {
    crmAt(ctx, '2026-11-16T21:00:00Z'); // 23:00 Cairo
    await crmLead(ctx, { assignedToId: csr.id });

    crmAt(ctx, '2026-11-17T08:20:00Z'); // 10:20 Cairo next day
    await run();
    expect(await alerts(ctx)).toEqual([]);

    crmAt(ctx, '2026-11-17T08:31:00Z');
    await run();
    expect((await alerts(ctx)).some((s) => s.userId === csr.id && s.event === 'sla_breach')).toBe(
      true,
    );
  });

  it('never alerts a lead already contacted, spam, or older than the look-back', async () => {
    await crmLead(ctx, {
      assignedToId: csr.id,
      firstResponseAt: new Date(),
      lastContactedAt: new Date(),
    });
    await crmLead(ctx, { assignedToId: csr.id, status: 'spam' });
    crmAt(ctx, '2026-11-10T09:00:00Z');
    await crmLead(ctx, { assignedToId: csr.id });

    crmAt(ctx, '2026-11-16T12:00:00Z');
    await run();
    expect(await alerts(ctx)).toEqual([]);
  });

  it('reminds the owner of a due follow-up once per follow-up time', async () => {
    const lead = await crmLead(ctx, {
      status: 'contacted',
      assignedToId: csr.id,
      firstResponseAt: new Date(),
      lastContactedAt: new Date(),
      nextFollowUpAt: new Date('2026-11-16T10:00:00Z'),
    });

    crmAt(ctx, '2026-11-16T09:55:00Z');
    await run();
    expect(await alerts(ctx)).toEqual([]);

    crmAt(ctx, '2026-11-16T10:00:00Z');
    expect((await run()).followUps).toBe(1);
    expect((await run()).followUps).toBe(0);
    let sent = await alerts(ctx);
    expect(sent.map((s) => [s.userId, s.event])).toEqual([[csr.id, 'follow_up_due']]);
    expect(sent[0]!.data.dueAt).toBe('2026-11-16T10:00:00Z');

    // A new follow-up time arms it again.
    await ctx.prisma.lead.update({
      where: { id: lead.id },
      data: { nextFollowUpAt: new Date('2026-11-17T10:00:00Z') },
    });
    crmAt(ctx, '2026-11-17T10:05:00Z');
    await run();
    sent = await alerts(ctx);
    expect(sent.filter((s) => s.userId === csr.id)).toHaveLength(2);
    expect(sent.some((s) => s.userId === manager.id)).toBe(false);
  });

  it('skips follow-ups of closed or unassigned leads, and inactive owners', async () => {
    await crmLead(ctx, {
      status: 'lost',
      lostReason: 'price',
      assignedToId: csr.id,
      nextFollowUpAt: new Date('2026-11-16T08:00:00Z'),
      firstResponseAt: new Date(),
    });
    await crmLead(ctx, {
      status: 'contacted',
      nextFollowUpAt: new Date('2026-11-16T08:00:00Z'),
      firstResponseAt: new Date(),
    });
    const gone = await createUser(ctx, 'csr', { isActive: false });
    await crmLead(ctx, {
      status: 'contacted',
      assignedToId: gone.id,
      nextFollowUpAt: new Date('2026-11-16T08:00:00Z'),
      firstResponseAt: new Date(),
    });
    await run();
    expect(await alerts(ctx)).toEqual([]);
  });

  it('sets firstResponseAt on the first contact and counts every attempt', async () => {
    const lead = await crmLead(ctx, { assignedToId: csr.id });
    const client = await signInAs(
      ctx,
      await ctx.prisma.user.findUniqueOrThrow({ where: { id: csr.id } }),
    );

    expect(
      (await client.post(`/leads/${lead.id}/activities`, { type: 'note', body: 'internal' }))
        .status,
    ).toBe(201);
    let fresh = await ctx.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(fresh.firstResponseAt).toBeNull();
    expect(fresh.contactAttempts).toBe(0);

    crmAt(ctx, '2026-11-16T09:10:00Z');
    await client.post(`/leads/${lead.id}/activities`, {
      type: 'whatsapp',
      callResult: 'no_answer',
      nextFollowUpAt: '2026-11-17T09:00:00Z',
    });
    crmAt(ctx, '2026-11-16T11:00:00Z');
    await client.post(`/leads/${lead.id}/activities`, {
      type: 'whatsapp',
      callResult: 'no_answer',
    });

    fresh = await ctx.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(fresh.firstResponseAt?.toISOString()).toBe('2026-11-16T09:10:00.000Z');
    expect(fresh.contactAttempts).toBe(2);
    expect(fresh.status).toBe('contacted');

    let show = (await client.get(`/leads/${lead.id}`)).body.data;
    expect(show).toMatchObject({
      contactAttempts: 2,
      unansweredAttempts: 2,
      suggestLostNoResponse: false,
      firstResponseAt: '2026-11-16T09:10:00Z',
    });

    await client.post(`/leads/${lead.id}/activities`, { type: 'call', callResult: 'busy' });
    show = (await client.get(`/leads/${lead.id}`)).body.data;
    expect(show).toMatchObject({ unansweredAttempts: 3, suggestLostNoResponse: true });

    await client.post(`/leads/${lead.id}/activities`, { type: 'whatsapp', callResult: 'reached' });
    show = (await client.get(`/leads/${lead.id}`)).body.data;
    expect(show).toMatchObject({ unansweredAttempts: 0, contactAttempts: 4 });
  });

  it('shows the «not contacted» tile and filter with the overdue count', async () => {
    const late = await crmLead(ctx, { assignedToId: csr.id });
    crmAt(ctx, '2026-11-16T09:20:00Z');
    const fresh = await crmLead(ctx, { assignedToId: csr.id });
    await crmLead(ctx, {
      status: 'contacted',
      firstResponseAt: new Date(),
      lastContactedAt: new Date(),
    });

    crmAt(ctx, '2026-11-16T09:40:00Z');
    const client = await signInAs(
      ctx,
      await ctx.prisma.user.findUniqueOrThrow({ where: { id: csr.id } }),
    );
    const tiles = (await client.get('/leads/summary')).body.data;
    expect(tiles).toMatchObject({ uncontacted: 2, firstResponseOverdue: 1 });
    const list = await client.get('/leads?uncontacted=1');
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data[0]).toMatchObject({ id: fresh.id, firstResponseOverdue: false });
    expect(list.body.data[1]).toMatchObject({
      id: late.id,
      firstResponseOverdue: true,
      firstResponseDueAt: '2026-11-16T09:30:00Z',
    });
  });
});
