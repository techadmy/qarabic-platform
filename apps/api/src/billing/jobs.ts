import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ENV, type Env } from '../config/env.js';
import { SettingsService } from '../settings/settings.service.js';
import { InvoiceReminderService, type ReminderStats } from './reminders.service.js';

/**
 * The billing job (Laravel `routes/console.php`): `billing:reminders` hourly at :20 in the academy
 * zone, only in the process that runs the cron (`SCHEDULER_ENABLED`). Idempotent per invoice and
 * reminder day; a no-op while `billing.notify_parents` is off (the default, D140). Monthly invoices
 * are not automatic (D84, B38): billing previews and issues them (`POST /invoice-runs`, or the CLI
 * `invoices:generate`).
 */
@Injectable()
export class BillingJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(BillingJobs.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly registry: SchedulerRegistry,
    private readonly settings: SettingsService,
    private readonly reminders: InvoiceReminderService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.SCHEDULER_ENABLED) return;
    const zone = await this.settings.get('academy.timezone');
    const job = CronJob.from({
      cronTime: '0 20 * * * *',
      timeZone: zone,
      onTick: () => {
        this.sendReminders().catch((error: unknown) =>
          this.logger.error('billing:reminders failed', error as Error),
        );
      },
    });
    this.registry.addCronJob('billing:reminders', job);
    job.start();
  }

  async sendReminders(): Promise<ReminderStats> {
    const stats = await this.reminders.sendDue();
    if (stats.sent || stats.failed) {
      this.logger.log(`Invoice reminders: ${stats.sent} sent, ${stats.failed} failed.`);
    }
    return stats;
  }
}
