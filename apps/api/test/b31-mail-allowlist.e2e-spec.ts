import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MailGateway, type MailTransport, SmtpMailer } from '../src/mail/mailer.js';
import { Client, createTestApp, createUser, resetState, type TestContext } from './helpers.js';

/*
| B31 + D140: real SMTP sits behind MAIL_ALLOWED_RECIPIENTS. A password reset for an allowed
| address goes out through the transport; one for anyone else is dropped, and the answer is the
| same either way. A transport failure does not reveal the account either.
*/

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

const GENERIC = 'If an active account uses this email, a password reset link has been sent to it.';
let sent: Parameters<MailTransport['sendMail']>[0][];

beforeEach(async () => {
  await resetState(ctx);
  sent = [];
  const transport: MailTransport = {
    sendMail: (mail) => {
      sent.push(mail);
      return Promise.resolve({});
    },
  };
  ctx.app
    .get(MailGateway)
    .use(new SmtpMailer(transport, 'Qarabic <no-reply@example.test>'), ['pilot.example.test']);
});

describe('password reset through the mail allowlist', () => {
  it('sends to an allowed domain and drops everyone else, with the same answer', async () => {
    const pilot = await createUser(ctx, 'manager', { email: 'staff@pilot.example.test' });
    const other = await createUser(ctx, 'manager', { email: 'family@elsewhere.test' });
    const client = await new Client(ctx.app).init();

    for (const email of [pilot.email, other.email]) {
      const res = await client.post('/auth/forgot-password', { email });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: GENERIC });
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: 'Qarabic <no-reply@example.test>',
      to: 'staff@pilot.example.test',
      subject: 'Reset your Qarabic password',
    });
    expect(sent[0]!.text).toMatch(/\/reset-password\?token=/);
    // SMTP was the delivery: nothing reached the in-memory mailer.
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('a failing SMTP server still gives the generic answer', async () => {
    const user = await createUser(ctx, 'manager', { email: 'staff@pilot.example.test' });
    ctx.app
      .get(MailGateway)
      .use(
        new SmtpMailer(
          { sendMail: () => Promise.reject(new Error('ECONNREFUSED')) },
          'Qarabic <no-reply@example.test>',
        ),
        null,
      );
    const client = await new Client(ctx.app).init();
    const res = await client.post('/auth/forgot-password', { email: user.email });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: GENERIC });
  });
});
