import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
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
 * address or the body (which can hold a reset link). SMTP (Nodemailer, B31) replaces it later.
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

@Global()
@Module({
  providers: [MemoryMailer, { provide: MAILER, useExisting: MemoryMailer }],
  exports: [MAILER, MemoryMailer],
})
export class MailModule {}
