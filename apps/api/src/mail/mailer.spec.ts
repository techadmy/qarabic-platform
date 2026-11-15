import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import {
  MailGateway,
  type MailMessage,
  type MailTransport,
  MemoryMailer,
  recipientAllowed,
  SmtpMailer,
} from './mailer.js';

const base = {
  DATABASE_URL: 'postgresql://u@localhost:5433/app_test',
  WEB_ORIGIN: 'http://localhost:3000',
  SESSION_SECRET: 'x'.repeat(40),
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
};
const smtp = {
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '465',
  SMTP_USER: 'mailer@example.test',
  SMTP_PASS: 'not-a-real-password',
  MAIL_FROM: 'Qarabic <mailer@example.test>',
};
const message = (to: string): MailMessage => ({
  to,
  subject: 'Subject',
  text: 'Body with https://example.test/reset?token=secret',
  kind: 'password_reset',
});

function fakeTransport() {
  const sent: Parameters<MailTransport['sendMail']>[0][] = [];
  const transport: MailTransport = {
    sendMail: (mail) => {
      sent.push(mail);
      return Promise.resolve({});
    },
  };
  return { sent, transport };
}

type Logs = { logger: { log: (m: string) => void; warn: (m: string) => void } };
const loggerOf = (g: MailGateway) => (g as unknown as Logs).logger;

describe('recipientAllowed', () => {
  const list = ['ahmed@example.test', 'qarabic.test'];
  it('matches an exact address or a whole domain, any case', () => {
    expect(recipientAllowed('Ahmed@Example.test', list)).toBe(true);
    expect(recipientAllowed('anyone@QARABIC.test', list)).toBe(true);
    expect(recipientAllowed('other@example.test', list)).toBe(false);
    expect(recipientAllowed('x@sub.qarabic.test', list)).toBe(false);
    expect(recipientAllowed('x@evilqarabic.test', list)).toBe(false);
  });
});

describe('SmtpMailer', () => {
  it('sends from MAIL_FROM through the transport', async () => {
    const { sent, transport } = fakeTransport();
    await new SmtpMailer(transport, 'Qarabic <mailer@example.test>').send(message('a@x.test'));
    expect(sent).toEqual([
      {
        from: 'Qarabic <mailer@example.test>',
        to: 'a@x.test',
        subject: 'Subject',
        text: 'Body with https://example.test/reset?token=secret',
      },
    ]);
  });

  it('lets a transport error reach the caller', async () => {
    const transport: MailTransport = { sendMail: () => Promise.reject(new Error('EAUTH')) };
    await expect(new SmtpMailer(transport, 'f@x.test').send(message('a@x.test'))).rejects.toThrow(
      'EAUTH',
    );
  });
});

describe('MailGateway', () => {
  it('says at startup which mode is active, without addresses, hosts or secrets', () => {
    const logs: string[] = [];
    const env = loadEnv(base);
    const memoryGateway = new MailGateway(env, new MemoryMailer(env));
    vi.spyOn(loggerOf(memoryGateway), 'log').mockImplementation((m) => void logs.push(m));
    memoryGateway.onApplicationBootstrap();

    const smtpEnv = loadEnv({ ...base, ...smtp, MAIL_ALLOWED_RECIPIENTS: 'qarabic.test' });
    const smtpGateway = new MailGateway(smtpEnv, new MemoryMailer(smtpEnv));
    vi.spyOn(loggerOf(smtpGateway), 'log').mockImplementation((m) => void logs.push(m));
    smtpGateway.onApplicationBootstrap();

    expect(logs[0]).toMatch(/^Mail mode: memory/);
    expect(logs[1]).toMatch(/^Mail mode: SMTP, only to MAIL_ALLOWED_RECIPIENTS \(1 entries\)/);
    expect(logs.join(' ')).not.toMatch(/qarabic\.test|example\.test|not-a-real-password/);
  });

  it('drops recipients outside the allowlist, logging the kind only', async () => {
    const env = loadEnv(base);
    const gateway = new MailGateway(env, new MemoryMailer(env));
    const { sent, transport } = fakeTransport();
    gateway.use(new SmtpMailer(transport, 'f@x.test'), ['allowed@x.test', 'team.test']);
    const warn = vi.spyOn(loggerOf(gateway), 'warn').mockImplementation(() => undefined);

    await gateway.send(message('family@elsewhere.test'));
    await gateway.send(message('allowed@x.test'));
    await gateway.send(message('anyone@team.test'));

    expect(sent.map((m) => m.to)).toEqual(['allowed@x.test', 'anyone@team.test']);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain('password_reset');
    expect(line).not.toMatch(/elsewhere|token|Body/);
  });

  it('sends to anyone when no allowlist is set', async () => {
    const env = loadEnv(base);
    const gateway = new MailGateway(env, new MemoryMailer(env));
    const { sent, transport } = fakeTransport();
    gateway.use(new SmtpMailer(transport, 'f@x.test'), null);
    await gateway.send(message('anyone@anywhere.test'));
    expect(sent).toHaveLength(1);
  });
});

describe('mail env', () => {
  it('needs all five SMTP keys or none, without printing values', () => {
    expect(() => loadEnv({ ...base, SMTP_HOST: 'smtp.example.test' })).toThrow(/SMTP_PORT/);
    expect(() => loadEnv({ ...base, ...smtp })).not.toThrow();
    expect(() => loadEnv({ ...base, ...smtp, SMTP_PASS: '' })).toThrow(/SMTP_PASS/);
    expect(() => loadEnv({ ...base, ...smtp, SMTP_USER: '' })).not.toThrow(/not-a-real/);
  });

  it('parses the allowlist (addresses and domains, lower-case)', () => {
    const env = loadEnv({ ...base, MAIL_ALLOWED_RECIPIENTS: ' A@X.test , @Team.test ,' });
    expect(env.MAIL_ALLOWED_RECIPIENTS).toEqual(['a@x.test', 'team.test']);
    expect(loadEnv({ ...base, MAIL_ALLOWED_RECIPIENTS: '' }).MAIL_ALLOWED_RECIPIENTS).toBe(
      undefined,
    );
  });
});
