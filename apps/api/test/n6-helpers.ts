import { BillingConfig } from '../src/billing/billing.config.js';
import {
  type HttpRequest,
  type HttpResponse,
  PaymentHttp,
  PayPalGateway,
  StripeGateway,
} from '../src/billing/gateways.js';
import { InvoiceService } from '../src/billing/invoices.service.js';
import { SettingsService } from '../src/settings/settings.service.js';
import { makeFamily, makeStudent, type TestContext } from './helpers.js';

/**
 * N6 billing factories (Laravel `tests/Pest.php`: makeFeePackage, billingFamily, issuedInvoice,
 * enableStripe, enablePayPal). Providers are always fakes: the payment transport refuses every
 * call in tests until `fakeProviders()` installs a router.
 */

let seq = 0;

/** Resets the billing config and the provider transport (call in `beforeEach` after resetState). */
export function resetBilling(ctx: TestContext): void {
  ctx.app.get(BillingConfig).reset();
  ctx.app.get(PaymentHttp).use(null);
  ctx.app.get(PayPalGateway).forgetToken();
}

export function makeFeePackage(
  ctx: TestContext,
  prices: Record<string, string> = { USD: '60.00' },
  attrs: {
    name?: string;
    classesPerWeek?: number;
    sessionMinutes?: number;
    isActive?: boolean;
  } = {},
) {
  seq += 1;
  return ctx.prisma.feePackage.create({
    data: {
      name: attrs.name ?? `2 days a week ${seq}`,
      classesPerWeek: attrs.classesPerWeek ?? 2,
      sessionMinutes: attrs.sessionMinutes ?? 30,
      isActive: attrs.isActive ?? true,
      prices: {
        create: Object.entries(prices).map(([currency, monthlyAmount]) => ({
          currency,
          monthlyAmount,
        })),
      },
    },
  });
}

/** A regular family billed in `currency` with one child per package given. */
export async function billingFamily(
  ctx: TestContext,
  currency: string | null = 'USD',
  packages: Array<{ id: number }> = [],
  attrs: {
    billingDay?: 1 | 15;
    enabled?: boolean;
    customFee?: string | null;
    startsOn?: string | null;
    status?: 'regular' | 'trial' | 'on_leave' | 'suspended' | 'deactivated';
  } = {},
) {
  const family = await makeFamily(ctx, { status: attrs.status ?? 'regular' });
  await ctx.prisma.familyBillingProfile.create({
    data: {
      familyId: family.id,
      currency,
      billingDay: attrs.billingDay ?? 1,
      enabled: attrs.enabled ?? true,
      customFee: attrs.customFee ?? null,
      startsOn: attrs.startsOn ? new Date(`${attrs.startsOn}T00:00:00Z`) : null,
    },
  });
  const students = [];
  for (const pkg of packages) {
    const student = await makeStudent(ctx, family);
    await ctx.prisma.studentFeePackage.create({
      data: { studentId: student.id, feePackageId: pkg.id },
    });
    students.push(student);
  }
  return { ...family, students };
}

/** An issued monthly invoice for the family (through the real service). */
export async function issuedInvoice(
  ctx: TestContext,
  family: { id: number },
  month = '2026-12',
  due = '2026-12-07',
  day: 1 | 15 = 1,
) {
  const result = await ctx.app.get(InvoiceService).run(month, day, due, null, [family.id]);
  if (!result.issued[0]) throw new Error(`no invoice issued: ${JSON.stringify(result.skipped)}`);
  return ctx.prisma.invoice.findUniqueOrThrow({ where: { id: result.issued[0] } });
}

export const STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

export function enableStripe(ctx: TestContext): void {
  ctx.app.get(BillingConfig).configure({
    stripeSecret: 'sk_test_fake',
    stripeWebhookSecret: STRIPE_WEBHOOK_SECRET,
    allowLive: false,
  });
}

export function enablePayPal(ctx: TestContext): void {
  ctx.app.get(BillingConfig).configure({
    paypalClientId: 'sandbox-client',
    paypalSecret: 'sandbox-secret',
    paypalWebhookId: 'WH-TEST',
    paypalMode: 'sandbox',
  });
}

export async function notifyParents(ctx: TestContext, on: boolean): Promise<void> {
  await ctx.app.get(SettingsService).set('billing.notify_parents', on, null);
}

type Route = [method: string, url: string | RegExp, respond: (req: HttpRequest) => HttpResponse];

/**
 * Fake Stripe / PayPal (Laravel `Http::fake`): the first route matching method + URL answers;
 * anything else is a 404 from "the provider". Every request is recorded in `sent`.
 */
export function fakeProviders(ctx: TestContext, routes: Route[]) {
  const sent: HttpRequest[] = [];
  ctx.app.get(PaymentHttp).use((req) => {
    sent.push(req);
    const hit = routes.find(
      ([m, url]) =>
        m === req.method && (typeof url === 'string' ? req.url === url : url.test(req.url)),
    );
    return Promise.resolve(hit ? hit[2](req) : { status: 404, json: { error: 'not faked' } });
  });
  return { sent };
}

/** Parses a Stripe form body back into flat `key → value` pairs. */
export function formFields(body: string | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body ?? '').entries());
}

export function stripeEvent(id: string, type: string, object: Record<string, unknown>) {
  return { id, object: 'event', type, livemode: false, data: { object } };
}

export function stripeSignature(
  payload: string,
  secret = STRIPE_WEBHOOK_SECRET,
  at?: number,
): string {
  return StripeGateway.sign(payload, secret, at ?? Math.floor(Date.now() / 1000));
}
