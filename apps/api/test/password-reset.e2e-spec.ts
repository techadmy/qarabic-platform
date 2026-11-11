import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/auth/tokens.js';
import { Client, createTestApp, createUser, resetState, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await resetState(ctx);
});

const GENERIC = 'If an active account uses this email, a password reset link has been sent to it.';
const NEW_PASSWORD = 'Brand-new-pass-77';

function tokenFromMail(): string {
  const mail = ctx.mailer.sent.at(-1);
  if (!mail) throw new Error('no mail sent');
  const url = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
  expect(url.pathname).toBe('/reset-password');
  expect(url.searchParams.has('email')).toBe(false); // no personal data in the link
  return url.searchParams.get('token')!;
}

describe('forgot / reset password', () => {
  it('answers the same for known, unknown and inactive emails; mails only the active account', async () => {
    const user = await createUser(ctx, 'manager');
    const inactive = await createUser(ctx, 'manager', { isActive: false });
    const client = await new Client(ctx.app).init();

    for (const email of [user.email, 'nobody@example.test', inactive.email]) {
      const res = await client.post('/auth/forgot-password', { email });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: GENERIC });
    }
    expect(ctx.mailer.sent).toHaveLength(1);
    expect(ctx.mailer.sent[0]).toMatchObject({ to: user.email, kind: 'password_reset' });

    // The token is stored hashed.
    const token = tokenFromMail();
    const row = await ctx.prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.tokenHash).toBe(sha256(token));
  });

  it('resets the password once, signs out other sessions, and the token is single use', async () => {
    const user = await createUser(ctx, 'manager');
    const other = await new Client(ctx.app).init();
    expect((await other.login(user.email)).status).toBe(200);

    const client = await new Client(ctx.app).init();
    await client.post('/auth/forgot-password', { email: user.email });
    const token = tokenFromMail();

    const res = await client.post('/auth/reset-password', { token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect((await other.get('/auth/me')).status).toBe(401);

    expect((await client.login(user.email)).status).toBe(422);
    expect((await client.login(user.email, NEW_PASSWORD)).status).toBe(200);

    const reuse = await client.post('/auth/reset-password', { token, password: 'Another-pass-88' });
    expect(reuse.status).toBe(422);
    expect(reuse.body.code).toBe('invalid_reset_token');
  });

  it('rejects an expired token (60 minutes)', async () => {
    const user = await createUser(ctx, 'manager');
    const client = await new Client(ctx.app).init();
    await client.post('/auth/forgot-password', { email: user.email });
    const token = tokenFromMail();
    const row = await ctx.prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(60 * 60 * 1000);

    await ctx.prisma.passwordResetToken.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await client.post('/auth/reset-password', { token, password: NEW_PASSWORD });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('invalid_reset_token');
  });

  it('a new request replaces the previous token', async () => {
    const user = await createUser(ctx, 'manager');
    const client = await new Client(ctx.app).init();
    await client.post('/auth/forgot-password', { email: user.email });
    const first = tokenFromMail();
    await client.post('/auth/forgot-password', { email: user.email });
    const second = tokenFromMail();

    expect(
      (await client.post('/auth/reset-password', { token: first, password: NEW_PASSWORD })).status,
    ).toBe(422);
    expect(
      (await client.post('/auth/reset-password', { token: second, password: NEW_PASSWORD })).status,
    ).toBe(200);
  });

  it('rejects unknown tokens and short passwords', async () => {
    const client = await new Client(ctx.app).init();
    const bad = await client.post('/auth/reset-password', {
      token: 'x'.repeat(43),
      password: NEW_PASSWORD,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('invalid_reset_token');

    const short = await client.post('/auth/reset-password', {
      token: 'x'.repeat(43),
      password: 'short',
    });
    expect(short.status).toBe(422);
    expect(short.body.errors).toHaveProperty('password');
  });

  it('is throttled per IP (5 per minute)', async () => {
    const client = await new Client(ctx.app).init();
    for (let i = 0; i < 5; i++) {
      expect(
        (await client.post('/auth/forgot-password', { email: `x${i}@example.test` })).status,
      ).toBe(200);
    }
    expect((await client.post('/auth/forgot-password', { email: 'y@example.test' })).status).toBe(
      429,
    );
  });
});
