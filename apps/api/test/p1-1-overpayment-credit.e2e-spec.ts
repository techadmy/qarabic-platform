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
  enablePayPal,
  enableStripe,
  fakeProviders,
  issuedInvoice,
  makeFeePackage,
  resetBilling,
  stripeEvent,
  stripeSignature,
} from './n6-helpers.js';

/*
| P1-1 (docs/39 BIL-1, BIL-2; B115): one open online attempt per invoice; a manual payment, split
| or void closes the open checkout at the provider; money that arrives anyway is kept — what the
| invoice still owed is applied, the rest is the family's credit (review list + customer-credits
| liability) and pays their next invoice first. Sandbox fakes only.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const NOW = '2026-12-02T09:00:00Z';
const nowSeconds = () => Math.floor(Date.parse(NOW) / 1000);

let family: Awaited<ReturnType<typeof billingFamily>>;
let invoiceId: number;
let parent: Client;
let billing: Client;

beforeEach(async () => {
  await resetState(ctx);
  resetBilling(ctx);
  clock(ctx).set(NOW);
  family = await billingFamily(ctx, 'USD', [await makeFeePackage(ctx, { USD: '60.00' })]);
  invoiceId = (await issuedInvoice(ctx, family)).id;
  parent = await signInAs(ctx, family.user);
  billing = (await signedIn(ctx, 'billing')).client;
  enableStripe(ctx);
});

function fakeStripe() {
  return fakeProviders(ctx, [
    [
      'POST',
      'https://api.stripe.com/v1/checkout/sessions',
      () => ({
        status: 200,
        json: { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' },
      }),
    ],
    [
      'POST',
      'https://api.stripe.com/v1/checkout/sessions/cs_test_123/expire',
      () => ({ status: 200, json: { id: 'cs_test_123', status: 'expired' } }),
    ],
  ]);
}

function completed(paymentId: number, amount = 6000) {
  const event = stripeEvent('evt_late', 'checkout.session.completed', {
    id: 'cs_test_123',
    payment_status: 'paid',
    amount_total: amount,
    currency: 'usd',
    payment_intent: 'pi_late',
    metadata: { payment_id: String(paymentId) },
  });
  const payload = JSON.stringify(event);
  return request(ctx.app.getHttpServer())
    .post('/api/v1/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', stripeSignature(payload, undefined, nowSeconds()))
    .send(payload);
}

describe('P1-1 overpayment kept as the family’s credit', () => {
  it('a manual payment closes the open checkout; the late Stripe money becomes a credit', async () => {
    const { sent } = fakeStripe();
    expect(
      (await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' })).status,
    ).toBe(201);
    const attempt = await ctx.prisma.payment.findFirstOrThrow({ where: { method: 'stripe' } });

    const manual = await billing.post(`/invoices/${invoiceId}/payments`, {
      method: 'cash',
      amount: '60',
      receivedOn: '2026-12-02',
    });
    expect(manual.status).toBe(201);
    expect((await ctx.prisma.payment.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe(
      'cancelled',
    );
    expect(sent.some((r) => r.url.endsWith('/checkout/sessions/cs_test_123/expire'))).toBe(true);

    // The parent paid anyway: kept, nothing applied (already paid), all of it is credit.
    expect((await completed(attempt.id)).body.result).toBe('processed');
    const late = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(late).toMatchObject({
      status: 'succeeded',
      needsReview: true,
      reviewReason: 'overpaid',
    });
    expect(late.unapplied.toFixed(2)).toBe('60.00');
    const invoice = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.status).toBe('paid');
    expect(invoice.paid.toFixed(2)).toBe(invoice.total.toFixed(2));

    // On the review list.
    const list = await billing.get('/billing/credits?needsReview=1');
    expect(list.body.data).toEqual([
      expect.objectContaining({
        family: { id: family.id, name: expect.any(String) },
        currency: 'USD',
        amount: '60.00',
        remaining: '60.00',
        status: 'open',
        sourcePayment: { id: attempt.id, invoiceId, method: 'stripe' },
      }),
    ]);

    // In the ledger: the surplus is a customer-credits liability, not a receivable credit.
    const { client: accounts } = await signedIn(ctx, 'accounts');
    expect((await accounts.post('/accounting/outbox/process')).status).toBe(200);
    const credits = await ctx.prisma.journalLine.aggregate({
      where: { account: { systemKey: 'customer_credits' } },
      _sum: { credit: true, debit: true },
    });
    expect(credits._sum.credit?.toFixed(2)).toBe('60.00');
  });

  it('the credit pays the family’s next invoice first, and leaves the review list once reviewed', async () => {
    fakeStripe();
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    const attempt = await ctx.prisma.payment.findFirstOrThrow({ where: { method: 'stripe' } });
    await billing.post(`/invoices/${invoiceId}/payments`, {
      method: 'cash',
      amount: '60',
      receivedOn: '2026-12-02',
    });
    await completed(attempt.id);
    const credit = await ctx.prisma.familyCredit.findFirstOrThrow();

    const next = await issuedInvoice(ctx, family, '2027-01', '2027-01-07');
    const fresh = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: next.id } });
    expect(fresh.status).toBe('paid');
    const used = await ctx.prisma.payment.findFirstOrThrow({
      where: { invoiceId: next.id, method: 'credit' },
    });
    expect(used).toMatchObject({ status: 'succeeded', reference: `CR-${credit.id}` });
    expect(
      await ctx.prisma.familyCredit.findUniqueOrThrow({ where: { id: credit.id } }),
    ).toMatchObject({ status: 'used' });

    const reviewed = await billing.post(`/billing/credits/${credit.id}/review`, {
      note: 'Used on the January invoice',
    });
    expect(reviewed.status).toBe(200);
    expect((await billing.get('/billing/credits?needsReview=1')).body.data).toEqual([]);
    // A credit payment is not voidable by hand.
    expect((await billing.post(`/payments/${used.id}/void`, { reason: 'test' })).status).not.toBe(
      200,
    );
  });

  it('one open online attempt per invoice: PayPal after Stripe cancels the Stripe one', async () => {
    enablePayPal(ctx);
    const { sent } = fakeProviders(ctx, [
      [
        'POST',
        'https://api.stripe.com/v1/checkout/sessions',
        () => ({ status: 200, json: { id: 'cs_test_123', url: 'https://checkout.stripe.com/x' } }),
      ],
      [
        'POST',
        'https://api.stripe.com/v1/checkout/sessions/cs_test_123/expire',
        () => ({ status: 200, json: {} }),
      ],
      [
        'POST',
        /paypal\.com\/v1\/oauth2\/token$/,
        () => ({ status: 200, json: { access_token: 'tok', expires_in: 3600 } }),
      ],
      [
        'POST',
        /paypal\.com\/v2\/checkout\/orders$/,
        () => ({
          status: 201,
          json: {
            id: 'ORDER-1',
            links: [
              { rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1' },
            ],
          },
        }),
      ],
    ]);
    expect(
      (await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' })).status,
    ).toBe(201);
    expect(
      (await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'paypal' })).status,
    ).toBe(201);
    const pending = await ctx.prisma.payment.findMany({ where: { status: 'pending' } });
    expect(pending.map((p) => p.method)).toEqual(['paypal']);
    expect(sent.some((r) => r.url.endsWith('/cs_test_123/expire'))).toBe(true);
  });

  it('two parallel “Pay” clicks open one session', async () => {
    const { sent } = fakeStripe();
    const [a, b] = await Promise.all([
      parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' }),
      parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.paymentId).toBe(b.body.data.paymentId);
    expect(sent.filter((r) => r.url.endsWith('/v1/checkout/sessions'))).toHaveLength(1);
  });

  it('voiding the invoice closes its open checkout at Stripe', async () => {
    const { sent } = fakeStripe();
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    const { client: admin } = await signedIn(ctx, 'admin');
    const res = await admin.post(`/invoices/${invoiceId}/void`, { reason: 'Wrong family' });
    expect(res.status).toBe(200);
    expect(sent.some((r) => r.url.endsWith('/cs_test_123/expire'))).toBe(true);
  });

  it('credits are staff only', async () => {
    expect((await parent.get('/billing/credits')).status).toBe(403);
    const { client: teacher } = await signedIn(ctx, 'teacher');
    expect((await teacher.post('/billing/credits/1/review', {})).status).toBe(403);
  });
});
