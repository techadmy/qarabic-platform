import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BillingConfig } from '../src/billing/billing.config.js';
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
  formFields,
  issuedInvoice,
  makeFeePackage,
  resetBilling,
  stripeEvent,
  stripeSignature,
} from './n6-helpers.js';

/*
| Ports of Laravel tests/Feature/M5/StripeTest.php and PayPalTest.php (docs/20 §7, D88, D140): the
| parent starts a checkout for the server's balance; only a signed, fresh, matching Stripe webhook
| or PayPal's own capture / verified webhook marks it paid, exactly once. Providers are fakes: the
| transport refuses every call that is not faked, and live keys / events are refused.
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

beforeEach(async () => {
  await resetState(ctx);
  resetBilling(ctx);
  clock(ctx).set(NOW);
  family = await billingFamily(ctx, 'USD', [await makeFeePackage(ctx, { USD: '60.00' })]);
  invoiceId = (await issuedInvoice(ctx, family)).id;
  parent = await signInAs(ctx, family.user);
});

const invoiceStatus = async () =>
  (await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status;

// ------------------------------------------------------------------ Stripe

function fakeStripe(status = 200) {
  return fakeProviders(ctx, [
    [
      'POST',
      'https://api.stripe.com/v1/checkout/sessions',
      () =>
        status === 200
          ? {
              status,
              json: { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' },
            }
          : { status, json: { error: { code: 'api_error' } } },
    ],
  ]);
}

function postStripe(
  event: object,
  opts: { secret?: string | null; at?: number; raw?: string } = {},
) {
  const payload = opts.raw ?? JSON.stringify(event);
  const header =
    opts.secret === null
      ? ''
      : stripeSignature(payload, opts.secret ?? undefined, opts.at ?? nowSeconds());
  return request(ctx.app.getHttpServer())
    .post('/api/v1/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', header)
    .send(payload);
}

describe('Stripe Checkout', () => {
  beforeEach(() => enableStripe(ctx));

  it('starts a checkout for the balance with the payment id in the metadata, and reuses it', async () => {
    const { sent } = fakeStripe();
    const res = await parent.post(`/invoices/${invoiceId}/checkout`, {
      provider: 'stripe',
      amount: '0.01',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      amount: '60.00',
      currency: 'USD',
      provider: 'stripe',
    });
    const payment = await ctx.prisma.payment.findFirstOrThrow();
    expect(sent).toHaveLength(1);
    const call = sent[0]!;
    const form = formFields(call.body);
    expect(call.headers['Idempotency-Key']).toBe(payment.idempotencyKey);
    expect(call.headers.Authorization).toBe('Bearer sk_test_fake');
    expect(form['line_items[0][price_data][unit_amount]']).toBe('6000');
    expect(form['line_items[0][price_data][currency]']).toBe('usd');
    expect(form['metadata[payment_id]']).toBe(String(payment.id));
    expect(form.success_url).toBe(
      `http://localhost:3000/invoices/${invoiceId}?checkout=return&provider=stripe`,
    );
    expect(form.customer_email).toBe(family.user.email);
    expect(payment).toMatchObject({
      status: 'pending',
      providerRef: 'cs_test_123',
      method: 'stripe',
    });

    // Double click: same attempt, no second Stripe call.
    const again = await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    expect(again.body.data.paymentId).toBe(payment.id);
    expect(sent).toHaveLength(1);
    expect(await invoiceStatus()).toBe('issued'); // the redirect alone never pays
  });

  it('marks the invoice paid only from a valid signed webhook, once (signature, replay, idempotency)', async () => {
    fakeStripe();
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    const payment = await ctx.prisma.payment.findFirstOrThrow();
    const event = stripeEvent('evt_1', 'checkout.session.completed', {
      id: 'cs_test_123',
      payment_status: 'paid',
      amount_total: 6000,
      currency: 'usd',
      payment_intent: 'pi_123',
      metadata: { payment_id: String(payment.id) },
    });

    expect((await postStripe(event, { secret: 'whsec_wrong' })).status).toBe(400);
    expect((await postStripe(event, { secret: null })).status).toBe(400);
    const old = await postStripe(event, { at: nowSeconds() - 301 }); // too old (replay)
    expect(old.status).toBe(400);
    expect(old.body.code).toBe('invalid_signature');
    // A body changed after signing.
    const signed = stripeSignature(JSON.stringify(event), undefined, nowSeconds());
    const tampered = await request(ctx.app.getHttpServer())
      .post('/api/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signed)
      .send(JSON.stringify({ ...event, id: 'evt_other' }));
    expect(tampered.status).toBe(400);
    expect(await invoiceStatus()).toBe('issued');

    const ok = await postStripe(event);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ received: true, result: 'processed' });
    expect((await postStripe(event)).body.result).toBe('duplicate');

    expect(await invoiceStatus()).toBe('paid');
    const fresh = await ctx.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(fresh).toMatchObject({ status: 'succeeded', providerPaymentId: 'pi_123' });
    expect(await ctx.prisma.billingEvent.count({ where: { type: 'payment.succeeded' } })).toBe(1);
    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(1);
  });

  it('rejects a webhook whose amount or currency does not match the attempt', async () => {
    fakeStripe();
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    await postStripe(
      stripeEvent('evt_2', 'checkout.session.completed', {
        id: 'cs_test_123',
        payment_status: 'paid',
        amount_total: 100,
        currency: 'usd',
        payment_intent: 'pi_1',
      }),
    );
    expect((await ctx.prisma.payment.findFirstOrThrow()).failureReason).toBe('amount_mismatch');
    expect(await invoiceStatus()).toBe('issued');
  });

  it('ignores a session whose metadata names another payment', async () => {
    fakeStripe();
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    const res = await postStripe(
      stripeEvent('evt_m', 'checkout.session.completed', {
        id: 'cs_test_123',
        payment_status: 'paid',
        amount_total: 6000,
        currency: 'usd',
        metadata: { payment_id: '999' },
      }),
    );
    expect(res.body.result).toBe('ignored');
    expect(await invoiceStatus()).toBe('issued');
  });

  it('handles async payments, expiry, full refunds and unknown events', async () => {
    fakeStripe();
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    const session = {
      id: 'cs_test_123',
      amount_total: 6000,
      currency: 'usd',
      payment_intent: 'pi_9',
    };

    expect(
      (
        await postStripe(
          stripeEvent('evt_a', 'checkout.session.completed', {
            ...session,
            payment_status: 'unpaid',
          }),
        )
      ).body.result,
    ).toBe('ignored');
    expect(await invoiceStatus()).toBe('issued');
    expect(
      (
        await postStripe(
          stripeEvent('evt_b', 'checkout.session.async_payment_succeeded', {
            ...session,
            payment_status: 'paid',
          }),
        )
      ).body.result,
    ).toBe('processed');
    expect(await invoiceStatus()).toBe('paid');

    expect(
      (
        await postStripe(
          stripeEvent('evt_c', 'charge.refunded', {
            id: 'ch_1',
            payment_intent: 'pi_9',
            amount_refunded: 6000,
          }),
        )
      ).body.result,
    ).toBe('processed');
    expect(await invoiceStatus()).toBe('issued');
    expect((await ctx.prisma.payment.findFirstOrThrow()).status).toBe('refunded');
    const refunded = await ctx.prisma.billingEvent.findFirstOrThrow({
      where: { type: 'payment.refunded' },
    });
    expect(refunded.amount.toFixed(2)).toBe('-60.00');

    expect(
      (await postStripe(stripeEvent('evt_d', 'customer.created', { id: 'cus_1' }))).body.result,
    ).toBe('ignored');
  });

  it('flags a partial refund for review without reopening the invoice', async () => {
    fakeStripe();
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    const session = {
      id: 'cs_test_123',
      amount_total: 6000,
      currency: 'usd',
      payment_intent: 'pi_7',
    };
    await postStripe(
      stripeEvent('evt_p1', 'checkout.session.completed', { ...session, payment_status: 'paid' }),
    );
    await postStripe(
      stripeEvent('evt_p2', 'charge.refunded', {
        id: 'ch_2',
        payment_intent: 'pi_7',
        amount_refunded: 1000,
      }),
    );
    const payment = await ctx.prisma.payment.findFirstOrThrow();
    expect(payment.status).toBe('succeeded');
    expect(payment.note).toContain('Partial refund 10.00');
    expect(await invoiceStatus()).toBe('paid');
  });

  it('cancels an expired checkout so a new one can start', async () => {
    fakeStripe();
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    await postStripe(
      stripeEvent('evt_e', 'checkout.session.expired', {
        id: 'cs_test_123',
        payment_status: 'unpaid',
      }),
    );
    expect((await ctx.prisma.payment.findFirstOrThrow()).status).toBe('cancelled');
    // A new attempt gets a new session.
    fakeProviders(ctx, [
      [
        'POST',
        'https://api.stripe.com/v1/checkout/sessions',
        () => ({
          status: 200,
          json: { id: 'cs_test_456', url: 'https://checkout.stripe.com/c/pay/cs_test_456' },
        }),
      ],
    ]);
    const res = await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    expect(res.body.data.url).toContain('cs_test_456');
    expect(await ctx.prisma.payment.count()).toBe(2);
  });

  it('retries an event whose processing failed', async () => {
    fakeStripe();
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    await ctx.prisma.paymentWebhookEvent.create({
      data: {
        provider: 'stripe',
        eventId: 'evt_f',
        type: 'checkout.session.completed',
        payload: {},
        status: 'failed',
      },
    });
    const res = await postStripe(
      stripeEvent('evt_f', 'checkout.session.completed', {
        id: 'cs_test_123',
        payment_status: 'paid',
        amount_total: 6000,
        currency: 'usd',
      }),
    );
    expect(res.body.result).toBe('processed');
    expect(await invoiceStatus()).toBe('paid');
  });

  it('hides Stripe without keys and refuses live keys and live events (D88, D140)', async () => {
    fakeStripe();
    const config = ctx.app.get(BillingConfig);
    config.configure({ stripeSecret: 'sk_live_not_allowed' });
    expect((await parent.get('/billing/providers')).body.data.online).toEqual([]);
    const refused = await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('provider_unavailable');
    expect(
      (await postStripe(stripeEvent('evt_live', 'checkout.session.completed', { id: 'x' }))).status,
    ).toBe(404);
    // BILLING_ALLOW_LIVE is ignored outside production.
    config.configure({ allowLive: true });
    expect((await parent.get('/billing/providers')).body.data.online).toEqual([]);

    enableStripe(ctx);
    expect((await parent.get('/billing/providers')).body.data).toEqual({
      online: ['stripe'],
      manual: ['cash', 'bank_transfer', 'cheque', 'other'],
      currencies: ['USD', 'GBP', 'EUR', 'CAD', 'AUD', 'AED', 'PKR', 'EGP', 'SAR'],
    });
    const live = {
      ...stripeEvent('evt_live', 'checkout.session.completed', { id: 'x' }),
      livemode: true,
    };
    const res = await postStripe(live);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('live_event_refused');

    config.configure({ stripeSecret: null });
    expect((await parent.get('/billing/providers')).body.data.online).toEqual([]);
  });

  it('fails safely when Stripe is down', async () => {
    fakeStripe(500);
    const res = await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('provider');
    expect((await ctx.prisma.payment.findFirstOrThrow()).status).toBe('failed');
  });

  it('never reaches the network in tests (no fake installed = provider error)', async () => {
    const res = await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('provider_error');
  });

  it('refuses a checkout on a paid invoice and an invalid payload', async () => {
    const { client: billing } = await signedIn(ctx, 'billing');
    await billing.post(`/invoices/${invoiceId}/payments`, {
      method: 'cash',
      amount: '60',
      receivedOn: '2026-12-02',
    });
    expect(
      (await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' })).body.code,
    ).toBe('not_open');
    expect(
      (await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'bitcoin' })).status,
    ).toBe(422);
    // Malformed JSON never reaches the handler; a signed non-object is refused by it.
    expect((await postStripe({}, { raw: 'not json' })).status).toBe(400);
    const bad = await postStripe({}, { raw: '[1]' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_payload');
  });

  it('throttles checkouts per user (10 a minute)', async () => {
    fakeStripe();
    for (let i = 0; i < 10; i++) {
      expect(
        (await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' })).status,
      ).toBe(201);
    }
    expect(
      (await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'stripe' })).status,
    ).toBe(429);
  });
});

// ------------------------------------------------------------------ PayPal

const PAYPAL = 'https://api-m.sandbox.paypal.com';
const PAYPAL_HEADERS: Record<string, string> = {
  'PAYPAL-TRANSMISSION-ID': 'tid-1',
  'PAYPAL-TRANSMISSION-TIME': '2026-12-02T09:00:00Z',
  'PAYPAL-TRANSMISSION-SIG': 'sig',
  'PAYPAL-CERT-URL': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'PAYPAL-AUTH-ALGO': 'SHA256withRSA',
};

function paypalCapture(status: string, value = '60.00', customId: string | null = null) {
  return {
    id: 'ORDER-1',
    status: status === 'COMPLETED' ? 'COMPLETED' : 'PAYER_ACTION_REQUIRED',
    purchase_units: [
      {
        custom_id: customId,
        payments: {
          captures: [
            { id: 'CAP-1', status, custom_id: customId, amount: { currency_code: 'USD', value } },
          ],
        },
      },
    ],
  };
}

function fakePayPal(capture: object = {}, verified = true) {
  return fakeProviders(ctx, [
    [
      'POST',
      `${PAYPAL}/v1/oauth2/token`,
      () => ({ status: 200, json: { access_token: 'A21-test', expires_in: 3600 } }),
    ],
    [
      'POST',
      `${PAYPAL}/v2/checkout/orders`,
      () => ({
        status: 201,
        json: {
          id: 'ORDER-1',
          status: 'PAYER_ACTION_REQUIRED',
          links: [
            { rel: 'self', href: `${PAYPAL}/v2/checkout/orders/ORDER-1` },
            {
              rel: 'payer-action',
              href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1',
            },
          ],
        },
      }),
    ],
    [
      'POST',
      `${PAYPAL}/v2/checkout/orders/ORDER-1/capture`,
      () => ({ status: 201, json: capture }),
    ],
    [
      'POST',
      `${PAYPAL}/v1/notifications/verify-webhook-signature`,
      () => ({ status: 200, json: { verification_status: verified ? 'SUCCESS' : 'FAILURE' } }),
    ],
  ]);
}

function postPayPal(event: object, headers: Record<string, string> = PAYPAL_HEADERS) {
  let req = request(ctx.app.getHttpServer())
    .post('/api/v1/webhooks/paypal')
    .set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(JSON.stringify(event));
}

describe('PayPal Orders v2', () => {
  beforeEach(() => enablePayPal(ctx));

  it('creates an order for the balance and captures it on the server', async () => {
    const { sent } = fakePayPal(paypalCapture('COMPLETED'));
    const res = await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'paypal' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.url).toBe('https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1');
    const payment = await ctx.prisma.payment.findFirstOrThrow();
    const order = sent.find((r) => r.url.endsWith('/v2/checkout/orders'))!;
    const body = JSON.parse(order.body!) as { purchase_units: Array<Record<string, unknown>> };
    expect(body.purchase_units[0]!.amount).toEqual({ currency_code: 'USD', value: '60.00' });
    expect(body.purchase_units[0]!.custom_id).toBe(String(payment.id));
    expect(order.headers['PayPal-Request-Id']).toBe(payment.idempotencyKey);
    expect(order.headers.Authorization).toBe('Bearer A21-test');
    expect(sent.every((r) => r.url.startsWith(PAYPAL))).toBe(true);

    const cap = await parent.post(`/invoices/${invoiceId}/paypal/capture`, { orderId: 'ORDER-1' });
    expect(cap.status).toBe(200);
    expect(cap.body.data.status).toBe('succeeded');
    expect(await invoiceStatus()).toBe('paid');
    expect((await ctx.prisma.payment.findFirstOrThrow()).providerPaymentId).toBe('CAP-1');

    // A second capture call changes nothing.
    expect(
      (await parent.post(`/invoices/${invoiceId}/paypal/capture`, { orderId: 'ORDER-1' })).status,
    ).toBe(200);
    expect(
      (await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).paid.toFixed(2),
    ).toBe('60.00');
  });

  it.each([
    ['declined', () => paypalCapture('DECLINED'), 'failed'],
    ['pending', () => paypalCapture('PENDING'), 'pending'],
    ['wrong amount', () => paypalCapture('COMPLETED', '1.00'), 'failed'],
  ])('does not pay on a %s capture', async (_name, capture, status) => {
    fakePayPal(capture());
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'paypal' });
    const res = await parent.post(`/invoices/${invoiceId}/paypal/capture`, { orderId: 'ORDER-1' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(status);
    expect(await invoiceStatus()).toBe('issued');
  });

  it("refuses to capture an order that is not this invoice's", async () => {
    fakePayPal(paypalCapture('COMPLETED'));
    expect(
      (await parent.post(`/invoices/${invoiceId}/paypal/capture`, { orderId: 'ORDER-OTHER' }))
        .status,
    ).toBe(422);
    expect(
      (await parent.post(`/invoices/${invoiceId}/paypal/capture`, { orderId: 'bad id;' })).status,
    ).toBe(422);
  });

  it('applies verified webhooks once and ignores unverified ones', async () => {
    fakePayPal(paypalCapture('COMPLETED'));
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'paypal' });
    const payment = await ctx.prisma.payment.findFirstOrThrow();
    const event = {
      id: 'WH-EVT-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAP-1',
        status: 'COMPLETED',
        custom_id: String(payment.id),
        amount: { currency_code: 'USD', value: '60.00' },
        supplementary_data: { related_ids: { order_id: 'ORDER-1' } },
      },
    };

    expect((await postPayPal(event, {})).status).toBe(400); // no PayPal headers
    expect(
      (
        await postPayPal(event, {
          ...PAYPAL_HEADERS,
          'PAYPAL-CERT-URL': 'https://evil.example.com/cert',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postPayPal(event, {
          ...PAYPAL_HEADERS,
          'PAYPAL-CERT-URL': 'http://api.paypal.com/cert',
        })
      ).status,
    ).toBe(400);
    expect(await invoiceStatus()).toBe('issued');

    const ok = await postPayPal(event);
    expect(ok.status).toBe(200);
    expect(ok.body.result).toBe('processed');
    expect((await postPayPal(event)).body.result).toBe('duplicate');
    expect(await invoiceStatus()).toBe('paid');

    const refund = await postPayPal({
      id: 'WH-EVT-2',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: {
        id: 'REF-1',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '60.00' },
        links: [{ rel: 'up', href: `${PAYPAL}/v2/payments/captures/CAP-1` }],
      },
    });
    expect(refund.body.result).toBe('processed');
    expect(await invoiceStatus()).toBe('issued');
    expect((await ctx.prisma.payment.findFirstOrThrow()).status).toBe('refunded');
  });

  it('rejects a webhook PayPal does not verify', async () => {
    fakePayPal({}, false);
    const res = await postPayPal({
      id: 'WH-X',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_signature');
    expect(await ctx.prisma.paymentWebhookEvent.count()).toBe(0);
  });

  it('captures from the ORDER.APPROVED webhook when the parent closed the tab', async () => {
    fakePayPal(paypalCapture('COMPLETED'));
    await parent.post(`/invoices/${invoiceId}/checkout`, { provider: 'paypal' });
    const res = await postPayPal({
      id: 'WH-EVT-3',
      event_type: 'CHECKOUT.ORDER.APPROVED',
      resource: { id: 'ORDER-1', status: 'APPROVED' },
    });
    expect(res.body.result).toBe('processed');
    expect(await invoiceStatus()).toBe('paid');
  });

  it('hides PayPal in live mode, even with BILLING_ALLOW_LIVE outside production', async () => {
    fakePayPal();
    const config = ctx.app.get(BillingConfig);
    config.configure({ paypalMode: 'live' });
    expect((await parent.get('/billing/providers')).body.data.online).toEqual([]);
    config.configure({ allowLive: true });
    expect((await parent.get('/billing/providers')).body.data.online).toEqual([]);
    expect(config.paypalBaseUrl()).toBe(PAYPAL);
    expect((await postPayPal({ id: 'WH-1', event_type: 'X' })).status).toBe(404);
  });
});
