import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { fromMinor, toMinor } from '@qarabic/shared';
import { Clock } from '../common/clock.js';
import { ENV, type Env } from '../config/env.js';
import { BillingConfig } from './billing.config.js';

/** A provider call failed; the message is safe to log (no keys, no card data). */
export class GatewayError extends Error {}

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}
export interface HttpResponse {
  status: number;
  json: unknown;
}
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

const realTransport: HttpTransport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

/** The test default: no network at all (a test that needs a provider installs a fake). */
const noNetwork: HttpTransport = (req) =>
  Promise.reject(new GatewayError(`No network in tests: ${req.method} ${new URL(req.url).host}`));

/**
 * Outgoing calls to Stripe and PayPal. Under NODE_ENV=test the transport refuses every call until a
 * test installs a fake (`use()`), so no test can reach a provider; without keys the gateways are
 * off and nothing is called at all.
 */
@Injectable()
export class PaymentHttp {
  private readonly fallback: HttpTransport;
  private transport: HttpTransport;

  constructor(@Inject(ENV) env: Env) {
    this.fallback = env.NODE_ENV === 'test' ? noNetwork : realTransport;
    this.transport = this.fallback;
  }

  use(transport: HttpTransport | null): void {
    this.transport = transport ?? this.fallback;
  }

  send(req: HttpRequest): Promise<HttpResponse> {
    return this.transport(req);
  }
}

/** Reads `a.b.0.c` out of an unknown JSON value. */
export function pick(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export interface CheckoutTarget {
  paymentId: number;
  invoiceId: number;
  invoiceNumber: string | null;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  email: string | null;
  returnUrl: string;
  cancelUrl: string;
}

export interface PaymentGateway {
  enabled(): boolean;
  /** The hosted checkout for the payment's amount: `{ ref, url }`. */
  createCheckout(target: CheckoutTarget): Promise<{ ref: string; url: string }>;
  /**
   * P1-1: closes a checkout nobody should pay any more (manual payment, split, void, a newer
   * attempt). Best effort: a failure is logged, never thrown (the attempt is already cancelled).
   */
  expire(ref: string): Promise<void>;
}

/** Stripe's form encoding of nested params (`line_items[0][price_data][currency]=usd`). */
export function stripeForm(params: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (value: unknown, key: string) => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${key}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}[${k}]` : k);
    }
  };
  walk(params, '');
  return out.join('&');
}

/**
 * Stripe Checkout Sessions over the REST API (docs/20 §7.2). Paid status comes only from the
 * signed webhook; this class never marks anything paid.
 */
@Injectable()
export class StripeGateway implements PaymentGateway {
  static readonly API = 'https://api.stripe.com/v1';
  /** Seconds a signed webhook stays valid (Stripe's default tolerance). */
  static readonly TOLERANCE = 300;

  constructor(
    private readonly config: BillingConfig,
    private readonly http: PaymentHttp,
    private readonly clock: Clock,
  ) {}

  enabled(): boolean {
    return this.config.stripeEnabled();
  }

  async createCheckout(t: CheckoutTarget): Promise<{ ref: string; url: string }> {
    const ids = { payment_id: String(t.paymentId), invoice_id: String(t.invoiceId) };
    const body = stripeForm({
      mode: 'payment',
      client_reference_id: String(t.paymentId),
      success_url: t.returnUrl,
      cancel_url: t.cancelUrl,
      expires_at: Math.floor(this.clock.nowMs() / 1000) + 3600,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: t.currency.toLowerCase(),
            unit_amount: t.amountMinor,
            product_data: { name: `Qarabic invoice ${t.invoiceNumber ?? t.invoiceId}` },
          },
        },
      ],
      metadata: ids,
      payment_intent_data: { metadata: ids },
      ...(t.email ? { customer_email: t.email } : {}),
    });
    const res = await this.http.send({
      method: 'POST',
      url: `${StripeGateway.API}/checkout/sessions`,
      headers: {
        Authorization: `Bearer ${this.config.stripeSecret ?? ''}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': t.idempotencyKey,
      },
      body,
    });
    const id = str(pick(res.json, 'id'));
    const url = str(pick(res.json, 'url'));
    if (res.status >= 300 || !id || !url) {
      throw new GatewayError(
        `Stripe checkout failed: HTTP ${res.status} ${str(pick(res.json, 'error.code')) ?? ''}`,
      );
    }
    return { ref: id, url };
  }

  async expire(ref: string): Promise<void> {
    const res = await this.http.send({
      method: 'POST',
      url: `${StripeGateway.API}/checkout/sessions/${encodeURIComponent(ref)}/expire`,
      headers: {
        Authorization: `Bearer ${this.config.stripeSecret ?? ''}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
    });
    // 400 = already completed or expired: nothing left to close.
    if (res.status >= 300 && res.status !== 400) {
      throw new GatewayError(`Stripe expire failed: HTTP ${res.status}`);
    }
  }

  /** `Stripe-Signature: t=…,v1=…` with v1 = HMAC-SHA256(secret, "{t}.{payload}"); any v1 may match. */
  static verifySignature(
    payload: Buffer,
    header: string,
    secret: string,
    toleranceSeconds: number,
    nowSeconds: number,
  ): boolean {
    if (!secret || !header) return false;
    let timestamp: string | null = null;
    const signatures: string[] = [];
    for (const part of header.split(',')) {
      const [k, v = ''] = part.trim().split('=', 2) as [string, string?];
      if (k === 't') timestamp = v;
      else if (k === 'v1') signatures.push(v);
    }
    if (timestamp === null || !/^\d{1,12}$/.test(timestamp) || !signatures.length) return false;
    if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;
    const expected = Buffer.from(StripeGateway.hmac(payload, secret, timestamp));
    return signatures.some((sig) => {
      const given = Buffer.from(sig);
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  }

  static hmac(payload: Buffer | string, secret: string, timestamp: string | number): string {
    return createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest('hex');
  }

  /** The header Stripe would send (tests and local tools). */
  static sign(payload: Buffer | string, secret: string, timestamp: number): string {
    return `t=${timestamp},v1=${StripeGateway.hmac(payload, secret, timestamp)}`;
  }
}

export interface PayPalCapture {
  status: string;
  captureId: string | null;
  amountMinor: number | null;
  currency: string | null;
  customId: string | null;
}

const PAYPAL_HEADERS = [
  'paypal-transmission-id',
  'paypal-transmission-time',
  'paypal-transmission-sig',
  'paypal-cert-url',
  'paypal-auth-algo',
] as const;
export type PayPalHeaders = Partial<Record<(typeof PAYPAL_HEADERS)[number], string>>;

/**
 * PayPal Orders v2 (docs/20 §7.3): create → the parent approves → server capture (or the verified
 * CHECKOUT.ORDER.APPROVED webhook). Only PayPal's capture answer marks a payment succeeded.
 */
@Injectable()
export class PayPalGateway implements PaymentGateway {
  private readonly logger = new Logger(PayPalGateway.name);
  private token: { key: string; value: string; until: number } | null = null;

  constructor(
    private readonly config: BillingConfig,
    private readonly http: PaymentHttp,
    private readonly clock: Clock,
  ) {}

  enabled(): boolean {
    return this.config.paypalEnabled();
  }

  /** An unapproved PayPal order simply lapses (about 3 hours); a late capture becomes a credit. */
  expire(): Promise<void> {
    return Promise.resolve();
  }

  async createCheckout(t: CheckoutTarget): Promise<{ ref: string; url: string }> {
    const res = await this.call('POST', '/v2/checkout/orders', {
      headers: { 'PayPal-Request-Id': t.idempotencyKey, Prefer: 'return=representation' },
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: String(t.paymentId),
            custom_id: String(t.paymentId),
            invoice_id: `${t.invoiceNumber ?? t.invoiceId}-${t.paymentId}`,
            description: `Qarabic invoice ${t.invoiceNumber ?? t.invoiceId}`,
            amount: { currency_code: t.currency, value: fromMinor(t.amountMinor) },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: t.returnUrl,
              cancel_url: t.cancelUrl,
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
            },
          },
        },
      },
    });
    const links = pick(res.json, 'links');
    const approve: unknown = Array.isArray(links)
      ? (links as unknown[]).find((l) =>
          ['payer-action', 'approve'].includes(String(pick(l, 'rel'))),
        )
      : undefined;
    const id = str(pick(res.json, 'id'));
    const url = str(pick(approve, 'href'));
    if (res.status >= 300 || !id || !url) {
      throw new GatewayError(
        `PayPal order failed: HTTP ${res.status} ${str(pick(res.json, 'name')) ?? ''}`,
      );
    }
    return { ref: id, url };
  }

  /** Captures an approved order; PayPal's view of the capture. */
  async capture(orderId: string, requestId: string): Promise<PayPalCapture> {
    const path = `/v2/checkout/orders/${encodeURIComponent(orderId)}`;
    let res = await this.call('POST', `${path}/capture`, {
      headers: { 'PayPal-Request-Id': requestId, Prefer: 'return=representation' },
      body: {},
    });
    if (res.status === 422 && pick(res.json, 'details.0.issue') === 'ORDER_ALREADY_CAPTURED') {
      res = await this.call('GET', path, {});
    }
    if (res.status >= 300) {
      throw new GatewayError(
        `PayPal capture failed: HTTP ${res.status} ${str(pick(res.json, 'details.0.issue')) ?? str(pick(res.json, 'name')) ?? ''}`,
      );
    }
    const capture = pick(res.json, 'purchase_units.0.payments.captures.0') ?? {};
    const currency = str(pick(capture, 'amount.currency_code'));
    const value = str(pick(capture, 'amount.value'));
    let amountMinor: number | null = null;
    if (currency && value) {
      try {
        amountMinor = toMinor(value);
      } catch {
        amountMinor = null;
      }
    }
    return {
      status: str(pick(capture, 'status')) ?? str(pick(res.json, 'status')) ?? '',
      captureId: str(pick(capture, 'id')),
      amountMinor,
      currency,
      customId:
        str(pick(capture, 'custom_id')) ?? str(pick(res.json, 'purchase_units.0.custom_id')),
    };
  }

  /** PayPal's own check of a webhook (`POST /v1/notifications/verify-webhook-signature`). */
  async verifyWebhook(headers: PayPalHeaders, event: unknown): Promise<boolean> {
    for (const h of PAYPAL_HEADERS) if (!headers[h]) return false;
    // Certificates must come from PayPal itself.
    let cert: URL;
    try {
      cert = new URL(headers['paypal-cert-url']!);
    } catch {
      return false;
    }
    if (cert.protocol !== 'https:' || !/(^|\.)paypal\.com$/.test(cert.hostname)) return false;
    try {
      const res = await this.call('POST', '/v1/notifications/verify-webhook-signature', {
        body: {
          auth_algo: headers['paypal-auth-algo'],
          cert_url: headers['paypal-cert-url'],
          transmission_id: headers['paypal-transmission-id'],
          transmission_sig: headers['paypal-transmission-sig'],
          transmission_time: headers['paypal-transmission-time'],
          webhook_id: this.config.paypalWebhookId,
          webhook_event: event,
        },
      });
      return res.status < 300 && pick(res.json, 'verification_status') === 'SUCCESS';
    } catch (error) {
      this.logger.warn(`PayPal webhook verification failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    opts: { headers?: Record<string, string>; body?: unknown },
  ): Promise<HttpResponse> {
    return this.http.send({
      method,
      url: `${this.config.paypalBaseUrl()}${path}`,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await this.accessToken()}`,
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  }

  private async accessToken(): Promise<string> {
    const key = `${this.config.paypalBaseUrl()}|${this.config.paypalClientId}`;
    const now = this.clock.nowMs();
    if (this.token && this.token.key === key && this.token.until > now) return this.token.value;
    const basic = Buffer.from(`${this.config.paypalClientId}:${this.config.paypalSecret}`).toString(
      'base64',
    );
    const res = await this.http.send({
      method: 'POST',
      url: `${this.config.paypalBaseUrl()}/v1/oauth2/token`,
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const value = str(pick(res.json, 'access_token'));
    if (res.status >= 300 || !value)
      throw new GatewayError(`PayPal auth failed: HTTP ${res.status}`);
    this.token = { key, value, until: now + 300_000 };
    return value;
  }

  /** Tests only: forget the cached token. */
  forgetToken(): void {
    this.token = null;
  }
}
