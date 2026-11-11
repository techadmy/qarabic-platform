import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OPEN_LEAD_STATUSES } from '@qarabic/shared';
import { CronJob } from 'cron';
import { Clock } from '../common/clock.js';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isoZ } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { LeadService } from './lead.service.js';
import { LeadNotifier, Outbox } from './notifier.js';
import { WorkingHours } from './working-hours.js';

/** Leads older than this are never SLA-alerted (no flood on the first deploy). */
const SLA_LOOKBACK_DAYS = 3;
const BATCH = 500;

/**
 * Scheduled lead alerts (docs/33 §3.2–3.3), port of Laravel `LeadAlertService` + `leads:notify`:
 * every 5 minutes in the API process (`SCHEDULER_ENABLED`), or `cli leads:notify`. Idempotent:
 * each alert is claimed with a conditional update before it is sent, so a re-run (or two
 * overlapping runs) never sends it twice.
 */
@Injectable()
export class LeadAlerts implements OnApplicationBootstrap {
  private readonly logger = new Logger(LeadAlerts.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly registry: SchedulerRegistry,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly leads: LeadService,
    private readonly notifier: LeadNotifier,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.SCHEDULER_ENABLED) return;
    const job = CronJob.from({
      cronTime: '0 */5 * * * *',
      onTick: () => {
        this.run().catch((error: unknown) =>
          this.logger.error('leads:notify failed', error as Error),
        );
      },
    });
    this.registry.addCronJob('leads:notify', job);
    job.start();
  }

  async run(): Promise<{ followUps: number; sla: number }> {
    return { followUps: await this.followUpsDue(), sla: await this.slaBreaches() };
  }

  /** One reminder per follow-up time to the owner; a new `next_follow_up_at` arms it again. */
  async followUpsDue(): Promise<number> {
    const now = this.clock.now();
    const due = await this.prisma.$queryRaw<
      Array<{ id: number; next_follow_up_at: Date }>
    >`SELECT id, next_follow_up_at FROM "leads"
       WHERE status::text = ANY(${[...OPEN_LEAD_STATUSES]})
         AND assigned_to IS NOT NULL
         AND next_follow_up_at IS NOT NULL AND next_follow_up_at <= ${now}
         AND (follow_up_notified_for IS NULL OR follow_up_notified_for <> next_follow_up_at)
       ORDER BY id LIMIT ${BATCH}`;
    let sent = 0;
    for (const row of due) {
      const claimed = await this.prisma.lead.updateMany({
        where: {
          id: row.id,
          nextFollowUpAt: row.next_follow_up_at,
          OR: [
            { followUpNotifiedFor: null },
            { followUpNotifiedFor: { not: row.next_follow_up_at } },
          ],
        },
        data: { followUpNotifiedFor: row.next_follow_up_at },
      });
      if (claimed.count !== 1) continue;
      const lead = await this.prisma.lead.findUniqueOrThrow({
        where: { id: row.id },
        include: { assignedTo: { select: { id: true, name: true, isActive: true } } },
      });
      if (!lead.assignedTo?.isActive) continue;
      sent +=
        (await this.notifier.deliver([
          {
            userId: lead.assignedTo.id,
            event: 'follow_up_due',
            leadId: lead.id,
            parentName: lead.parentName,
            dueAt: isoZ(row.next_follow_up_at),
            assignee: lead.assignedTo.name,
          },
        ])) > 0
          ? 1
          : 0;
    }
    return sent;
  }

  /** No contact within the first-response time (working minutes) → the owner and the `leads.assign` holders. */
  async slaBreaches(): Promise<number> {
    const now = this.clock.nowMs();
    const s = await this.settings.all();
    const candidates = await this.prisma.lead.findMany({
      where: {
        status: 'new',
        firstResponseAt: null,
        lastContactedAt: null,
        slaNotifiedAt: null,
        createdAt: { gte: new Date(now - SLA_LOOKBACK_DAYS * 86_400_000) },
      },
      include: { assignedTo: { select: { id: true, isActive: true } } },
      orderBy: { id: 'asc' },
      take: BATCH,
    });
    let sent = 0;
    for (const lead of candidates) {
      const due = WorkingHours.firstResponseDue(lead.createdAt.getTime(), s);
      if (due > now) continue;
      const claimed = await this.prisma.lead.updateMany({
        where: { id: lead.id, slaNotifiedAt: null, firstResponseAt: null },
        data: { slaNotifiedAt: new Date(now) },
      });
      if (claimed.count !== 1) continue;
      const outbox = new Outbox();
      await this.prisma.$transaction((tx) =>
        this.leads.notifyAssigners(
          tx,
          lead,
          'sla_breach',
          outbox,
          lead.assignedTo?.isActive ? lead.assignedTo.id : null,
          isoZ(due),
        ),
      );
      await this.leads.flush(outbox);
      sent++;
    }
    return sent;
  }
}
