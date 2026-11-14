import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Client,
  clock,
  createTestApp,
  resetState,
  signedIn,
  signInAs,
  type TestContext,
} from './helpers.js';
import {
  billingFamily,
  enableStripe,
  fakeProviders,
  issuedInvoice,
  makeFeePackage,
  resetBilling,
  stripeEvent,
  stripeSignature,
} from './n6-helpers.js';

/*
| P1-1 follow-up (docs/39 ISO, B118): the review flag, its reason and the unapplied part of a
| payment are staff-only. A parent sees their payment and receipt, never the internal review data.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const NOW = '2026-12-02T09:00:00Z';
const STAFF_ONLY = ['unapplied', 'needsReview', 'reviewReason', 'note', 'failureReason'];

let invoiceId: number;
let parent: Client;
let billing: Client;

beforeEach(async () => {
  await resetState(ctx);
  resetBilling(ctx);
  clock(ctx).set(NOW);
  const family = await billingFamily(ctx, 'USD', [await makeFeePackage(ctx, { USD: '60.00' })]);
  invoiceId = (await issuedInvoice(ctx, family)).id;
  parent = await signInAs(ctx, family.user);
  billing = (await signedIn(ctx, 'billing')).client;
  enableStripe(ctx);

  // An overpaid invoice: cash first, then the late Stripe payment lands (kept as credit, flagged).
  fakeProviders(ctx, [
    [
      'POST',
      'https://api.stripe.com/v1/checkout/sessions',
      () => ({ status: 200, json: { id: 'cs_test_1', url: 'https://checkout.stripe.com/x' } }),
    ],
    [
      'POST',
      'https://api.stripe.com/v1/checkout/sessions/cs_test_1/expire',
      () => ({ status: 200, json: {} }),
    ],
  ]);
  await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
  const attempt = await ctx.prisma.payment.findFirstOrThrow({ where: { method: 'stripe' } });
  await billing.post(`/invoices/${invoiceId}/payments`, {
    method: 'cash',
    amount: '60',
    receivedOn: '2026-12-02',
  });
  const payload = JSON.stringify(
    stripeEvent('evt_late', 'checkout.session.completed', {
      id: 'cs_test_1',
      payment_status: 'paid',
      amount_total: 6000,
      currency: 'usd',
      payment_intent: 'pi_late',
      metadata: { payment_id: String(attempt.id) },
    }),
  );
  await request(ctx.app.getHttpServer())
    .post('/api/v1/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', stripeSignature(payload, undefined, Date.parse(NOW) / 1000))
    .send(payload);
  expect(await ctx.prisma.payment.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({
    needsReview: true,
    reviewReason: 'overpaid',
  });
});

describe('payment review data is staff only', () => {
  it('the parent’s invoice shows the payments without the review fields', async () => {
    const res = await parent.get(`/invoices/${invoiceId}`);
    expect(res.status).toBe(200);
    const payments = res.body.data.payments as Record<string, unknown>[];
    expect(payments.length).toBeGreaterThan(0);
    for (const p of payments) {
      for (const key of STAFF_ONLY) expect(p).not.toHaveProperty(key);
    }
    expect(JSON.stringify(res.body)).not.toContain('overpaid');
  });

  it('billing staff still see them', async () => {
    const res = await billing.get(`/invoices/${invoiceId}`);
    expect(res.status).toBe(200);
    const late = (res.body.data.payments as Record<string, unknown>[]).find(
      (p) => p.method === 'stripe',
    );
    expect(late).toMatchObject({ unapplied: '60.00', needsReview: true, reviewReason: 'overpaid' });
  });

  it('a teacher cannot open the invoice at all', async () => {
    const { client: teacher } = await signedIn(ctx, 'teacher');
    expect((await teacher.get(`/invoices/${invoiceId}`)).status).toBe(403);
  });
});
