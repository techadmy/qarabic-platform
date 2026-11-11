import request from 'supertest';
import { CrmConfig, signWebLead } from '../src/crm/crm.config.js';
import { CaptchaVerifier } from '../src/crm/captcha.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { phoneDigits } from '../src/crm/spam.js';
import { clock, type TestContext } from './helpers.js';

/*
| N5 CRM helpers (Laravel tests/Feature/Crm/Helpers.php): leads are created directly; the clock
| is pinned with `crmAt()`; the intake config is reset before each test.
*/

let seq = 0;

export function crmAt(ctx: TestContext, utc: string): void {
  clock(ctx).set(utc);
}

/** Resets the public-intake config to the test defaults (like `config([...])` per test). */
export function resetCrm(ctx: TestContext): CrmConfig {
  const config = ctx.app.get(CrmConfig);
  config.reset();
  config.webhookSecret = null;
  config.wpformsFormIds = [4823];
  config.courseMap = {};
  config.honeypotField = 'website';
  config.captchaDriver = 'none';
  config.classRequestPerMinute = 5;
  config.webLeadsPerMinute = 30;
  config.referralsPerHour = 10;
  const captcha = ctx.app.get(CaptchaVerifier);
  captcha.fetcher = () => Promise.reject(new Error('no network in tests'));
  return config;
}

type LeadAttrs = Partial<Prisma.LeadUncheckedCreateInput>;

/** A lead straight in the database (Laravel `crmLead`). */
export function crmLead(ctx: TestContext, attrs: LeadAttrs = {}) {
  seq += 1;
  const now = clock(ctx).now();
  const phone = attrs.phone === undefined ? `+44 7700 900${100 + seq}` : attrs.phone;
  return ctx.prisma.lead.create({
    data: {
      status: 'new',
      source: 'phone',
      parentName: 'Umm Maryam',
      email: `umm.maryam${seq}@example.com`,
      timezone: 'Europe/London',
      children: [{ name: 'Maryam', age: 8, gender: 'female' }],
      statusChangedAt: now,
      createdAt: now,
      updatedAt: now,
      ...attrs,
      phone,
      phoneDigits: attrs.phoneDigits === undefined ? phoneDigits(phone) : attrs.phoneDigits,
    },
  });
}

export const WEB_SECRET = 'test-web-leads-secret';

export function wpPayload(
  fields: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    form_id: 4823,
    entry_id: 1501,
    submitted_at: '2026-11-16T09:00:00+00:00',
    page_url: 'https://qarabic.com/free-trial/?utm_source=google&utm_medium=cpc&utm_campaign=kids',
    referer: 'https://www.google.com/',
    ...extra,
    fields: {
      name: 'Umm Adam',
      email: 'umm.adam@example.com',
      phone: '+447700900321',
      course_for: 'Your Kids',
      children_count: '2',
      student_age: '7 and 10',
      course: 'Quran for Kids',
      notes: 'Weekends please',
      ...fields,
    },
  };
}

/**
 * Posts the raw JSON body with the snippet's headers. The body is encoded like PHP's
 * `wp_json_encode` (slashes escaped), so the signature is checked over the raw bytes.
 */
export function wpPost(
  ctx: TestContext,
  payload: Record<string, unknown>,
  opts: { secret?: string | null; timestamp?: number; body?: string } = {},
) {
  const body = opts.body ?? JSON.stringify(payload).replace(/\//g, '\\/');
  const ts = String(opts.timestamp ?? Math.floor(clock(ctx).nowMs() / 1000));
  let req = request(ctx.app.getHttpServer())
    .post('/api/v1/public/web-leads/wpforms')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json')
    .set('X-Qarabic-Timestamp', ts);
  const secret = opts.secret === undefined ? WEB_SECRET : opts.secret;
  if (secret !== null) req = req.set('X-Qarabic-Signature', signWebLead(secret, ts, body));
  return req.send(body);
}

/** A public (cookie-less, token-less) POST, as a website or a bot sends it. */
export function publicPost(ctx: TestContext, path: string, body: object) {
  return request(ctx.app.getHttpServer())
    .post(path.startsWith('/api/') ? path : `/api/v1${path}`)
    .set('Accept', 'application/json')
    .send(body);
}

export function publicGet(ctx: TestContext, path: string) {
  return request(ctx.app.getHttpServer()).get(`/api/v1${path}`).set('Accept', 'application/json');
}

/** Sets a stored setting (Laravel `Settings::set`). */
export async function setSetting(ctx: TestContext, key: string, value: Prisma.InputJsonValue) {
  await ctx.prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

/** Lead alert notifications sent (in-app rows), as `[userId, event]`. */
export async function alerts(ctx: TestContext) {
  const rows = await ctx.prisma.notification.findMany({ orderBy: { id: 'asc' } });
  return rows.map((r) => ({
    userId: r.userId,
    event: r.event,
    data: r.data as Record<string, unknown>,
  }));
}
