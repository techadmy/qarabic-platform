import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  OCCUPYING_STAGES,
  TRIAL_LEVEL_LABELS,
  TRIAL_NOTIFICATION_LABELS,
  type TrialCheckAlert,
  type TrialChecklistItemDto,
  type TrialReportDto,
  type trialReportInputSchema,
  type trialsTodayQuerySchema,
} from '@qarabic/shared';
import { CronJob } from 'cron';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { ENV, type Env } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { NotificationCentre } from '../operations/notification-centre.js';
import { TasksService } from '../operations/tasks.service.js';
import type { Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { zoneOr } from '../schedule/conflicts.js';
import { addDays, local, startOfLocalDay } from '../schedule/time.js';
import { LessonReportsService } from '../sessions/lesson-reports.js';
import { Actor } from '../sessions/state-machine.js';
import { SettingsService } from '../settings/settings.service.js';
import { crmError } from './errors.js';
import { LeadService } from './lead.service.js';
import { LeadNotifier, usersWithPermission } from './notifier.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (d: Date) => d.toISOString();
const occupying = { in: [...OCCUPYING_STAGES] } as Prisma.EnumSessionStageFilter;
const name = (t: { firstName: string; lastName: string | null }) =>
  [t.firstName, t.lastName].filter(Boolean).join(' ');

const reportInclude = {
  recommendedCourse: { select: { id: true, nameAr: true, nameEn: true } },
} satisfies Prisma.TrialReportInclude;
type ReportRow = Prisma.TrialReportGetPayload<{ include: typeof reportInclude }>;

/**
 * Trial follow-up (T4, docs/33 §3.5–3.7, B85, B86):
 * - reminders 24 h and 1 h before a trial to the teacher (and the family only with
 *   `crm.trial_family_reminders`, off by D140);
 * - the monitors' late alert and the checklist of today's trials;
 * - the teacher's trial report, required to close the trial class (B85): it moves the lead to
 *   «تمت الحصة التجريبية», tells the CSR and opens their follow-up task (due in 24 h);
 * - the stale rule: a trial done but not converted → the owner is reminded after N days, and «مفقود»
 *   is suggested after M days (B86: 3 and 14).
 * Every alert is claimed before it is sent, so re-runs never repeat it.
 */
@Injectable()
export class TrialFollowUp implements OnApplicationBootstrap {
  private readonly logger = new Logger(TrialFollowUp.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly registry: SchedulerRegistry,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly centre: NotificationCentre,
    private readonly notifier: LeadNotifier,
    private readonly leads: LeadService,
    private readonly lessonReports: LessonReportsService,
    private readonly tasks: TasksService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.SCHEDULER_ENABLED) return;
    const job = CronJob.from({
      cronTime: '30 * * * * *',
      onTick: () => {
        this.run().catch((error: unknown) =>
          this.logger.error('trials:follow-up failed', error as Error),
        );
      },
    });
    this.registry.addCronJob('trials:follow-up', job);
    job.start();
  }

  async run(): Promise<{ reminders: number; late: number; stale: number }> {
    return {
      reminders: await this.reminders(),
      late: await this.lateAlerts(),
      stale: await this.staleRules(),
    };
  }

  // ---------------------------------------------------------------- reminders

  async reminders(): Promise<number> {
    const st = await this.settings.all();
    if (!st['crm.trial_reminders_enabled']) return 0;
    const now = this.clock.nowMs();
    const sessions = await this.prisma.classSession.findMany({
      where: {
        kind: 'trial',
        stage: 'scheduled',
        deletedAt: null,
        startsAt: { gt: new Date(now), lte: new Date(now + DAY) },
      },
      select: {
        id: true,
        startsAt: true,
        durationMinutes: true,
        course: { select: { nameAr: true, nameEn: true } },
        teacher: { select: { userId: true, timezone: true } },
        student: { select: { name: true, family: { select: { userId: true, timezone: true } } } },
      },
      take: 1000,
    });
    let sent = 0;
    for (const s of sessions) {
      // A trial booked less than an hour ahead gets only the 1-hour reminder.
      const kind = s.startsAt.getTime() - now <= HOUR ? 'before_1h' : 'before_24h';
      const family = st['crm.trial_family_reminders'] ? [s.student.family.userId] : [];
      const claimed = await this.prisma.trialReminder.createManyAndReturn({
        data: [s.teacher.userId, ...family].map((userId) => ({
          sessionId: s.id,
          userId,
          kind,
          sentAt: new Date(now),
        })),
        skipDuplicates: true,
        select: { userId: true },
      });
      const ids = new Set(claimed.map((c) => c.userId));
      const label = TRIAL_NOTIFICATION_LABELS.trial_reminder;
      if (ids.has(s.teacher.userId)) {
        const zone = zoneOr(s.teacher.timezone, st['academy.timezone']);
        const at = local(s.startsAt.getTime(), zone);
        sent += await this.centre.send({
          userIds: [s.teacher.userId],
          kind: 'trial',
          event: 'trial_reminder',
          data: {
            sessionId: s.id,
            startsAt: iso(s.startsAt),
            teacherLocal: `${at.date} ${at.time}`,
            window: kind,
            course: s.course?.nameAr ?? null,
          },
          email: {
            subject: `${label.ar} — ${label.en}`,
            text:
              `${label.ar}: ${s.course?.nameAr ?? ''} — ${at.date} ${at.time} (${zone})\n` +
              `${label.en}: ${s.course?.nameEn ?? ''} — ${at.date} ${at.time} (${zone})`,
          },
        });
      }
      for (const userId of family) {
        if (!ids.has(userId)) continue;
        const zone = zoneOr(s.student.family.timezone, st['academy.timezone']);
        const at = local(s.startsAt.getTime(), zone);
        sent += await this.centre.send({
          userIds: [userId],
          kind: 'class_reminder',
          event: 'trial_upcoming',
          data: { sessionId: s.id, startsAt: iso(s.startsAt), student: s.student.name },
          email: {
            subject: 'تذكير بالحصة التجريبية — Trial class reminder',
            text:
              `حصة ${s.student.name} التجريبية: ${at.date} ${at.time} (${zone})\n` +
              `${s.student.name}'s trial class: ${at.date} ${at.time} (${zone})`,
          },
        });
      }
    }
    return sent;
  }

  // ---------------------------------------------------------------- monitors

  /** A trial not started N minutes in: one alert per monitor (staff with `sessions.manage`). */
  async lateAlerts(): Promise<number> {
    const st = await this.settings.all();
    const now = this.clock.nowMs();
    const late = st['crm.trial_late_alert_minutes'] * 60_000;
    const sessions = await this.prisma.classSession.findMany({
      where: {
        kind: 'trial',
        stage: { in: ['scheduled', 'activated'] },
        startedAt: null,
        deletedAt: null,
        startsAt: { lte: new Date(now - late), gte: new Date(now - 3 * HOUR) },
      },
      select: {
        id: true,
        startsAt: true,
        teacher: { select: { firstName: true, lastName: true } },
        student: { select: { name: true } },
      },
    });
    if (sessions.length === 0) return 0;
    const monitors = (await usersWithPermission(this.prisma, 'sessions.manage')).filter(
      (u) => u.role?.name !== 'admin',
    );
    let sent = 0;
    for (const s of sessions) {
      const claimed = await this.prisma.trialReminder.createManyAndReturn({
        data: monitors.map((m) => ({
          sessionId: s.id,
          userId: m.id,
          kind: 'late_alert' as const,
          sentAt: new Date(now),
        })),
        skipDuplicates: true,
        select: { userId: true },
      });
      if (claimed.length === 0) continue;
      const label = TRIAL_NOTIFICATION_LABELS.trial_late;
      const minutes = Math.floor((now - s.startsAt.getTime()) / 60_000);
      sent += await this.centre.send({
        userIds: claimed.map((c) => c.userId),
        kind: 'trial',
        event: 'trial_late',
        data: {
          sessionId: s.id,
          startsAt: iso(s.startsAt),
          teacher: name(s.teacher),
          student: s.student.name,
          lateMinutes: minutes,
        },
        email: {
          subject: `${label.ar} — ${label.en}`,
          text: `${label.ar}: ${name(s.teacher)} — ${s.student.name} (${minutes} min)`,
        },
      });
    }
    return sent;
  }

  /** `GET /trials/today`: today's trial classes with the checklist (academy day by default). */
  async today(
    q: z.output<typeof trialsTodayQuerySchema>,
  ): Promise<{ data: TrialChecklistItemDto[]; meta: { date: string; timezone: string } }> {
    const st = await this.settings.all();
    const zone = q.tz ?? st['academy.timezone'];
    const now = this.clock.nowMs();
    const date = q.date ?? local(now, zone).date;
    const late = st['crm.trial_late_alert_minutes'];
    const rows = await this.prisma.classSession.findMany({
      where: {
        kind: 'trial',
        deletedAt: null,
        stage: occupying,
        startsAt: {
          gte: new Date(startOfLocalDay(date, zone)),
          lt: new Date(startOfLocalDay(addDays(date, 1), zone)),
        },
      },
      include: {
        teacher: { select: { id: true, firstName: true, lastName: true } },
        student: { select: { id: true, name: true, familyId: true } },
        course: { select: { id: true, nameAr: true, nameEn: true } },
        trialReport: { select: { id: true } },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    const leads = await this.prisma.lead.findMany({
      where: { familyId: { in: [...new Set(rows.map((r) => r.student.familyId))] } },
      select: { id: true, familyId: true },
      orderBy: { id: 'desc' },
    });
    const data = rows.map((r) => {
      const start = r.startsAt.getTime();
      const startedLate = r.startedAt ? (r.startedAt.getTime() - start) / 60_000 : null;
      const waiting = !r.startedAt && ['scheduled', 'activated'].includes(r.stage);
      const lateMinutes =
        startedLate !== null && startedLate > late
          ? Math.floor(startedLate)
          : waiting && now - start > late * 60_000
            ? Math.floor((now - start) / 60_000)
            : null;
      const alerts: TrialCheckAlert[] = [];
      if (waiting && lateMinutes !== null) alerts.push('not_started');
      if (startedLate !== null && startedLate > late) alerts.push('started_late');
      if (!r.trialReport && (r.stage === 'ended' || r.stage === 'taken')) alerts.push('no_report');
      const at = local(start, zone);
      return {
        sessionId: r.id,
        leadId: leads.find((l) => l.familyId === r.student.familyId)?.id ?? null,
        startsAt: iso(r.startsAt),
        durationMinutes: r.durationMinutes,
        stage: r.stage,
        local: { date: at.date, time: at.time },
        student: { id: r.student.id, name: r.student.name },
        teacher: { id: r.teacher.id, name: name(r.teacher) },
        course: r.course,
        teacherStarted: r.startedAt !== null,
        lateMinutes,
        studentJoined: r.studentJoinedAt ? true : r.zoomStatus === 'external' ? null : false,
        reportSubmitted: r.trialReport !== null,
        alerts,
      };
    });
    return { data, meta: { date, timezone: zone } };
  }

  // ---------------------------------------------------------------- the trial report

  /** The class with the viewer's scope: its teacher, or staff with `sessions.manage`; else 404. */
  private async session(id: number, viewer: AuthUser) {
    const s = await this.prisma.classSession.findFirst({
      where: { id, deletedAt: null },
      include: {
        student: { select: { id: true, familyId: true } },
        trialReport: { include: reportInclude },
      },
    });
    const actor = await Actor.of(this.prisma, viewer);
    if (!s || !actor.canConduct(s)) throw notFound();
    return { s, actor };
  }

  async showReport(id: number, viewer: AuthUser): Promise<TrialReportDto | null> {
    const { s } = await this.session(id, viewer);
    return s.trialReport ? await this.reportDto(s.trialReport) : null;
  }

  async listForLead(leadId: number): Promise<TrialReportDto[]> {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw notFound();
    const rows = await this.prisma.trialReport.findMany({
      where: {
        OR: [
          { leadId },
          ...(lead.familyId ? [{ session: { student: { familyId: lead.familyId } } }] : []),
        ],
      },
      include: reportInclude,
      orderBy: { submittedAt: 'desc' },
    });
    return Promise.all(rows.map((r) => this.reportDto(r)));
  }

  /**
   * Writes the trial report. On an `ended` trial it closes the class (`taken`, through the lesson
   * report with a short summary) and, the first time, moves the lead, tells the CSR and opens the
   * follow-up task. On a `taken` trial it edits the report: the teacher inside
   * `sessions.report_edit_hours`, staff at any time.
   */
  async submitReport(
    id: number,
    input: z.output<typeof trialReportInputSchema>,
    viewer: AuthUser,
  ): Promise<void> {
    const { s, actor } = await this.session(id, viewer);
    if (s.kind !== 'trial') {
      throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'not_a_trial');
    }
    const st = await this.settings.all();
    const now = this.clock.now();
    if (s.stage === 'taken' && s.trialReport) {
      const until = s.trialReport.submittedAt.getTime() + st['sessions.report_edit_hours'] * HOUR;
      if (!actor.canManage() && now.getTime() > until) {
        throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'trial_report_locked', {
          data: { availableUntil: new Date(until).toISOString() },
        });
      }
    } else if (s.stage === 'ended') {
      const recommended = input.recommendedCourseId
        ? await this.prisma.course.findUnique({ where: { id: input.recommendedCourseId } })
        : null;
      await this.lessonReports.submit(
        id,
        {
          summary: [
            `حصة تجريبية — المستوى: ${TRIAL_LEVEL_LABELS[input.level].ar}`,
            recommended
              ? `المقترح: ${recommended.nameAr}، ${input.classesPerWeek} × ${input.minutesPerClass} دقيقة أسبوعيًا`
              : `المقترح: ${input.classesPerWeek} × ${input.minutesPerClass} دقيقة أسبوعيًا`,
          ].join('\n'),
        },
        viewer,
        { trialReport: true },
      );
    } else if (s.stage !== 'taken') {
      throw crmError(HttpStatus.CONFLICT, 'trial_not_ended', { data: { stage: s.stage } });
    }
    if (input.recommendedCourseId) {
      const course = await this.prisma.course.findUnique({
        where: { id: input.recommendedCourseId },
      });
      if (!course) {
        throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'invalid_course', {
          errors: { recommendedCourseId: ['The selected course is invalid.'] },
        });
      }
    }

    const first = !s.trialReport;
    const lead = await this.prisma.lead.findFirst({
      where: { familyId: s.student.familyId },
      orderBy: { id: 'desc' },
    });
    const values = {
      attendance: input.attendance,
      level: input.level,
      recommendedCourseId: input.recommendedCourseId ?? null,
      classesPerWeek: input.classesPerWeek,
      minutesPerClass: input.minutesPerClass,
      engagement: input.engagement,
      notes: input.notes ?? null,
      updatedAt: now,
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.trialReport.upsert({
        where: { sessionId: id },
        create: {
          sessionId: id,
          leadId: lead?.id ?? null,
          ...values,
          submittedById: viewer.id,
          submittedAt: now,
        },
        update: values,
      });
      await this.audit.record(
        {
          actorId: viewer.id,
          action: first ? 'trial_report_submitted' : 'trial_report_updated',
          subjectType: 'session',
          subjectId: id,
          after: values,
        },
        tx,
      );
      if (first && lead) await this.leadAfterReport(tx, lead.id, id, values, viewer.id);
    });
    if (first && lead) await this.tellCsr(lead.id, id, values, viewer);
  }

  /** The lead moves to «تمت الحصة التجريبية» with the report on its timeline. */
  private async leadAfterReport(
    tx: Tx,
    leadId: number,
    sessionId: number,
    values: {
      level: string;
      classesPerWeek: number;
      minutesPerClass: number;
      notes: string | null;
    },
    by: number,
  ): Promise<void> {
    const row = await this.leads.lockRow(tx, leadId);
    await this.leads.log(
      tx,
      leadId,
      'note',
      values.notes,
      {
        trialReport: {
          sessionId,
          level: values.level,
          classesPerWeek: values.classesPerWeek,
          minutesPerClass: values.minutesPerClass,
        },
      },
      by,
    );
    if (row.status === 'trial_scheduled') {
      await this.leads.save(tx, leadId, { staleRemindedAt: null, staleLostSuggestedAt: null });
      await this.leads.moveTo(tx, row, 'trial_done', by, { trialReport: sessionId });
    }
  }

  /** The owner (else the lead admins) is told and gets a follow-up task due in 24 h. */
  private async tellCsr(
    leadId: number,
    sessionId: number,
    values: {
      level: 'beginner' | 'intermediate' | 'advanced';
      classesPerWeek: number;
      minutesPerClass: number;
      recommendedCourseId: number | null;
      notes: string | null;
    },
    teacher: AuthUser,
  ): Promise<void> {
    const lead = await this.prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    if (!lead.assignedToId) return;
    await this.notifier.deliver([
      {
        userId: lead.assignedToId,
        event: 'trial_report',
        leadId,
        parentName: lead.parentName,
      },
    ]);
    const course = values.recommendedCourseId
      ? await this.prisma.course.findUnique({ where: { id: values.recommendedCourseId } })
      : null;
    try {
      await this.tasks.create(
        {
          title: `متابعة بعد الحصة التجريبية — ${lead.parentName}`.slice(0, 200),
          description: [
            `تقرير المعلم: المستوى ${TRIAL_LEVEL_LABELS[values.level].ar}`,
            `المقترح: ${course ? `${course.nameAr}، ` : ''}${values.classesPerWeek} × ${values.minutesPerClass} دقيقة أسبوعيًا`,
            values.notes ? `ملاحظات المعلم: ${values.notes}` : null,
            `الحصة: ${sessionId}`,
          ]
            .filter(Boolean)
            .join('\n'),
          assigneeId: lead.assignedToId,
          priority: 'high',
          dueAt: new Date(this.clock.nowMs() + DAY).toISOString(),
          subjectType: 'lead',
          subjectId: leadId,
        },
        teacher,
      );
    } catch (error) {
      // The report is saved; a task the owner cannot receive (left the academy …) is logged only.
      this.logger.warn(`Trial follow-up task not created: ${(error as Error).message}`);
    }
  }

  private async reportDto(r: ReportRow): Promise<TrialReportDto> {
    const by = r.submittedById
      ? await this.prisma.user.findUnique({
          where: { id: r.submittedById },
          select: { id: true, name: true },
        })
      : null;
    return {
      sessionId: r.sessionId,
      leadId: r.leadId,
      attendance: r.attendance,
      level: r.level,
      recommendedCourse: r.recommendedCourse,
      classesPerWeek: r.classesPerWeek,
      minutesPerClass: r.minutesPerClass,
      engagement: r.engagement,
      notes: r.notes,
      submittedBy: by,
      submittedAt: iso(r.submittedAt),
      updatedAt: iso(r.updatedAt),
    };
  }

  // ---------------------------------------------------------------- stale rule

  /** B86: trial done, not converted → remind the owner after N days; suggest «مفقود» after M. */
  async staleRules(): Promise<number> {
    const st = await this.settings.all();
    const now = this.clock.nowMs();
    let sent = 0;
    for (const step of [
      {
        days: st['crm.trial_stale_lost_days'],
        field: 'staleLostSuggestedAt' as const,
        event: 'trial_stale_lost' as const,
      },
      {
        days: st['crm.trial_stale_remind_days'],
        field: 'staleRemindedAt' as const,
        event: 'trial_stale' as const,
      },
    ]) {
      const due = await this.prisma.lead.findMany({
        where: {
          status: 'trial_done',
          [step.field]: null,
          statusChangedAt: { lte: new Date(now - step.days * DAY) },
        },
        select: { id: true, parentName: true, assignedToId: true },
        take: 500,
      });
      for (const lead of due) {
        const claimed = await this.prisma.lead.updateMany({
          where: { id: lead.id, status: 'trial_done', [step.field]: null },
          data: {
            [step.field]: new Date(now),
            // The late step makes the early one moot.
            ...(step.field === 'staleLostSuggestedAt' ? { staleRemindedAt: new Date(now) } : {}),
          },
        });
        if (claimed.count === 0 || !lead.assignedToId) continue;
        sent += await this.notifier.deliver([
          {
            userId: lead.assignedToId,
            event: step.event,
            leadId: lead.id,
            parentName: lead.parentName,
          },
        ]);
      }
    }
    return sent;
  }
}
