import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentReconciler } from '../src/billing/reconcile.service.js';
import {
  type Client,
  clock,
  createTestApp,
  resetState,
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
| P1-2 (docs/39 BIL-3): a webhook whose handler died after the claim is taken again by the
| provider's retry once the lease (5 min) is over — never answered "duplicate" forever; a stuck
| Stripe attempt is finalized by the reconciliation against the provider (sandbox fake).
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
});

function fakeStripe(sessionPaid = true) {
  return fakeProviders(ctx, [
    [
      'POST',
      'https://api.stripe.com/v1/checkout/sessions',
      () => ({ status: 200, json: { id: 'cs_test_123', url: 'https://checkout.stripe.com/x' } }),
    ],
    [
      'GET',
      'https://api.stripe.com/v1/checkout/sessions/cs_test_123',
      () => ({
        status: 200,
        json: {
          id: 'cs_test_123',
          status: sessionPaid ? 'complete' : 'expired',
          payment_status: sessionPaid ? 'paid' : 'unpaid',
          payment_intent: 'pi_rec',
          amount_total: 6000,
          currency: 'usd',
        },
      }),
    ],
  ]);
}

const post = (event: object, at = nowSeconds()) => {
  const payload = JSON.stringify(event);
  return request(ctx.app.getHttpServer())
    .post('/api/v1/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', stripeSignature(payload, undefined, at))
    .send(payload);
};

describe('P1-2 webhook lease', () => {
  it('a claim left `received` by a dead handler is processed on retry after the lease', async () => {
    fakeStripe();
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    const payment = await ctx.prisma.payment.findFirstOrThrow();
    const event = stripeEvent('evt_stuck', 'checkout.session.completed', {
      id: 'cs_test_123',
      payment_status: 'paid',
      amount_total: 6000,
      currency: 'usd',
      payment_intent: 'pi_1',
      metadata: { payment_id: String(payment.id) },
    });
    // The first delivery claimed it, then the process died (no status update).
    await ctx.prisma.paymentWebhookEvent.create({
      data: {
        provider: 'stripe',
        eventId: 'evt_stuck',
        type: 'checkout.session.completed',
        payload: JSON.parse(JSON.stringify(event)) as object,
        status: 'received',
        createdAt: new Date('2026-12-02T08:50:00Z'),
        updatedAt: new Date('2026-12-02T08:50:00Z'),
      },
    });
    const retry = await post(event);
    expect(retry.status).toBe(200);
    expect(retry.body.result).toBe('processed');
    expect((await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
      'paid',
    );
    expect(
      (await ctx.prisma.paymentWebhookEvent.findFirstOrThrow({ where: { eventId: 'evt_stuck' } }))
        .status,
    ).toBe('processed');
  });

  it('a claim still inside its lease stays a duplicate (a parallel delivery is working on it)', async () => {
    const event = stripeEvent('evt_live', 'checkout.session.completed', { id: 'cs_x' });
    await ctx.prisma.paymentWebhookEvent.create({
      data: {
        provider: 'stripe',
        eventId: 'evt_live',
        type: 'checkout.session.completed',
        payload: JSON.parse(JSON.stringify(event)) as object,
        status: 'received',
        createdAt: new Date('2026-12-02T08:58:00Z'),
        updatedAt: new Date('2026-12-02T08:58:00Z'),
      },
    });
    expect((await post(event)).body.result).toBe('duplicate');
  });
});

describe('P1-2 reconciliation', () => {
  it('finalizes a stuck attempt that Stripe shows paid, once', async () => {
    fakeStripe(true);
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    clock(ctx).set('2026-12-02T10:30:00Z');
    const rec = ctx.app.get(PaymentReconciler);
    expect(await rec.run()).toMatchObject({ checked: 1, paid: 1 });
    expect((await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe(
      'paid',
    );
    expect(await rec.run()).toMatchObject({ checked: 0, paid: 0 });
    expect(await ctx.prisma.billingEvent.count({ where: { type: 'payment.succeeded' } })).toBe(1);
  });

  it('closes an attempt whose session expired unpaid; young attempts are left alone', async () => {
    fakeStripe(false);
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    const rec = ctx.app.get(PaymentReconciler);
    expect((await rec.run()).checked).toBe(0); // still inside the session's lifetime
    clock(ctx).set('2026-12-02T10:30:00Z');
    expect(await rec.run()).toMatchObject({ checked: 1, closed: 1 });
    expect((await ctx.prisma.payment.findFirstOrThrow()).status).toBe('cancelled');
  });
});
