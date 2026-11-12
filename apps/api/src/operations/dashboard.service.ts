import { Injectable } from '@nestjs/common';
import {
  type DashboardSummaryDto,
  OPEN_INVOICE_STATUSES,
  OPEN_TASK_STATUSES,
  OPEN_TICKET_STATUSES,
} from '@qarabic/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { cents, fromCents } from '../payroll/money.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, localDate, startOfLocalDay, toDbDate } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { AnnouncementsService } from './announcements.service.js';

/**
 * The dashboard numbers (M18; docs/15 K1/K3): people, today's classes by stage, the queues waiting
 * for the viewer and the money figures. Each block or number is present only when the viewer holds
 * the permission of the list it counts (else `null`): the dashboard never shows more than the
 * screens behind it.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly announcements: AnnouncementsService,
  ) {}

  async summary(viewer: AuthUser): Promise<DashboardSummaryDto> {
    const can = (p: string) => viewer.permissions.has(p);
    const zone = await this.settings.get('academy.timezone');
    const nowMs = this.clock.nowMs();
    const today = localDate(nowMs, zone);
    const dayStart = new Date(startOfLocalDay(today, zone));
    const dayEnd = new Date(startOfLocalDay(addDays(today, 1), zone));
    const monthStart = `${today.slice(0, 7)}-01`;
    const monthFrom = new Date(startOfLocalDay(monthStart, zone));
    const now = new Date(nowMs);
    const when = <T>(ok: boolean, run: () => Promise<T>): Promise<T | null> =>
      ok ? run() : Promise.resolve(null);

    const [
      people,
      stages,
      myTasks,
      myOverdue,
      sessionRequests,
      leaveRequests,
      proposedFines,
      newLeads,
      trialsToday,
      openTickets,
      openComplaints,
      unreadAnnouncements,
      finance,
    ] = await Promise.all([
      when(can('families.view') || can('staff.view'), async () => {
        const [families, students, teachers] = await Promise.all([
          this.prisma.family.count({
            where: { archivedAt: null, status: { in: ['regular', 'trial'] } },
          }),
          this.prisma.student.count({
            where: {
              archivedAt: null,
              status: 'active',
              family: { archivedAt: null, status: { in: ['regular', 'trial'] } },
            },
          }),
          this.prisma.teacher.count({ where: { archivedAt: null, status: 'active' } }),
        ]);
        return { families, students, teachers };
      }),
      when(can('sessions.view') && !viewer.teacherId && viewer.role?.kind !== 'parent', () =>
        this.prisma.classSession.groupBy({
          by: ['stage'],
          where: { startsAt: { gte: dayStart, lt: dayEnd } },
          _count: { _all: true },
        }),
      ),
      when(can('tasks.view'), () =>
        this.prisma.task.count({
          where: { assigneeId: viewer.id, status: { in: [...OPEN_TASK_STATUSES] } },
        }),
      ),
      when(can('tasks.view'), () =>
        this.prisma.task.count({
          where: {
            assigneeId: viewer.id,
            status: { in: [...OPEN_TASK_STATUSES] },
            dueAt: { lt: now },
          },
        }),
      ),
      when(can('session_requests.approve') || can('session_requests.manage'), () =>
        this.prisma.sessionRequest.count({ where: { status: 'pending' } }),
      ),
      when(can('attendance.manage'), () =>
        this.prisma.leaveRequest.count({ where: { status: 'pending' } }),
      ),
      when(can('fines.approve'), () =>
        this.prisma.payAdjustment.count({ where: { type: 'fine', status: 'proposed' } }),
      ),
      when(can('leads.view'), () => this.prisma.lead.count({ where: { status: 'new' } })),
      when(can('leads.view'), () =>
        this.prisma.classSession.count({
          where: {
            kind: 'trial',
            startsAt: { gte: dayStart, lt: dayEnd },
            stage: { not: 'moved_out' },
          },
        }),
      ),
      when(can('support.view'), () =>
        this.prisma.ticket.count({
          where: { status: { in: [...OPEN_TICKET_STATUSES] }, visibility: 'normal' },
        }),
      ),
      when(can('support.view_restricted'), () =>
        this.prisma.ticket.count({
          where: { status: { in: [...OPEN_TICKET_STATUSES] }, queue: 'complaints' },
        }),
      ),
      when(can('announcements.view'), () => this.announcements.unreadCount(viewer)),
      when(can('reports.financial'), () => this.finance(today, monthFrom, can('accounting.view'))),
    ]);

    return {
      generatedAt: now.toISOString(),
      today,
      people,
      classesToday: stages ? Object.fromEntries(stages.map((s) => [s.stage, s._count._all])) : null,
      queues: {
        myTasks,
        myOverdueTasks: myOverdue,
        sessionRequests,
        leaveRequests,
        proposedFines,
        newLeads,
        trialsToday,
        openTickets,
        openComplaints,
        unreadAnnouncements,
      },
      finance,
    };
  }

  private async finance(today: string, monthFrom: Date, ledger: boolean) {
    const [overdue, received, payroll, billingPending, payrollPending] = await Promise.all([
      this.prisma.invoice.groupBy({
        by: ['currency'],
        where: { status: { in: [...OPEN_INVOICE_STATUSES] }, dueDate: { lt: toDbDate(today) } },
        _sum: { total: true, paid: true },
        _count: { _all: true },
      }),
      this.prisma.payment.groupBy({
        by: ['currency'],
        where: { status: 'succeeded', receivedAt: { gte: monthFrom } },
        _sum: { amount: true },
      }),
      this.prisma.payrollRun.count({ where: { status: 'reviewed' } }),
      ledger ? this.prisma.billingEvent.count({ where: { consumedAt: null } }) : Promise.resolve(0),
      ledger ? this.prisma.payrollEvent.count({ where: { consumedAt: null } }) : Promise.resolve(0),
    ]);
    return {
      overdueInvoices: overdue
        .map((o) => ({
          currency: o.currency,
          count: o._count._all,
          amount: fromCents(cents(o._sum.total) - cents(o._sum.paid)),
        }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      receivedThisMonth: received
        .map((r) => ({ currency: r.currency, amount: fromCents(cents(r._sum.amount)) }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      payrollAwaitingApproval: payroll,
      ledgerPending: ledger ? billingPending + payrollPending : null,
    };
  }
}
