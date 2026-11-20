import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { isDemoEmail } from '../common/demo.js';
import { ENV, type Env } from '../config/env.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Machine-readable kind, e.g. `password_reset`; handy for tests and logs. */
  kind: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const MAILER = Symbol('MAILER');

/**
 * Dev/test mailer: keeps messages in memory (tests read them) and logs only the kind, never the
 * address or the body (which can hold a reset link).
 */
@Injectable()
export class MemoryMailer implements Mailer {
  private readonly logger = new Logger('Mailer');
  readonly sent: MailMessage[] = [];

  constructor(@Inject(ENV) private readonly env: Env) {}

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    if (this.sent.length > 100) this.sent.shift();
    this.logger.log(
      `Mail queued (${message.kind}); not delivered: no SMTP transport in ${this.env.NODE_ENV}.`,
    );
    if (this.env.NODE_ENV === 'development') this.logger.debug(message.text);
    return Promise.resolve();
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * The part of a Nodemailer transport the SMTP mailer uses (a fake in tests). Only these four
 * fields are ever passed: never `raw`, attachments or HTML (GHSA-p6gq-j5cr-w38f).
 */
export interface MailTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/** B31: real delivery over SMTP (Nodemailer). Errors propagate; callers decide (most log). */
export class SmtpMailer implements Mailer {
  private readonly logger = new Logger('Mailer');

  constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    this.logger.log(`Mail sent (${message.kind}).`);
  }
}

/** `a@x.com` matches the address `a@x.com` or the domain `x.com` (case-insensitive). */
export function recipientAllowed(to: string, allowed: readonly string[]): boolean {
  const address = to.trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return allowed.some((entry) => (entry.includes('@') ? entry === address : entry === domain));
}

export type MailMode = 'smtp' | 'memory';

export function smtpConfigured(env: Env): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM);
}

/**
 * What the app injects as `MAILER`: SMTP when configured, else the in-memory mailer, behind the
 * D140 recipient allowlist (`MAIL_ALLOWED_RECIPIENTS`). Never logs an address or a body.
 */
@Injectable()
export class MailGateway implements Mailer, OnApplicationBootstrap {
  private readonly logger = new Logger('Mailer');
  private inner!: Mailer;
  private mode!: MailMode;
  private allowed!: readonly string[] | null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly memory: MemoryMailer,
  ) {
    this.reset();
  }

  onApplicationBootstrap(): void {
    const allow = this.allowed
      ? `only to MAIL_ALLOWED_RECIPIENTS (${this.allowed.length} entries)`
      : 'to any recipient';
    this.logger.log(
      this.mode === 'smtp'
        ? `Mail mode: SMTP, ${allow}.`
        : `Mail mode: memory (SMTP not configured; nothing is delivered), ${allow}.`,
    );
  }

  async send(message: MailMessage): Promise<void> {
    // D153: demo logins never get mail (their `.test` domain does not exist anyway).
    if (isDemoEmail(message.to)) {
      this.logger.log(`Mail not sent (${message.kind}): demo account.`);
      return;
    }
    if (this.allowed && !recipientAllowed(message.to, this.allowed)) {
      this.logger.warn(`Mail not sent (${message.kind}): recipient not on the allowlist.`);
      return;
    }
    await this.inner.send(message);
  }

  /** Tests: swap the delivery (e.g. `SmtpMailer` over a fake transport) and the allowlist. */
  use(inner: Mailer, allowed: readonly string[] | null): void {
    this.inner = inner;
    this.allowed = allowed;
  }

  /** Back to what the environment says. */
  reset(): void {
    const smtp = smtpConfigured(this.env);
    this.mode = smtp ? 'smtp' : 'memory';
    this.inner = smtp
      ? new SmtpMailer(
          createTransport({
            host: this.env.SMTP_HOST,
            port: this.env.SMTP_PORT,
            // 465 = implicit TLS; any other port must upgrade with STARTTLS.
            secure: this.env.SMTP_PORT === 465,
            requireTLS: this.env.SMTP_PORT !== 465,
            auth: { user: this.env.SMTP_USER!, pass: this.env.SMTP_PASS! },
            // Plain-text mails only: no attachment or content is ever read from disk or a URL.
            disableFileAccess: true,
            disableUrlAccess: true,
          }),
          this.env.MAIL_FROM!,
        )
      : this.memory;
    this.allowed = this.env.MAIL_ALLOWED_RECIPIENTS?.length
      ? this.env.MAIL_ALLOWED_RECIPIENTS
      : null;
  }
}

@Global()
@Module({
  providers: [MemoryMailer, MailGateway, { provide: MAILER, useExisting: MailGateway }],
  exports: [MAILER, MemoryMailer, MailGateway],
})
export class MailModule {}
