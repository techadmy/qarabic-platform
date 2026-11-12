import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fromDbDate } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { invoiceMail, type InvoiceMailKind } from './mail.js';
import { minor } from './money.js';

export type MailResult = 'sent' | 'unreachable' | 'failed' | 'disabled';

/**
 * Invoice emails to the family's parent through the app Mailer (memory in dev / test; no SMTP yet).
 * D140: nothing goes to a family while `billing.notify_parents` is off (the default).
 */
@Injectable()
export class BillingNotifier {
  private readonly logger = new Logger(BillingNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  enabled(): Promise<boolean> {
    return this.settings.get('billing.notify_parents');
  }

  /** Whether the invoice's parent can be mailed at all (an email on the login). */
  async recipient(invoiceId: number): Promise<{ email: string; locale: 'ar' | 'en' } | null> {
    const row = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        family: { select: { user: { select: { email: true, locale: true, isActive: true } } } },
      },
    });
    const user = row?.family.user;
    return user?.email && user.isActive ? { email: user.email, locale: user.locale } : null;
  }

  /** Sends now (the caller checked `enabled()` and claimed the slot when it needs one). */
  async deliver(invoiceId: number, kind: InvoiceMailKind): Promise<MailResult> {
    const to = await this.recipient(invoiceId);
    if (!to) return 'unreachable';
    const invoice = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const mail = invoiceMail(
      {
        id: invoice.id,
        number: invoice.number,
        currency: invoice.currency,
        balanceMinor: Math.max(0, minor(invoice.total) - minor(invoice.paid)),
        dueDate: invoice.dueDate ? fromDbDate(invoice.dueDate) : null,
      },
      kind,
      to.locale,
      this.env.APP_URL,
    );
    try {
      await this.mailer.send({
        to: to.email,
        subject: mail.subject,
        text: mail.text,
        kind: `invoice_${kind}`,
      });
      return 'sent';
    } catch (error) {
      this.logger.warn(
        `Invoice ${kind} email failed for invoice ${invoiceId}: ${(error as Error).message}`,
      );
      return 'failed';
    }
  }

  /** The "issued" email (after commit); a no-op while parent emails are off. */
  async issued(invoiceIds: number[]): Promise<void> {
    if (!invoiceIds.length || !(await this.enabled())) return;
    for (const id of invoiceIds) await this.deliver(id, 'issued');
  }
}
