import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { ENV, type Env } from '../config/env.js';

const flag = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');
/** Empty in `.env` = not set. */
const optionalSecret = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().trim().min(1).optional(),
);

/**
 * Payment provider settings (Laravel `config/billing.php`), read from the environment. Kept out of
 * `config/env.ts` so the money rules sit in one place. Keys live in the server's `.env` only.
 */
export const billingEnvSchema = z.object({
  /** Stripe secret key: `sk_test_…` (or a restricted `rk_test_…`). */
  BILLING_STRIPE_SECRET: optionalSecret,
  /** Signing secret of the Stripe webhook endpoint (`whsec_…`). */
  BILLING_STRIPE_WEBHOOK_SECRET: optionalSecret,
  BILLING_PAYPAL_CLIENT_ID: optionalSecret,
  BILLING_PAYPAL_SECRET: optionalSecret,
  /** The id PayPal gave our webhook (its own signature check uses it). */
  BILLING_PAYPAL_WEBHOOK_ID: optionalSecret,
  BILLING_PAYPAL_MODE: z.enum(['sandbox', 'live']).default('sandbox'),
  /**
   * D88 / D140: real money only after Ahmed's go-live decision. Honoured in production only; any
   * other environment refuses to start with it.
   */
  BILLING_ALLOW_LIVE: flag,
  /** Invoice numbers: `PREFIX-YYYY-000123`. */
  BILLING_INVOICE_PREFIX: z
    .string()
    .regex(/^[A-Z]{2,8}$/)
    .default('INV'),
});
export type BillingEnv = z.output<typeof billingEnvSchema>;

/** A key that moves real money: Stripe `sk_live_` / `rk_live_` / `pk_live_` (anything `_live_`). */
export const isLiveKey = (key: string | null | undefined) => !!key && /(^|_)live_/.test(key);

/**
 * Validates the billing variables; outside production a live key, live PayPal mode or
 * `BILLING_ALLOW_LIVE` stops the app from starting (no real money anywhere but production).
 */
export function loadBillingEnv(source: NodeJS.ProcessEnv, nodeEnv: Env['NODE_ENV']): BillingEnv {
  const parsed = billingEnvSchema.safeParse(source);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid billing environment: ${keys}`);
  }
  const env = parsed.data;
  if (nodeEnv !== 'production') {
    const live = [
      isLiveKey(env.BILLING_STRIPE_SECRET) && 'BILLING_STRIPE_SECRET',
      isLiveKey(env.BILLING_STRIPE_WEBHOOK_SECRET) && 'BILLING_STRIPE_WEBHOOK_SECRET',
      env.BILLING_PAYPAL_MODE === 'live' && 'BILLING_PAYPAL_MODE',
      env.BILLING_ALLOW_LIVE && 'BILLING_ALLOW_LIVE',
    ].filter(Boolean);
    if (live.length) {
      throw new Error(
        `Invalid billing environment: ${live.join(', ')}: live payments are refused outside ` +
          'production. Use Stripe test keys and PayPal sandbox (D140).',
      );
    }
  }
  return env;
}

type Values = Pick<
  BillingConfig,
  | 'stripeSecret'
  | 'stripeWebhookSecret'
  | 'paypalClientId'
  | 'paypalSecret'
  | 'paypalWebhookId'
  | 'paypalMode'
  | 'allowLive'
  | 'invoicePrefix'
>;

/**
 * The providers' configuration. Tests start with no keys at all (whatever the `.env` says) and
 * switch a fake provider on with `configure()`, like `config([...])` in Laravel; `reset()` goes
 * back. Live money is possible only when NODE_ENV is production AND `BILLING_ALLOW_LIVE` is set.
 */
@Injectable()
export class BillingConfig {
  private readonly logger = new Logger(BillingConfig.name);
  stripeSecret: string | null = null;
  stripeWebhookSecret: string | null = null;
  paypalClientId: string | null = null;
  paypalSecret: string | null = null;
  paypalWebhookId: string | null = null;
  paypalMode: 'sandbox' | 'live' = 'sandbox';
  allowLive = false;
  invoicePrefix = 'INV';
  private readonly initial: Values;

  constructor(@Inject(ENV) private readonly env: Env) {
    const values = loadBillingEnv(process.env, env.NODE_ENV);
    this.initial =
      env.NODE_ENV === 'test'
        ? { ...this.snapshot(), invoicePrefix: values.BILLING_INVOICE_PREFIX }
        : {
            stripeSecret: values.BILLING_STRIPE_SECRET ?? null,
            stripeWebhookSecret: values.BILLING_STRIPE_WEBHOOK_SECRET ?? null,
            paypalClientId: values.BILLING_PAYPAL_CLIENT_ID ?? null,
            paypalSecret: values.BILLING_PAYPAL_SECRET ?? null,
            paypalWebhookId: values.BILLING_PAYPAL_WEBHOOK_ID ?? null,
            paypalMode: values.BILLING_PAYPAL_MODE,
            allowLive: values.BILLING_ALLOW_LIVE,
            invoicePrefix: values.BILLING_INVOICE_PREFIX,
          };
    this.reset();
    if (this.isLiveStripe() && !this.liveAllowed()) {
      this.logger.warn('Stripe has a live key without BILLING_ALLOW_LIVE: Stripe stays off.');
    }
  }

  /** Real money: production + `BILLING_ALLOW_LIVE` only. */
  liveAllowed(): boolean {
    return this.allowLive && this.env.NODE_ENV === 'production';
  }

  isLiveStripe(): boolean {
    return isLiveKey(this.stripeSecret) || isLiveKey(this.stripeWebhookSecret);
  }

  stripeEnabled(): boolean {
    if (!this.stripeSecret || !this.stripeWebhookSecret) return false;
    return !this.isLiveStripe() || this.liveAllowed();
  }

  paypalEnabled(): boolean {
    if (!this.paypalClientId || !this.paypalSecret || !this.paypalWebhookId) return false;
    return this.paypalMode === 'sandbox' || this.liveAllowed();
  }

  paypalBaseUrl(): string {
    return this.paypalMode === 'live' && this.liveAllowed()
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
  }

  /** Tests only. */
  configure(values: Partial<Values>): void {
    Object.assign(this, values);
  }

  reset(): void {
    Object.assign(this, this.initial);
  }

  private snapshot(): Values {
    return {
      stripeSecret: null,
      stripeWebhookSecret: null,
      paypalClientId: null,
      paypalSecret: null,
      paypalWebhookId: null,
      paypalMode: 'sandbox',
      allowLive: false,
      invoicePrefix: 'INV',
    };
  }
}
