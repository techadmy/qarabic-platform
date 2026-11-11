import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

/** Max seconds between the snippet's `X-Qarabic-Timestamp` and our clock (Laravel 300). */
export const WEB_LEAD_MAX_SKEW_SECONDS = 300;
/** Same email / phone on an open lead created within this many days = the same lead (D107). */
export const DUPLICATE_WINDOW_DAYS = 30;
/** Parent "refer a friend" submissions per hour. */
export const REFERRALS_PER_HOUR = 10;
/** Public course list calls per minute per IP (Laravel `throttle:60,1`). */
export const PUBLIC_COURSES_PER_MINUTE = 60;
export const TRIAL_DEFAULT_MINUTES = 30;

/**
 * Public intake configuration (Laravel `config/crm.php` + `config/forms.php`), read from the
 * environment once. Tests change it in place and call `reset()`, like `config([...])`.
 */
@Injectable()
export class CrmConfig {
  webhookSecret!: string | null;
  wpformsFormIds!: number[];
  courseMap!: Record<string, number>;
  honeypotField!: string;
  captchaDriver!: 'none' | 'turnstile';
  captchaField!: string;
  turnstileSecret!: string | null;
  classRequestPerMinute!: number;
  webLeadsPerMinute!: number;
  referralsPerHour!: number;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.reset();
  }

  reset(): void {
    this.webhookSecret = this.env.WEB_LEADS_WEBHOOK_SECRET ?? null;
    this.wpformsFormIds = [...this.env.WEB_LEADS_WPFORMS_FORM_IDS];
    this.courseMap = { ...this.env.WEB_LEADS_COURSE_MAP };
    this.honeypotField = this.env.FORMS_HONEYPOT_FIELD;
    this.captchaDriver = this.env.FORMS_CAPTCHA_DRIVER;
    this.captchaField = this.env.FORMS_CAPTCHA_FIELD;
    this.turnstileSecret = this.env.TURNSTILE_SECRET_KEY ?? null;
    this.classRequestPerMinute = this.env.FORMS_CLASS_REQUEST_PER_MINUTE;
    this.webLeadsPerMinute = this.env.FORMS_WEB_LEADS_PER_MINUTE;
    this.referralsPerHour = REFERRALS_PER_HOUR;
  }
}

/** `sha256=` + hex HMAC-SHA256(secret, "{timestamp}.{raw body}") — the WordPress snippet's signature. */
export function signWebLead(secret: string, timestamp: string, body: Buffer | string): string {
  return (
    'sha256=' + createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex')
  );
}

/** Constant-time check of the signature and the timestamp window (unix seconds). */
export function verifyWebLead(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  body: Buffer,
  nowMs: number,
): boolean {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signature) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > WEB_LEAD_MAX_SKEW_SECONDS) {
    return false;
  }
  const expected = Buffer.from(signWebLead(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
