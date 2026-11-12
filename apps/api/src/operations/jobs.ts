import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ENV, type Env } from '../config/env.js';
import { ClassReminderService } from './reminders.service.js';
import { TasksService } from './tasks.service.js';

/**
 * `operations:notify` every 5 minutes (only where `SCHEDULER_ENABLED`): task due-soon notices and
 * class reminders (the latter a no-op while `notifications.class_reminders` is off).
 */
@Injectable()
export class OperationsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(OperationsJobs.name);
  private running = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly registry: SchedulerRegistry,
    private readonly tasks: TasksService,
    private readonly reminders: ClassReminderService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.SCHEDULER_ENABLED) return;
    const job = CronJob.from({
      cronTime: '30 */5 * * * *',
      onTick: () => {
        this.tick().catch((error: unknown) =>
          this.logger.error('operations:notify failed', error as Error),
        );
      },
    });
    this.registry.addCronJob('operations:notify', job);
    job.start();
  }

  async tick(): Promise<{ dueSoon: number; reminders: number }> {
    if (this.running) return { dueSoon: 0, reminders: 0 };
    this.running = true;
    try {
      return { dueSoon: await this.tasks.notifyDueSoon(), reminders: await this.reminders.run() };
    } finally {
      this.running = false;
    }
  }
}
