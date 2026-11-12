import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ENV, type Env } from '../config/env.js';
import { SettingsService } from '../settings/settings.service.js';
import { OutboxService } from './outbox.service.js';

/**
 * `ledger:post` every 5 minutes (only in the process that runs the cron, `SCHEDULER_ENABLED`):
 * turns new billing and payroll outbox events into journal entries. Off when
 * `accounting.auto_post` is false (the CLI and `POST /accounting/outbox/process` still work).
 */
@Injectable()
export class AccountingJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(AccountingJobs.name);
  private running = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly registry: SchedulerRegistry,
    private readonly settings: SettingsService,
    private readonly outbox: OutboxService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.SCHEDULER_ENABLED) return;
    const job = CronJob.from({
      cronTime: '0 */5 * * * *',
      onTick: () => {
        this.tick().catch((error: unknown) =>
          this.logger.error('ledger:post failed', error as Error),
        );
      },
    });
    this.registry.addCronJob('ledger:post', job);
    job.start();
  }

  async tick(): Promise<void> {
    if (this.running || !(await this.settings.get('accounting.auto_post'))) return;
    this.running = true;
    try {
      const r = await this.outbox.process();
      if (r.posted || r.failed) {
        this.logger.log(`Ledger: ${r.posted} posted, ${r.skipped} skipped, ${r.failed} failed.`);
      }
    } finally {
      this.running = false;
    }
  }
}
