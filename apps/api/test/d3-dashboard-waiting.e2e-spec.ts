import {
  DASHBOARD_WAITING_LINKS,
  permissionsFor,
  type Role,
  visibleWaiting,
} from '@qarabic/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Client,
  clock,
  createTestApp,
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
import { crmLead } from './n5-helpers.js';
import { billingFamily, issuedInvoice, makeFeePackage, resetBilling } from './n6-helpers.js';

/*
| D3 (docs/40 §3 row 3): «waiting for action» on GET /dashboard/metrics. Each item is the same
| filter as the list it links to, shown only to roles that may open that list; live, not cached.
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
  resetBilling(ctx);
  // The leave below is for 15:00: at 13:30 it is under the 2-hour notice, so it waits.
  clock(ctx).set('2026-11-10T13:30:00Z');
});

const STAFF: Role[] = [
  'admin',
  'senior_manager',
  'manager',
  'monitor',
  'csr',
  'billing',
  'accounts',
];
type Item = { key: string; count: number; href: string };
const waiting = async (c: Client) => {
  const res = await c.get('/dashboard/metrics');
  expect(res.status).toBe(200);
  return res.body.data.waiting as Item[];
};
const counts = (items: Item[]) => Object.fromEntries(items.map((i) => [i.key, i.count]));

/** One of each, plus a near miss each that must not count. */
async function seedQueues() {
  // Leads: one new and never contacted; one contacted.
  await crmLead(ctx);
  await crmLead(ctx, { lastContactedAt: clock(ctx).now() });

  // A payment held for review (P1-3). Credits: one unreviewed (P1-1), one reviewed.
  const { client: billing } = await signedIn(ctx, 'billing');
  const fam = await billingFamily(ctx, 'USD', [await makeFeePackage(ctx, { USD: '60.00' })]);
  const inv = await issuedInvoice(ctx, fam, '2026-11', '2026-11-07');
  const paid = await billing.post(`/invoices/${inv.id}/payments`, {
    method: 'cash',
    amount: '60',
    receivedOn: '2026-11-10',
  });
  expect(paid.status).toBe(201);
  await ctx.prisma.payment.update({
    where: { id: paid.body.data.id },
    data: { needsReview: true, reviewReason: 'test' },
  });
  await ctx.prisma.familyCredit.createMany({
    data: [
      { familyId: fam.id, currency: 'USD', amount: '5.00', remaining: '5.00' },
      {
        familyId: fam.id,
        currency: 'USD',
        amount: '7.00',
        remaining: '7.00',
        reviewedAt: clock(ctx).now(),
      },
    ],
  });

  // Session requests: a late leave from the parent waits; a reschedule is not a leave.
  const teacher = await m2Teacher(ctx);
  const family = await makeFamily(ctx, { timezone: 'Europe/London' });
  const enrollment = await m2Enrollment(
    ctx,
    await m2Student(ctx, 'Europe/London', family),
    teacher,
  );
  const session = await m2Session(ctx, enrollment, '2026-11-10T15:00:00Z');
  const parent = await signInAs(ctx, family.user);
  const leave = await parent.post('/session-requests', {
    type: 'leave',
    sessionId: session.id,
    reason: 'Doctor appointment',
  });
  expect(leave.body.data.status).toBe('pending');

  // Tickets: one past its first-response time, one still within it.
  await fbTicket(ctx, family.user, { slaDueAt: new Date('2026-11-10T12:00:00Z') });
  await fbTicket(ctx, family.user, { slaDueAt: new Date('2026-11-10T18:00:00Z') });
  return { session };
}

describe('GET /dashboard/metrics: waiting for action', () => {
  it('each staff role gets exactly the items whose list it may open, with their links', async () => {
    for (const role of STAFF) {
      const { client } = await signedIn(ctx, role);
      const items = await waiting(client);
      const expected = visibleWaiting(new Set<string>(permissionsFor(role)));
      expect(
        items.map((i) => i.key),
        role,
      ).toEqual(expected);
      for (const i of items) expect(i.href, role).toBe(DASHBOARD_WAITING_LINKS[i.key as never]);
    }
    // The owner sees all five.
    const { client: admin } = await signedIn(ctx, 'admin');
    expect((await waiting(admin)).map((i) => i.key)).toEqual([
      'leads_uncontacted',
      'payments_to_review',
      'credits_to_review',
      'leave_requests',
      'tickets_past_sla',
    ]);
  });

  it('counts the same rows as the lists behind them', async () => {
    await seedQueues();
    const { client: admin } = await signedIn(ctx, 'admin');
    const got = counts(await waiting(admin));
    expect(got).toMatchObject({
      leads_uncontacted: 1,
      payments_to_review: 1,
      credits_to_review: 1,
      leave_requests: 1,
    });

    // Each equals its own list for the same viewer.
    expect((await admin.get('/billing/payments/review')).body.data).toHaveLength(
      got.payments_to_review!,
    );
    expect((await admin.get('/billing/credits?needsReview=true')).body.data).toHaveLength(
      got.credits_to_review!,
    );
    expect((await admin.get('/session-requests?type=leave&status=pending')).body.data).toHaveLength(
      got.leave_requests!,
    );
    const support = await admin.get('/support/summary');
    expect(support.status).toBe(200);
    expect(got.tickets_past_sla).toBe(support.body.data.breachedTotal);
    expect(got.tickets_past_sla).toBeGreaterThanOrEqual(1);
  });

  it('is live: a queue that changes shows at once, though the rest of the response is cached', async () => {
    const { session } = await seedQueues();
    const { client: monitor } = await signedIn(ctx, 'monitor');
    const before = counts(await waiting(monitor));
    expect(before.leave_requests).toBe(1);
    await ctx.prisma.sessionRequest.updateMany({
      where: { sessionId: session.id },
      data: { status: 'cancelled' },
    });
    expect(counts(await waiting(monitor)).leave_requests).toBe(0);
  });

  it('teachers and parents get 403; no session 401', async () => {
    for (const role of ['teacher', 'parent']) {
      const { client } = await signedIn(ctx, role);
      expect((await client.get('/dashboard/metrics')).status, role).toBe(403);
    }
    expect((await request(ctx.app.getHttpServer()).get('/api/v1/dashboard/metrics')).status).toBe(
      401,
    );
  });
});
