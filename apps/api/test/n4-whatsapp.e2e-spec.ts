import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Crypto } from '../src/common/crypto.js';
import { signWebhook, WhatsAppConfig } from '../src/support/whatsapp.js';
import {
  clock,
  createTestApp,
  createUser,
  resetState,
  signedIn,
  type TestContext,
} from './helpers.js';

/*
 * Port of Laravel tests/Feature/Feedback/WhatsAppWebhookTest.php (docs/22 §5.2, D102): signed
 * webhook, idempotent by message id, sender matched by phone; off by default (404). Sending
 * replies and downloading media through the Graph API are out of scope (no Meta credentials).
 */

let ctx: TestContext;
const SECRET = 'test-app-secret';

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

let tester: Awaited<ReturnType<typeof createUser>>;

beforeEach(async () => {
  await resetState(ctx);
  clock(ctx).set('2026-11-10T10:00:00Z');
  ctx.app.get(WhatsAppConfig).configure({
    enabled: true,
    appSecret: SECRET,
    verifyToken: 'verify-me',
  });
  tester = await createUser(ctx, 'monitor', { phone: '+201001234567' });
});

function payload(from: string, message: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '1234567890' },
              contacts: [{ wa_id: from, profile: { name: 'Tester' } }],
              messages: [{ from, timestamp: '1762768800', ...message }],
            },
          },
        ],
      },
    ],
  };
}

function post(body: object | string, secret: string | null = SECRET) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const req = request(ctx.app.getHttpServer())
    .post('/api/v1/webhooks/whatsapp')
    .set('Content-Type', 'application/json');
  if (secret !== null) req.set('X-Hub-Signature-256', signWebhook(raw, secret));
  return req.send(raw);
}

const text = (from: string, id: string, body: string) =>
  payload(from, { id, type: 'text', text: { body } });

describe('WhatsApp intake (WhatsAppWebhookTest)', () => {
  it('is off by default: both webhook routes are 404 and nothing is stored', async () => {
    ctx.app.get(WhatsAppConfig).reset();
    const get = await request(ctx.app.getHttpServer()).get(
      '/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42',
    );
    expect(get.status).toBe(404);
    expect((await post(text('201001234567', 'wamid.1', 'Hello'))).status).toBe(404);
    expect(await ctx.prisma.whatsAppInboundMessage.count()).toBe(0);
  });

  it('answers the Meta verification only with the right token', async () => {
    const ok = await request(ctx.app.getHttpServer()).get(
      '/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444',
    );
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('1158201444');
    const bad = await request(ctx.app.getHttpServer()).get(
      '/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1',
    );
    expect(bad.status).toBe(403);
  });

  it('rejects a missing, wrong or stale X-Hub-Signature-256', async () => {
    const body = text('201001234567', 'wamid.sig', 'Hello there');
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, 'another-secret')).status).toBe(401);
    // A signed body, then a tampered body with the old signature.
    const raw = JSON.stringify(body);
    const tampered = await request(ctx.app.getHttpServer())
      .post('/api/v1/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signWebhook(raw, SECRET))
      .send(raw.replace('Hello there', 'Hello thete'));
    expect(tampered.status).toBe(401);
    // No app secret configured: nothing is accepted.
    ctx.app.get(WhatsAppConfig).configure({ appSecret: null });
    expect((await post(body)).status).toBe(401);
    expect(await ctx.prisma.ticket.count()).toBe(0);
  });

  it('turns a tester message into a ticket, once per message id', async () => {
    const body = text('201001234567', 'wamid.A1', 'Payslip page is empty\nOn my phone');
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200); // Meta retry

    const tickets = await ctx.prisma.ticket.findMany();
    expect(tickets).toHaveLength(1);
    const t = tickets[0]!;
    expect(t).toMatchObject({
      channel: 'whatsapp',
      reporterId: tester.id,
      reporterRole: 'monitor',
      title: 'Payslip page is empty',
    });
    // The number is stored encrypted only.
    expect(t.contactPhone).not.toContain('201001234567');
    expect(ctx.app.get(Crypto).decrypt(t.contactPhone!)).toBe('201001234567');
    expect(t.whatsappWindowUntil!.getTime()).toBeGreaterThan(clock(ctx).nowMs());
    const inbound = await ctx.prisma.whatsAppInboundMessage.findMany();
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ status: 'ticket_created', ticketId: t.id });
  });

  it('groups follow-ups into the same ticket, notes media it did not fetch, then starts a new one', async () => {
    await post(text('201001234567', 'wamid.B1', 'The fine form does not save'));
    await post(
      payload('201001234567', {
        id: 'wamid.B2',
        type: 'image',
        image: { id: 'MEDIA1', mime_type: 'image/png', caption: 'see this' },
      }),
    );
    const t = await ctx.prisma.ticket.findFirstOrThrow();
    expect(await ctx.prisma.ticket.count()).toBe(1);
    expect(
      await ctx.prisma.ticketComment.count({ where: { ticketId: t.id, body: 'see this' } }),
    ).toBe(1);
    expect(
      await ctx.prisma.ticketComment.count({
        where: { ticketId: t.id, kind: 'system', internal: true },
      }),
    ).toBe(1);
    expect(
      (
        await ctx.prisma.whatsAppInboundMessage.findUniqueOrThrow({
          where: { waMessageId: 'wamid.B2' },
        })
      ).status,
    ).toBe('appended');

    // After the grouping window, a new message is a new ticket.
    clock(ctx).set('2026-11-10T10:31:00Z');
    await post(text('201001234567', 'wamid.B3', 'Another problem'));
    expect(await ctx.prisma.ticket.count()).toBe(2);
  });

  it('ignores unknown senders without storing the number', async () => {
    await post(text('447700900123', 'wamid.U1', 'I want to register my kids'));
    expect(await ctx.prisma.ticket.count()).toBe(0);
    const row = await ctx.prisma.whatsAppInboundMessage.findFirstOrThrow();
    expect(row.status).toBe('ignored_unknown');
    expect(row.fromHash).not.toContain('447700900123');
  });

  it('accepts unknown senders when allowed, keeping the contact for replies', async () => {
    ctx.app.get(WhatsAppConfig).configure({ allowUnknown: true });
    await post(text('447700900123', 'wamid.U2', 'The receipt link is broken'));
    const t = await ctx.prisma.ticket.findFirstOrThrow();
    expect(t.reporterId).toBeNull();
    expect(ctx.app.get(Crypto).decrypt(t.contactPhone!)).toBe('447700900123');
    // The same unknown sender's follow-up joins it (matched by the hashed number).
    await post(text('447700900123', 'wamid.U3', 'Still broken'));
    expect(await ctx.prisma.ticket.count()).toBe(1);
  });

  it('ignores types other than text, images and voice notes', async () => {
    await post(payload('201001234567', { id: 'wamid.V1', type: 'video', video: { id: 'VID' } }));
    expect(await ctx.prisma.ticket.count()).toBe(0);
    expect((await ctx.prisma.whatsAppInboundMessage.findFirstOrThrow()).status).toBe(
      'ignored_type',
    );
  });

  it('moves a needs-info ticket back to triaged when the reporter answers on WhatsApp', async () => {
    await post(text('201001234567', 'wamid.N1', 'Cannot start the class'));
    const t = await ctx.prisma.ticket.findFirstOrThrow();
    const admin = await signedIn(ctx, 'admin');
    expect(
      (
        await admin.client.patch(`/feedback/tickets/${t.id}`, {
          priority: 'p1',
          status: 'needs_info',
          note: 'Which class?',
        })
      ).status,
    ).toBe(200);
    clock(ctx).set('2026-11-10T13:00:00Z');
    await post(text('201001234567', 'wamid.N2', 'It was the 8pm class'));
    expect((await ctx.prisma.ticket.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(
      'triaged',
    );
    expect(await ctx.prisma.ticket.count()).toBe(1);
  });

  it('ignores status callbacks and malformed entries', async () => {
    const res = await post({
      entry: [
        { changes: [{ field: 'messages', value: { statuses: [{ id: 'x', status: 'read' }] } }] },
        'junk',
      ],
    });
    expect(res.status).toBe(200);
    expect(await ctx.prisma.whatsAppInboundMessage.count()).toBe(0);
  });
});
