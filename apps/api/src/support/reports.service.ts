import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  CLOSED_TICKET_STATUSES,
  TICKET_CATEGORIES,
  TICKET_CHANNELS,
  TICKET_QUEUE_LABELS,
  TICKET_QUEUES,
  type SupportReportDto,
  type SupportReportRowDto,
  type TicketQueue,
} from '@qarabic/shared';
import { CronJob } from 'cron';
import { Clock } from '../common/clock.js';
import { ApiException } from '../common/errors.js';
import { ENV, type Env } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { NotificationCentre } from '../operations/notification-centre.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, isoWeekday, local, toUtc } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { SupportContext, SupportPolicy, type SupportViewer } from './policy.js';

const DAY = 86_400_000;
const CLOSED = new Set<string>(CLOSED_TICKET_STATUSES);

const rate = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  pct: denominator ? Math.round((numerator / denominator) * 1000) / 10 : null,
});
function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

type Row = {
  id: number;
  queue: TicketQueue;
  category: (typeof TICKET_CATEGORIES)[number];
  channel: (typeof TICKET_CHANNELS)[number];
  status: string;
  createdAt: Date;
  firstResponseAt: Date | null;
  slaDueAt: Date | null;
  closedAt: Date | null;
};

/**
 * S4 (docs/32 §5, §8): the SLA breach alert and the support report.
 * - `support:sla` (every 5 minutes, or `cli support:sla`): an open ticket with no first answer past
 *   its deadline is flagged once (`sla_breach_notified_at`) and its assignee and the support
 *   managers (`support.manage`, never the owner role; for a restricted queue only those who may
 *   see it) get a notice — the inbox already sorts breached first.
 * - `GET /support/reports`: volume, first response, SLA met and time to resolve, by queue,
 *   category, channel and week, inside the viewer's queues.
 */
@Injectable()
export class SupportReports implements OnApplicationBootstrap {
  private readonly logger = new Logger(SupportReports.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly registry: SchedulerRegistry,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly context: SupportContext,
    private readonly centre: NotificationCentre,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.SCHEDULER_ENABLED) return;
    const job = CronJob.from({
      cronTime: '0 */5 * * * *',
      onTick: () => {
        this.slaBreaches().catch((error: unknown) =>
          this.logger.error('support:sla failed', error as Error),
        );
      },
    });
    this.registry.addCronJob('support:sla', job);
    job.start();
  }

  // ---------------------------------------------------------------- breach alerts

  async slaBreaches(): Promise<number> {
    const now = this.clock.now();
    const due = await this.prisma.ticket.findMany({
      where: {
        slaDueAt: { lte: now },
        firstResponseAt: null,
        slaBreachNotifiedAt: null,
        status: { notIn: [...CLOSED_TICKET_STATUSES] },
        // No flood on the first deploy: only deadlines of the last 3 days.
        AND: [{ slaDueAt: { gte: new Date(now.getTime() - 3 * DAY) } }],
      },
      select: {
        id: true,
        queue: true,
        visibility: true,
        teacherId: true,
        reporterId: true,
        assigneeId: true,
        slaDueAt: true,
      },
      take: 500,
    });
    if (due.length === 0) return 0;
    const cfg = await this.context.config();
    const managers = await this.prisma.user.findMany({
      where: {
        isActive: true,
        archivedAt: null,
        role: {
          kind: { not: 'owner' },
          permissions: { some: { permission: { name: 'support.manage' } } },
        },
      },
      select: { id: true },
    });
    let sent = 0;
    for (const t of due) {
      const claimed = await this.prisma.ticket.updateMany({
        where: { id: t.id, slaBreachNotifiedAt: null, firstResponseAt: null },
        data: { slaBreachNotifiedAt: now },
      });
      if (claimed.count === 0) continue;
      const candidates = [...new Set([...managers.map((m) => m.id), t.assigneeId])].filter(
        (id): id is number => id !== null,
      );
      // Restricted tickets (complaints): only people who may see them, never the teacher concerned.
      const recipients: number[] = [];
      for (const id of candidates) {
        const user = await this.context.loadUser(id);
        if (!user?.isActive) continue;
        const v: SupportViewer = await this.context.viewer(user, cfg);
        if (SupportPolicy.canView(v, t)) recipients.push(id);
      }
      if (recipients.length === 0) continue;
      const queue = TICKET_QUEUE_LABELS[t.queue];
      sent += await this.centre.send({
        userIds: recipients,
        kind: 'support',
        event: 'sla_breach',
        data: { ticketId: t.id, number: `#${t.id}`, queue: t.queue, dueAt: t.slaDueAt },
        email: {
          subject: `تأخر الرد على الطلب #${t.id} — Request #${t.id} overdue`,
          text:
            `تجاوز الطلب #${t.id} (${queue.ar}) موعد أول رد.\n` +
            `Request #${t.id} (${queue.en}) passed its first-response deadline.`,
        },
      });
    }
    return sent;
  }

  // ---------------------------------------------------------------- the report

  async report(
    from: string | undefined,
    to: string | undefined,
    v: SupportViewer,
  ): Promise<SupportReportDto> {
    const st = await this.settings.all();
    const zone = st['academy.timezone'];
    const today = local(this.clock.nowMs(), zone).date;
    const start = from ?? `${today.slice(0, 8)}01`;
    const end = to ?? today;
    if ((Date.parse(end) - Date.parse(start)) / DAY > 366) {
      throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
        message: 'Choose a period of at most one year.',
        code: 'range_too_long',
        errors: { to: ['Choose a period of at most one year.'] },
      });
    }
    const where: Prisma.TicketWhereInput = {
      AND: [
        SupportPolicy.staffWhere(v),
        {
          createdAt: {
            gte: new Date(toUtc(start, '00:00', zone)),
            lt: new Date(toUtc(addDays(end, 1), '00:00', zone)),
          },
        },
      ],
    };
    const rows: Row[] = await this.prisma.ticket.findMany({
      where,
      select: {
        id: true,
        queue: true,
        category: true,
        channel: true,
        status: true,
        createdAt: true,
        firstResponseAt: true,
        slaDueAt: true,
        closedAt: true,
      },
    });
    const row = (group: Row[]): SupportReportRowDto => {
      const answered = group.filter((t) => t.firstResponseAt);
      // Decided: answered, or the deadline has passed without an answer.
      const withSla = group.filter(
        (t) => t.slaDueAt && (t.firstResponseAt || t.slaDueAt.getTime() <= this.clock.nowMs()),
      );
      const met = withSla.filter(
        (t) => t.firstResponseAt && t.firstResponseAt.getTime() <= t.slaDueAt!.getTime(),
      );
      const closed = group.filter((t) => CLOSED.has(t.status) && t.closedAt);
      const first = median(
        answered.map((t) => (t.firstResponseAt!.getTime() - t.createdAt.getTime()) / 60_000),
      );
      const resolve = median(
        closed.map((t) => (t.closedAt!.getTime() - t.createdAt.getTime()) / 3_600_000),
      );
      return {
        created: group.length,
        open: group.filter((t) => !CLOSED.has(t.status)).length,
        closed: closed.length,
        firstResponseMedianMinutes: first === null ? null : Math.round(first),
        slaMet: rate(met.length, withSla.length),
        resolveMedianHours: resolve === null ? null : Math.round(resolve * 10) / 10,
      };
    };
    const by = <K extends string>(keys: readonly K[], key: (t: Row) => K) =>
      keys
        .map((k) => [k, rows.filter((t) => key(t) === k)] as const)
        .filter(([, g]) => g.length > 0);
    const weeks = new Map<string, { created: number; closed: number }>();
    const weekOf = (ms: number) => {
      const d = local(ms, zone).date;
      return addDays(d, 1 - isoWeekday(d));
    };
    for (const t of rows) {
      const w = weekOf(t.createdAt.getTime());
      const e = weeks.get(w) ?? { created: 0, closed: 0 };
      e.created++;
      weeks.set(w, e);
      if (t.closedAt && CLOSED.has(t.status)) {
        const cw = weekOf(t.closedAt.getTime());
        const c = weeks.get(cw) ?? { created: 0, closed: 0 };
        c.closed++;
        weeks.set(cw, c);
      }
    }
    return {
      from: start,
      to: end,
      total: row(rows),
      byQueue: by(TICKET_QUEUES, (t) => t.queue).map(([queue, g]) => ({ queue, ...row(g) })),
      byCategory: by(TICKET_CATEGORIES, (t) => t.category).map(([category, g]) => ({
        category,
        ...row(g),
      })),
      byChannel: by(TICKET_CHANNELS, (t) => t.channel).map(([channel, g]) => ({
        channel,
        ...row(g),
      })),
      byWeek: [...weeks]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([weekStart, c]) => ({ weekStart, ...c })),
    };
  }
}
