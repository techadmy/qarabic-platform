import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clock,
  createTestApp,
  m2Enrollment,
  m2Session,
  m2Student,
  m2Teacher,
  resetState,
  signedIn,
  type TestContext,
} from './helpers.js';
import { billingFamily, issuedInvoice, makeFeePackage, resetBilling } from './n6-helpers.js';

/*
| docs/40 §3 row 3 «Recent events»: GET /dashboard/events, newest first; each kind follows the
| permissions of its dashboard widget; only safe facts, never the raw audit record.
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
  clock(ctx).set('2026-11-02T09:00:00Z');
});

async function seed() {
  // A real payment through the API (payment_recorded, after an invoice_issued).
  const family = await billingFamily(ctx, 'USD', [await makeFeePackage(ctx, { USD: '60.00' })]);
  const invoice = await issuedInvoice(ctx, family, '2026-11', '2026-11-07');
  const { client: billing } = await signedIn(ctx, 'billing');
  expect(
    (
      await billing.post(`/invoices/${invoice.id}/payments`, {
        method: 'cash',
        amount: '60',
        receivedOn: '2026-11-02',
      })
    ).status,
  ).toBe(201);
  // Audit rows take the database clock: the seeded events come after the real payment.
  const latest = await ctx.prisma.auditLog.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
  const at = (m: number) => new Date(latest.createdAt.getTime() + m * 60_000);
  // Lead, payroll and a staff-cancelled class (plus a system cancellation that must not show).
  await ctx.prisma.auditLog.createMany({
    data: [
      {
        action: 'converted',
        subjectType: 'lead',
        subjectId: 7,
        after: { status: 'converted', familyId: family.id, enrollmentIds: [1] },
        createdAt: at(1),
      },
      {
        action: 'payroll_run_approved',
        subjectType: 'payroll_run',
        subjectId: 3,
        after: { period: '2026-10', netByCurrency: { EGP: '9000.00' } },
        createdAt: at(2),
      },
      // Not a business event: never on the feed.
      { action: 'password_changed', subjectType: 'user', subjectId: 1, createdAt: at(3) },
    ],
  });
  const { user: monitor } = await signedIn(ctx, 'monitor');
  const e = await m2Enrollment(ctx, await m2Student(ctx), await m2Teacher(ctx));
  const s = await m2Session(ctx, e, '2026-11-05T10:00:00Z', { stage: 'cancelled' });
  await ctx.prisma.sessionEvent.createMany({
    data: [
      {
        sessionId: s.id,
        type: 'cancelled',
        toStage: 'cancelled',
        actorUserId: monitor.id,
        actorRole: 'monitor',
        payload: { stageReason: 'teacher_sick' },
        occurredAt: at(4),
      },
      { sessionId: s.id, type: 'cancelled', toStage: 'cancelled', occurredAt: at(5) },
    ],
  });
  return { invoice, monitor, sessionId: s.id };
}

const kinds = (body: { data: { events: Array<{ kind: string }> } }) =>
  body.data.events.map((e) => e.kind);

describe('GET /dashboard/events', () => {
  it('the owner sees every business event, newest first, with safe facts only', async () => {
    const { invoice, monitor, sessionId } = await seed();
    const { client: admin } = await signedIn(ctx, 'admin');
    const res = await admin.get('/dashboard/events');
    expect(res.status).toBe(200);
    expect(kinds(res.body)).toEqual([
      'class_cancelled',
      'payroll_approved',
      'lead_converted',
      'payment_received',
      'invoice_issued',
    ]);
    const [cancel, payroll, , payment, issued] = res.body.data.events;
    expect(cancel).toMatchObject({
      key: expect.stringMatching(/^session:/),
      actor: { id: monitor.id, name: monitor.name, role: 'monitor' },
      subject: { type: 'class_session', id: sessionId },
      data: { startsAt: '2026-11-05T10:00:00.000Z', reason: 'teacher_sick' },
    });
    // Only the period: the payroll totals stay in payroll.
    expect(payroll.data).toEqual({ period: '2026-10' });
    expect(payment).toMatchObject({
      subject: { type: 'payment' },
      data: { amount: '60.00', currency: 'USD', method: 'cash', invoiceId: invoice.id },
      actor: { role: 'billing' },
    });
    expect(issued.data).toMatchObject({ number: invoice.number, currency: 'USD' });
    expect(res.body.data.nextBefore).toBeNull();
  });

  it('each role sees only the events of the modules it can view', async () => {
    await seed();
    const expected: Record<string, string[]> = {
      // B121/D146: billing and accounts see money, not leads or classes; D147: payroll is accounts'.
      billing: ['payment_received', 'invoice_issued'],
      accounts: ['payroll_approved', 'payment_received', 'invoice_issued'],
      manager: ['class_cancelled', 'lead_converted'],
      monitor: ['class_cancelled'],
      csr: ['class_cancelled', 'lead_converted'],
    };
    for (const [role, want] of Object.entries(expected)) {
      const { client } = await signedIn(ctx, role);
      const res = await client.get('/dashboard/events');
      expect(res.status, role).toBe(200);
      expect(kinds(res.body), role).toEqual(want);
    }
  });

  it('pages with limit and before', async () => {
    await seed();
    const { client: admin } = await signedIn(ctx, 'admin');
    const first = await admin.get('/dashboard/events?limit=2');
    expect(kinds(first.body)).toEqual(['class_cancelled', 'payroll_approved']);
    const next = await admin.get(
      `/dashboard/events?limit=2&before=${encodeURIComponent(first.body.data.nextBefore)}`,
    );
    expect(kinds(next.body)).toEqual(['lead_converted', 'payment_received']);
    expect((await admin.get('/dashboard/events?limit=99')).status).toBe(422);
  });

  it('teachers and parents get 403, no session 401', async () => {
    for (const role of ['teacher', 'parent']) {
      const { client } = await signedIn(ctx, role);
      expect((await client.get('/dashboard/events')).status, role).toBe(403);
    }
    expect((await request(ctx.app.getHttpServer()).get('/api/v1/dashboard/events')).status).toBe(
      401,
    );
  });
});
