import { Injectable } from '@nestjs/common';
import { OPEN_INVOICE_STATUSES } from '@qarabic/shared';
import { Clock } from '../common/clock.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, fromDbDate, HOUR, localDate, toDbDate } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { BillingNotifier, type MailResult } from './notifier.js';

export type ReminderResult = Exclude<MailResult, 'disabled'> | 'already' | 'disabled';

export interface ReminderStats {
  /** `billing.notify_parents` is off: nothing was looked at or sent (D140). */
  disabled: boolean;
  checked: number;
  sent: number;
  already: number;
  unreachable: number;
  failed: number;
}

/** A reminder day missed by up to this many days is still sent; older ones are skipped. */
const CATCH_UP_DAYS = 2;

/**
 * Payment reminders (Laravel `InvoiceReminderService`, D88): for every open invoice, one email on
 * each day in `billing.reminder_days` relative to the due date (academy zone). Idempotent through a
 * claim row per invoice and slot (`invoice_reminders`). Off while `billing.notify_parents` is off.
 */
@Injectable()
export class InvoiceReminderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly notifier: BillingNotifier,
  ) {}

  async sendDue(): Promise<ReminderStats> {
    const stats: ReminderStats = {
      disabled: false,
      checked: 0,
      sent: 0,
      already: 0,
      unreachable: 0,
      failed: 0,
    };
    const st = await this.settings.all();
    if (!st['billing.notify_parents']) return { ...stats, disabled: true };
    const offsets = st['billing.reminder_days'].map(Number).filter(Number.isInteger);
    if (!offsets.length) return stats;
    const today = localDate(this.clock.nowMs(), st['academy.timezone']);

    const earliestDue = addDays(today, -(Math.max(...offsets) + CATCH_UP_DAYS));
    const latestDue = addDays(today, Math.max(0, -Math.min(...offsets)));
    const invoices = await this.prisma.invoice.findMany({
      where: {
        status: { in: [...OPEN_INVOICE_STATUSES] },
        dueDate: { gte: toDbDate(earliestDue), lte: toDbDate(latestDue) },
      },
      orderBy: { id: 'asc' },
      select: { id: true, dueDate: true },
    });
    const descending = [...offsets].sort((a, b) => b - a);
    for (const invoice of invoices) {
      stats.checked += 1;
      const due = fromDbDate(invoice.dueDate!);
      // The latest reminder day that has come (and is not too old): one email per run at most.
      const offset = descending.find((o) => {
        const day = addDays(due, o);
        return day <= today && day >= addDays(today, -CATCH_UP_DAYS);
      });
      if (offset === undefined) continue;
      const result = await this.deliver(invoice.id, `auto:${offset}`);
      if (result !== 'disabled') stats[result] += 1;
    }
    return stats;
  }

  /** The newest manual reminder of the invoice in the last hour (one per hour). */
  async lastManualWithinHour(invoiceId: number): Promise<boolean> {
    const row = await this.prisma.invoiceReminder.findFirst({
      where: {
        invoiceId,
        slot: { startsWith: 'manual:' },
        status: 'sent',
        createdAt: { gt: new Date(this.clock.nowMs() - HOUR) },
      },
      select: { id: true },
    });
    return row !== null;
  }

  /** Manual reminder from staff; the caller enforces one an hour. */
  async sendNow(invoiceId: number): Promise<ReminderResult> {
    if (!(await this.notifier.enabled())) return 'disabled';
    return this.deliver(invoiceId, `manual:${this.clock.nowMs()}`);
  }

  private async deliver(invoiceId: number, slot: string): Promise<ReminderResult> {
    if (!(await this.notifier.recipient(invoiceId))) return 'unreachable';
    let claimId: number;
    try {
      claimId = (
        await this.prisma.invoiceReminder.create({
          data: { invoiceId, slot, createdAt: this.clock.now() },
        })
      ).id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        return 'already';
      throw error;
    }
    const result = await this.notifier.deliver(invoiceId, 'reminder');
    if (result === 'sent') {
      await this.prisma.invoiceReminder.update({
        where: { id: claimId },
        data: { status: 'sent' },
      });
    } else {
      // Not sent: free the slot so the next run tries again.
      await this.prisma.invoiceReminder.delete({ where: { id: claimId } });
    }
    return result;
  }
}
