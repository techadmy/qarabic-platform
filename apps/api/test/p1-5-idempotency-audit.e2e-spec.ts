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
| P1-5 (docs/39 BIL-10, BIL-6): the same Idempotency-Key on a manual payment is one payment (also
| for two parallel submits); every provider-driven payment change leaves an audit row with its
| amount and currency.
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
let billing: Client;

beforeEach(async () => {
  await resetState(ctx);
  resetBilling(ctx);
  clock(ctx).set(NOW);
  const family = await billingFamily(ctx, 'USD', [await makeFeePackage(ctx, { USD: '60.00' })]);
  invoiceId = (await issuedInvoice(ctx, family)).id;
  parent = await signInAs(ctx, family.user);
  billing = (await signedIn(ctx, 'billing')).client;
});

const pay = (key?: string) =>
  billing.post(
    `/invoices/${invoiceId}/payments`,
    { method: 'cash', amount: '20', receivedOn: '2026-12-02' },
    key ? { headers: { 'Idempotency-Key': key } } : {},
  );

describe('P1-5 manual payment idempotency', () => {
  it('the same key twice is one payment; another key is another payment', async () => {
    const a = await pay('cash-20-key-0001');
    const b = await pay('cash-20-key-0001');
    expect(a.status).toBe(201);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await ctx.prisma.payment.count({ where: { invoiceId } })).toBe(1);
    expect((await pay('cash-20-key-0002')).body.data.id).not.toBe(a.body.data.id);
    expect(await ctx.prisma.payment.count({ where: { invoiceId } })).toBe(2);
  });

  it('two parallel submits with the same key record one payment', async () => {
    const [a, b] = await Promise.all([pay('parallel-key-01'), pay('parallel-key-01')]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect(await ctx.prisma.payment.count({ where: { invoiceId } })).toBe(1);
  });

  it('refuses a malformed key', async () => {
    expect((await pay('bad key!')).status).toBe(422);
  });
});

describe('P1-5 audit rows for provider-driven changes', () => {
  it('succeeded and refunded each leave an audit row with amount and currency', async () => {
    enableStripe(ctx);
    fakeProviders(ctx, [
      [
        'POST',
        'https://api.stripe.com/v1/checkout/sessions',
        () => ({ status: 200, json: { id: 'cs_test_123', url: 'https://checkout.stripe.com/x' } }),
      ],
    ]);
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    const attempt = await ctx.prisma.payment.findFirstOrThrow();
    const send = (event: object) => {
      const payload = JSON.stringify(event);
      return request(ctx.app.getHttpServer())
        .post('/api/v1/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set(
          'Stripe-Signature',
          stripeSignature(payload, undefined, Math.floor(Date.parse(NOW) / 1000)),
        )
        .send(payload);
    };
    await send(
      stripeEvent('evt_ok', 'checkout.session.completed', {
        id: 'cs_test_123',
        payment_status: 'paid',
        amount_total: 6000,
        currency: 'usd',
        payment_intent: 'pi_a',
        metadata: { payment_id: String(attempt.id) },
      }),
    );
    await send(
      stripeEvent('evt_refund', 'charge.refunded', {
        payment_intent: 'pi_a',
        amount_refunded: 6000,
      }),
    );
    const rows = await ctx.prisma.auditLog.findMany({
      where: { subjectType: 'payment', subjectId: attempt.id },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual(['payment_succeeded', 'payment_refunded']);
    expect(rows[0]!.after).toMatchObject({ amount: '60.00', currency: 'USD', applied: '60.00' });
    expect(rows[1]!.after).toMatchObject({ amount: '60.00', currency: 'USD', status: 'refunded' });
  });
});
