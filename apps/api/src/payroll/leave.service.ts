import { HttpStatus, Injectable } from '@nestjs/common';
import {
  LEAVE_STATUSES,
  type createLeaveSchema,
  type LeaveRequestDto,
  type leaveListQuerySchema,
  type Paginated,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound, validationError } from '../common/errors.js';
import { pageMeta, statusCounts } from '../common/pagination.js';
import type { LeaveRequest, Prisma } from '../generated/prisma/client.js';
import { lockRow, type Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { forbidden } from '../schedule/scope.js';
import { addDays, dateMs, isoZ, startOfLocalDay, toDbDate } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { AttendanceService } from './attendance.service.js';
import { payrollError } from './errors.js';
import { datesBetween } from './period.js';
import { leaveCan, managesAttendance } from './policies.js';
import { dateStr, leaveDto, leaveInclude } from './presenter.js';
import { lockPayrollRow, PayrollRunsService } from './runs.service.js';

type Ability = 'view' | 'decide' | 'cancel';

/** Staff leave requests (D94, B43, B44; Laravel `LeaveService`). Approval writes attendance. */
@Injectable()
export class LeaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly runs: PayrollRunsService,
    private readonly attendance: AttendanceService,
  ) {}

  /** A leave in the viewer's scope (404 otherwise), then the action (403). */
  async find(id: number, viewer: AuthUser, ability: Ability = 'view'): Promise<LeaveRequest> {
    const leave = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!leave || !leaveCan.view(viewer, leave)) throw notFound();
    if (ability === 'decide' && !leaveCan.decide(viewer)) throw forbidden();
    if (ability === 'decide' && leave.userId === viewer.id) {
      throw payrollError(HttpStatus.FORBIDDEN, 'self_decision');
    }
    if (ability === 'cancel' && !leaveCan.cancel(viewer, leave)) throw forbidden();
    return leave;
  }

  async list(
    q: z.output<typeof leaveListQuerySchema>,
    viewer: AuthUser,
  ): Promise<Paginated<LeaveRequestDto>> {
    const manager = managesAttendance(viewer);
    const base: Prisma.LeaveRequestWhereInput = manager
      ? q.userId
        ? { userId: q.userId }
        : {}
      : { userId: viewer.id };
    const where: Prisma.LeaveRequestWhereInput = q.status ? { ...base, status: q.status } : base;
    // Pending first, then the rest by start date (newest first): two ordered slices.
    const pendingWhere = { AND: [where, { status: 'pending' as const }] };
    const restWhere = { AND: [where, { status: { not: 'pending' as const } }] };
    const order = [{ startsOn: 'desc' as const }, { id: 'desc' as const }];
    const [pendingTotal, restTotal, groups] = await Promise.all([
      this.prisma.leaveRequest.count({ where: pendingWhere }),
      this.prisma.leaveRequest.count({ where: restWhere }),
      this.prisma.leaveRequest.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    const skip = (q.page - 1) * q.perPage;
    const first =
      skip < pendingTotal
        ? await this.prisma.leaveRequest.findMany({
            where: pendingWhere,
            include: leaveInclude,
            orderBy: order,
            skip,
            take: q.perPage,
          })
        : [];
    const restTake = q.perPage - first.length;
    const second =
      restTake > 0
        ? await this.prisma.leaveRequest.findMany({
            where: restWhere,
            include: leaveInclude,
            orderBy: order,
            skip: Math.max(0, skip - pendingTotal),
            take: restTake,
          })
        : [];
    return {
      data: [...first, ...second].map((l) => leaveDto(l, viewer)),
      meta: pageMeta(q, pendingTotal + restTotal, statusCounts(LEAVE_STATUSES, groups)),
    };
  }

  async show(id: number, viewer: AuthUser, withSessions = true): Promise<LeaveRequestDto> {
    await this.find(id, viewer);
    const leave = await this.prisma.leaveRequest.findUniqueOrThrow({
      where: { id },
      include: leaveInclude,
    });
    return {
      ...leaveDto(leave, viewer),
      ...(withSessions ? { affectedSessions: await this.affectedSessions(leave) } : {}),
    };
  }

  async create(input: z.output<typeof createLeaveSchema>, by: AuthUser): Promise<number> {
    let userId = by.id;
    if (input.userId !== undefined && input.userId !== by.id) {
      if (!managesAttendance(by)) throw forbidden();
      const target = await this.prisma.user.findUnique({ where: { id: input.userId } });
      if (!target) throw validationError({ userId: ['The selected user is invalid.'] });
      userId = target.id;
    }
    const days = Math.round((dateMs(input.endsOn) - dateMs(input.startsOn)) / 86_400_000) + 1;
    const max = await this.settings.get('payroll.max_leave_days');
    if (days > max) {
      throw validationError({ endsOn: [`The leave may not be longer than ${max} days.`] });
    }
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'users', userId);
      const overlap = await tx.leaveRequest.count({
        where: {
          userId,
          status: { in: ['pending', 'approved'] },
          startsOn: { lte: toDbDate(input.endsOn) },
          endsOn: { gte: toDbDate(input.startsOn) },
        },
      });
      if (overlap) throw payrollError(HttpStatus.UNPROCESSABLE_ENTITY, 'leave_overlap');
      const now = this.clock.now();
      const leave = await tx.leaveRequest.create({
        data: {
          userId,
          startsOn: toDbDate(input.startsOn),
          endsOn: toDbDate(input.endsOn),
          days,
          leaveType: input.leaveType,
          reason: input.reason,
          status: 'pending',
          requestedById: by.id,
          createdAt: now,
          updatedAt: now,
        },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'leave_requested',
          subjectType: 'leave_request',
          subjectId: leave.id,
          after: {
            userId,
            startsOn: input.startsOn,
            endsOn: input.endsOn,
            leaveType: input.leaveType,
          },
        },
        tx,
      );
      return leave.id;
    });
  }

  async approve(leave: LeaveRequest, note: string | null, by: AuthUser): Promise<void> {
    const dates = this.dates(leave);
    for (const d of this.months(dates)) await this.runs.assertOpen(d);
    await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockStatus(tx, leave.id, ['pending']);
      for (const d of this.months(dates)) await this.runs.assertOpen(d, tx);
      const paid = fresh.leaveType !== 'unpaid';
      const now = this.clock.now();
      for (const date of dates) {
        const key = { userId_workDate: { userId: fresh.userId, workDate: toDbDate(date) } };
        const row = await tx.staffAttendance.findUnique({ where: key });
        if (row?.checkInAt) continue; // worked that day: keep the real record
        const fields = {
          status: 'leave' as const,
          paidLeave: paid,
          source: 'leave' as const,
          leaveRequestId: fresh.id,
          recordedById: by.id,
          updatedAt: now,
        };
        await tx.staffAttendance.upsert({
          where: key,
          create: { userId: fresh.userId, workDate: toDbDate(date), ...fields, createdAt: now },
          update: fields,
        });
      }
      await tx.leaveRequest.update({
        where: { id: fresh.id },
        data: {
          status: 'approved',
          decidedById: by.id,
          decidedAt: now,
          decisionNote: note,
          updatedAt: now,
        },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'leave_approved',
          subjectType: 'leave_request',
          subjectId: fresh.id,
          after: { note },
        },
        tx,
      );
      for (const d of this.months(dates)) await this.runs.touch(tx, d);
    });
  }

  async reject(leave: LeaveRequest, note: string, by: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockStatus(tx, leave.id, ['pending']);
      const now = this.clock.now();
      await tx.leaveRequest.update({
        where: { id: fresh.id },
        data: {
          status: 'rejected',
          decidedById: by.id,
          decidedAt: now,
          decisionNote: note,
          updatedAt: now,
        },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'leave_rejected',
          subjectType: 'leave_request',
          subjectId: fresh.id,
          reason: note,
        },
        tx,
      );
    });
  }

  /** Own pending request, or (attendance.manage) an approved one whose month is open. */
  async cancel(leave: LeaveRequest, reason: string, by: AuthUser): Promise<void> {
    const dates = this.dates(leave);
    if (leave.status === 'approved') {
      for (const d of this.months(dates)) await this.runs.assertOpen(d);
    }
    await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockStatus(tx, leave.id, ['pending', 'approved']);
      const wasApproved = fresh.status === 'approved';
      if (wasApproved) for (const d of this.months(dates)) await this.runs.assertOpen(d, tx);
      await tx.staffAttendance.deleteMany({ where: { leaveRequestId: fresh.id, checkInAt: null } });
      const now = this.clock.now();
      await tx.leaveRequest.update({
        where: { id: fresh.id },
        data: {
          status: 'cancelled',
          decidedById: by.id,
          decidedAt: now,
          decisionNote: reason,
          updatedAt: now,
        },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'leave_cancelled',
          subjectType: 'leave_request',
          subjectId: fresh.id,
          reason,
        },
        tx,
      );
      if (wasApproved) for (const d of this.months(dates)) await this.runs.touch(tx, d);
    });
  }

  /** The person's scheduled classes inside the leave, for the monitor to cover (B43; 100). */
  async affectedSessions(
    leave: LeaveRequest,
  ): Promise<NonNullable<LeaveRequestDto['affectedSessions']>> {
    const teacher = await this.prisma.teacher.findUnique({
      where: { userId: leave.userId },
      select: { id: true },
    });
    if (!teacher) return [];
    const zone = await this.attendance.zoneOf(leave.userId);
    const from = startOfLocalDay(dateStr(leave.startsOn)!, zone);
    const to = startOfLocalDay(addDays(dateStr(leave.endsOn)!, 1), zone);
    const rows = await this.prisma.classSession.findMany({
      where: {
        teacherId: teacher.id,
        deletedAt: null,
        stage: 'scheduled',
        startsAt: { gte: new Date(from), lt: new Date(to) },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: 100,
      select: { id: true, startsAt: true, durationMinutes: true, stage: true },
    });
    return rows.map((s) => ({
      id: s.id,
      startsAt: isoZ(s.startsAt)!,
      durationMinutes: s.durationMinutes,
      stage: s.stage,
    }));
  }

  private dates(leave: LeaveRequest): string[] {
    return datesBetween(dateStr(leave.startsOn)!, dateStr(leave.endsOn)!);
  }

  /** One date per month the leave touches. */
  private months(dates: string[]): string[] {
    const seen = new Map<string, string>();
    for (const d of dates) if (!seen.has(d.slice(0, 7))) seen.set(d.slice(0, 7), d);
    return [...seen.values()];
  }

  private async lockStatus(tx: Tx, id: number, allowed: string[]): Promise<LeaveRequest> {
    if (!(await lockPayrollRow(tx, 'leave_requests', id))) throw notFound();
    const leave = await tx.leaveRequest.findUniqueOrThrow({ where: { id } });
    if (!allowed.includes(leave.status)) {
      throw payrollError(HttpStatus.CONFLICT, 'invalid_leave_status');
    }
    return leave;
  }
}
