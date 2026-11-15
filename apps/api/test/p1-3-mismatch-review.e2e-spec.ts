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
| P1-3 (docs/39 BIL-5): a provider capture whose amount or currency does not match the attempt is
| held for review — never `failed` — with what was captured, a billing event and a suspense entry
| in the ledger; nothing is applied to the invoice until staff resolve it.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const NOW = '2026-12-02T09:00:00Z';
let invoiceId: number;
let parent: Client;

beforeEach(async () => {
  await resetState(ctx);
  resetBilling(ctx);
  clock(ctx).set(NOW);
  const family = await billingFamily(ctx, 'USD', [await makeFeePackage(ctx, { USD: '60.00' })]);
  invoiceId = (await issuedInvoice(ctx, family)).id;
  parent = await signInAs(ctx, family.user);
  enableStripe(ctx);
  fakeProviders(ctx, [
    [
      'POST',
      'https://api.stripe.com/v1/checkout/sessions',
      () => ({ status: 200, json: { id: 'cs_test_123', url: 'https://checkout.stripe.com/x' } }),
    ],
  ]);
});

function completed(paymentId: number, amount: number, currency: string, id = 'evt_mm') {
  const payload = JSON.stringify(
    stripeEvent(id, 'checkout.session.completed', {
      id: 'cs_test_123',
      payment_status: 'paid',
      amount_total: amount,
      currency,
      payment_intent: 'pi_mm',
      metadata: { payment_id: String(paymentId) },
    }),
  );
  return request(ctx.app.getHttpServer())
    .post('/api/v1/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set(
      'Stripe-Signature',
      stripeSignature(payload, undefined, Math.floor(Date.parse(NOW) / 1000)),
    )
    .send(payload);
}

describe('P1-3 amount or currency mismatch', () => {
  it('holds the capture for review, posts it to suspense, applies nothing', async () => {
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    const attempt = await ctx.prisma.payment.findFirstOrThrow();
    expect((await completed(attempt.id, 5000, 'usd')).status).toBe(200);

    const held = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(held).toMatchObject({
      status: 'needs_review',
      needsReview: true,
      reviewReason: 'amount_mismatch',
      capturedCurrency: 'USD',
    });
    expect(held.capturedAmount?.toFixed(2)).toBe('50.00');
    expect((await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
      'issued',
    );
    expect(await ctx.prisma.billingEvent.count({ where: { type: 'payment.held' } })).toBe(1);
    expect(await ctx.prisma.billingEvent.count({ where: { type: 'payment.succeeded' } })).toBe(0);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'payment_held', subjectId: attempt.id } }),
    ).toBe(1);
    // A redelivery changes nothing.
    await completed(attempt.id, 5000, 'usd', 'evt_mm2');
    expect(await ctx.prisma.billingEvent.count({ where: { type: 'payment.held' } })).toBe(1);

    const { client: accounts } = await signedIn(ctx, 'accounts');
    expect((await accounts.post('/accounting/outbox/process')).status).toBe(200);
    const suspense = await ctx.prisma.journalLine.aggregate({
      where: { account: { systemKey: 'suspense' } },
      _sum: { credit: true },
    });
    expect(suspense._sum.credit?.toFixed(2)).toBe('50.00');
  });

  it('a currency mismatch is held too; staff see it on the review list and mark it reviewed', async () => {
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    const attempt = await ctx.prisma.payment.findFirstOrThrow();
    await completed(attempt.id, 6000, 'eur');
    const { client: billing } = await signedIn(ctx, 'billing');
    const list = await billing.get('/billing/payments/review');
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([
      expect.objectContaining({
        id: attempt.id,
        status: 'needs_review',
        reviewReason: 'currency_mismatch',
        capturedAmount: '60.00',
        capturedCurrency: 'EUR',
      }),
    ]);
    expect(
      (await billing.post(`/billing/payments/${attempt.id}/reviewed`, { note: 'x' })).status,
    ).toBe(422);
    const done = await billing.post(`/billing/payments/${attempt.id}/reviewed`, {
      note: 'Refunded at Stripe; family asked to pay in USD',
    });
    expect(done.status).toBe(200);
    expect((await billing.get('/billing/payments/review')).body.data).toEqual([]);
    expect((await parent.get('/billing/payments/review')).status).toBe(403);
  });

  it('the parent never sees the held capture or its review data', async () => {
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    const attempt = await ctx.prisma.payment.findFirstOrThrow();
    await completed(attempt.id, 5000, 'usd');
    const res = await parent.get(`/invoices/${invoiceId}`);
    expect(res.status).toBe(200);
    const payments = res.body.data.payments as Record<string, unknown>[];
    expect(payments.map((p) => p.id)).not.toContain(attempt.id);
    for (const p of payments) {
      for (const key of ['capturedAmount', 'capturedCurrency', 'needsReview', 'reviewReason']) {
        expect(p).not.toHaveProperty(key);
      }
    }
    expect(JSON.stringify(res.body)).not.toContain('amount_mismatch');
    const { client: billing } = await signedIn(ctx, 'billing');
    const staff = await billing.get(`/invoices/${invoiceId}`);
    expect(
      (staff.body.data.payments as Record<string, unknown>[]).find((p) => p.id === attempt.id),
    ).toMatchObject({ status: 'needs_review', capturedAmount: '50.00', capturedCurrency: 'USD' });
  });
});
