import { describe, expect, it } from 'vitest';
import type { Env } from '../config/env.js';
import { BillingConfig, isLiveKey, loadBillingEnv } from './billing.config.js';
import { StripeGateway, stripeForm } from './gateways.js';
import { invoiceMail } from './mail.js';
import { BillingPeriod } from './period.js';

const env = (nodeEnv: Env['NODE_ENV']) => ({ NODE_ENV: nodeEnv }) as Env;

describe('billing environment (D88, D140: no real money outside production)', () => {
  it('accepts test and sandbox keys anywhere', () => {
    const parsed = loadBillingEnv(
      {
        BILLING_STRIPE_SECRET: 'sk_test_abc',
        BILLING_STRIPE_WEBHOOK_SECRET: 'whsec_abc',
        BILLING_PAYPAL_MODE: 'sandbox',
        BILLING_PAYPAL_CLIENT_ID: '',
      },
      'development',
    );
    expect(parsed).toMatchObject({
      BILLING_STRIPE_SECRET: 'sk_test_abc',
      BILLING_PAYPAL_CLIENT_ID: undefined,
      BILLING_ALLOW_LIVE: false,
      BILLING_INVOICE_PREFIX: 'INV',
    });
  });

  it.each([
    [{ BILLING_STRIPE_SECRET: 'sk_live_abc' }, 'BILLING_STRIPE_SECRET'],
    [{ BILLING_STRIPE_SECRET: 'rk_live_abc' }, 'BILLING_STRIPE_SECRET'],
    [{ BILLING_PAYPAL_MODE: 'live' }, 'BILLING_PAYPAL_MODE'],
    [{ BILLING_ALLOW_LIVE: 'true' }, 'BILLING_ALLOW_LIVE'],
  ])('refuses to start with live settings outside production (%o)', (vars, key) => {
    for (const nodeEnv of ['development', 'test'] as const) {
      expect(() => loadBillingEnv(vars, nodeEnv)).toThrow(
        new RegExp(`${key}.*refused outside production`),
      );
    }
    expect(() => loadBillingEnv(vars, 'production')).not.toThrow();
  });

  it('keeps a live key off in production unless BILLING_ALLOW_LIVE is set', () => {
    const config = new BillingConfig(env('test'));
    config.configure({
      stripeSecret: 'sk_live_x',
      stripeWebhookSecret: 'whsec_x',
      allowLive: true,
    });
    expect(config.stripeEnabled()).toBe(false); // not production
    const prod = new BillingConfig(env('production'));
    prod.configure({ stripeSecret: 'sk_live_x', stripeWebhookSecret: 'whsec_x', allowLive: false });
    expect(prod.stripeEnabled()).toBe(false);
    prod.allowLive = true;
    expect(prod.stripeEnabled()).toBe(true);
    expect(isLiveKey('pk_live_1')).toBe(true);
    expect(isLiveKey('sk_test_1')).toBe(false);
  });

  it('starts tests with no provider keys at all', () => {
    const config = new BillingConfig(env('test'));
    expect(config.stripeEnabled()).toBe(false);
    expect(config.paypalEnabled()).toBe(false);
    expect(config.paypalBaseUrl()).toBe('https://api-m.sandbox.paypal.com');
  });
});

describe('Stripe signature', () => {
  const payload = Buffer.from('{"id":"evt_1"}');
  const now = 1_800_000_000;

  it('accepts a fresh signature and any matching v1', () => {
    const header = StripeGateway.sign(payload, 'whsec_x', now);
    expect(StripeGateway.verifySignature(payload, header, 'whsec_x', 300, now + 10)).toBe(true);
    expect(
      StripeGateway.verifySignature(payload, `${header},v1=deadbeef`, 'whsec_x', 300, now),
    ).toBe(true);
    const v1 = header.split('v1=')[1]!;
    expect(
      StripeGateway.verifySignature(payload, `t=${now},v1=00,v1=${v1}`, 'whsec_x', 300, now),
    ).toBe(true);
  });

  it('refuses a wrong secret, a changed body, an old or future timestamp and junk headers', () => {
    const header = StripeGateway.sign(payload, 'whsec_x', now);
    expect(StripeGateway.verifySignature(payload, header, 'whsec_y', 300, now)).toBe(false);
    expect(StripeGateway.verifySignature(Buffer.from('{}'), header, 'whsec_x', 300, now)).toBe(
      false,
    );
    expect(StripeGateway.verifySignature(payload, header, 'whsec_x', 300, now + 301)).toBe(false);
    expect(StripeGateway.verifySignature(payload, header, 'whsec_x', 300, now - 301)).toBe(false);
    for (const junk of ['', 't=abc,v1=x', `t=${now}`, 'v1=abc', 'garbage']) {
      expect(StripeGateway.verifySignature(payload, junk, 'whsec_x', 300, now)).toBe(false);
    }
    expect(StripeGateway.verifySignature(payload, header, '', 300, now)).toBe(false);
  });
});

describe('billing helpers', () => {
  it('builds monthly periods on the 1st and the 15th', () => {
    const p = BillingPeriod.of('2026-12', 15);
    expect([p.start, p.end, p.days()]).toEqual(['2026-12-15', '2027-01-14', 31]);
    const feb = BillingPeriod.of('2027-02');
    expect([feb.start, feb.end, feb.days()]).toEqual(['2027-02-01', '2027-02-28', 28]);
    expect(feb.contains('2027-02-28')).toBe(true);
    expect(feb.contains('2027-03-01')).toBe(false);
    expect(feb.key(7)).toBe('family:7:2027-02-01');
    expect(() => BillingPeriod.of('2026-13')).toThrow();
    expect(() => BillingPeriod.of('2026-12', 3 as 1)).toThrow();
  });

  it("encodes Stripe's nested form params", () => {
    expect(
      stripeForm({
        mode: 'payment',
        line_items: [{ quantity: 1, price_data: { currency: 'usd' } }],
        skip: null,
      }),
    ).toBe(
      'mode=payment&line_items%5B0%5D%5Bquantity%5D=1&line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd',
    );
  });

  it('writes the invoice mail in the parent language first, then the other', () => {
    const mail = invoiceMail(
      {
        id: 5,
        number: 'INV-2026-000005',
        currency: 'GBP',
        balanceMinor: 1234,
        dueDate: '2026-12-07',
      },
      'reminder',
      'en',
      'https://app.example.test/',
    );
    expect(mail.subject).toBe('Payment reminder: invoice INV-2026-000005');
    expect(mail.text).toContain('12.34 GBP');
    expect(mail.text).toContain('https://app.example.test/invoices/5');
    expect(mail.text.indexOf('This is a reminder')).toBeLessThan(mail.text.indexOf('نذكّركم'));
  });
});
