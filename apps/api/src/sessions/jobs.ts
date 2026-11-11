import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OCCUPYING_STAGES } from '@qarabic/shared';
import { CronJob } from 'cron';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { ENV, type Env } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { type GenerateOptions, type GenerateResult, SessionGenerator } from './generator.js';
import { SessionRequestsService } from './requests.service.js';
import { ZoomMeetings } from './zoom.js';

export interface Overlap {
  by: 'teacher' | 'student';
  ownerId: number;
  sessionId: number;
  overlapsSessionId: number;
  startsAt: string;
}

/**
 * The class jobs (Laravel `routes/console.php`), shared by the in-process cron and the CLI:
 * - `sessions:generate` hourly at :05 (idempotent, self-healing; one run at a time);
 * - `session-requests:expire` hourly at :15;
 * - `zoom:ensure-upcoming` every 10 minutes (a no-op while `ZOOM_DRIVER=none`);
 * - `sessions:audit-overlaps` daily at 03:10 (safety net: should always find 0).
 * Times are in the academy zone (`academy.timezone`, Africa/Cairo). Only one API process may run
 * the cron (`SCHEDULER_ENABLED`); the generator also holds a database lock.
 */
@Injectable()
export class SessionJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(SessionJobs.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly registry: SchedulerRegistry,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly generator: SessionGenerator,
    private readonly requests: SessionRequestsService,
    private readonly zoom: ZoomMeetings,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.SCHEDULER_ENABLED) return;
    const zone = (await this.settings.all())['academy.timezone'];
    const jobs: Array<[string, string, () => Promise<unknown>]> = [
      ['sessions:generate', '0 5 * * * *', () => this.generate()],
      ['session-requests:expire', '0 15 * * * *', () => this.expireRequests()],
      ['zoom:ensure-upcoming', '0 */10 * * * *', () => this.ensureZoom()],
      ['sessions:audit-overlaps', '0 10 3 * * *', () => this.auditOverlaps()],
    ];
    for (const [name, expr, run] of jobs) {
      const job = CronJob.from({
        cronTime: expr,
        timeZone: zone,
        onTick: () => {
          run().catch((error: unknown) => this.logger.error(`${name} failed`, error as Error));
        },
      });
      this.registry.addCronJob(name, job);
      job.start();
    }
    this.logger.log(`Class jobs scheduled (${zone}).`);
  }

  /** One run at a time; a backfill (`from`) is written to the audit log. */
  async generate(options: GenerateOptions = {}): Promise<GenerateResult | null> {
    if (options.from && !options.dryRun) {
      await this.audit.record({
        actorId: null,
        action: 'sessions_backfill',
        subjectType: 'class_session',
        subjectId: null,
        after: { ...options },
      });
    }
    const result = await this.generator.withLock(() => this.generator.run(options));
    if (result === null) this.logger.warn('Another generator run holds the lock.');
    return result;
  }

  expireRequests(): Promise<number> {
    return this.requests.expireStarted();
  }

  async ensureZoom(): Promise<number> {
    return this.zoom.ensureUpcoming((await this.settings.all())['zoom.create_lead_hours']);
  }

  /** Overlapping occupying classes of one teacher or one student since `days` ago. */
  async auditOverlaps(days = 30): Promise<Overlap[]> {
    const from = new Date(this.clock.nowMs() - days * 86_400_000);
    const stages = Prisma.join([...OCCUPYING_STAGES].map((s) => Prisma.sql`${s}::"SessionStage"`));
    const out: Overlap[] = [];
    for (const column of ['teacher_id', 'student_id'] as const) {
      const col = Prisma.raw(column);
      const rows = await this.prisma.$queryRaw<
        Array<{ owner: number; a_id: number; b_id: number; starts_at: Date }>
      >`
        SELECT a.${col} AS owner, a.id AS a_id, b.id AS b_id, a.starts_at
        FROM "class_sessions" a
        JOIN "class_sessions" b
          ON a.${col} = b.${col} AND a.id < b.id
         AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at
        WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
          AND a.stage IN (${stages}) AND b.stage IN (${stages})
          AND a.starts_at >= ${from}
        ORDER BY a.starts_at, a.id`;
      for (const r of rows) {
        out.push({
          by: column === 'teacher_id' ? 'teacher' : 'student',
          ownerId: r.owner,
          sessionId: r.a_id,
          overlapsSessionId: r.b_id,
          startsAt: r.starts_at.toISOString(),
        });
      }
    }
    if (out.length) this.logger.error(`${out.length} overlapping class pair(s) found.`);
    return out;
  }
}
