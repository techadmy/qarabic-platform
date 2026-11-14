import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  AttendanceDto,
  AttendanceListDto,
  AttendanceTodayDto,
  attendanceListQuerySchema,
  markAttendanceSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { Prisma } from '../generated/prisma/client.js';
import { lockRow, type Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DAY, isValidZone, localDate, MINUTE, toDbDate } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { payrollError } from './errors.js';
import { Period } from './period.js';
import { managesAttendance } from './policies.js';
import { attendanceDto, attendanceInclude, dateStr, isDeductible, person } from './presenter.js';
import { PayrollRunsService } from './runs.service.js';

type Db = PrismaService | Tx;

/**
 * Staff check-in / check-out and day marking (D94; Laravel `AttendanceService`). Times are the
 * server clock only. A work day is the person's local date: the teacher's zone, else their own
 * zone, else the academy's. Worked minutes are real elapsed minutes, so a shift over a DST change
 * or midnight is counted right.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly runs: PayrollRunsService,
  ) {}

  /** The zone a person's work day is counted in: teacher zone, own zone, academy. */
  async zoneOf(userId: number, db: Db = this.prisma): Promise<string> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { timezone: true, teacher: { select: { timezone: true } } },
    });
    if (user?.teacher?.timezone && isValidZone(user.teacher.timezone)) return user.teacher.timezone;
    if (user?.timezone && isValidZone(user.timezone)) return user.timezone;
    return this.settings.get('academy.timezone');
  }

  async today(viewer: AuthUser): Promise<AttendanceTodayDto> {
    const zone = await this.zoneOf(viewer.id);
    const date = localDate(this.clock.nowMs(), zone);
    const row = await this.prisma.staffAttendance.findUnique({
      where: { userId_workDate: { userId: viewer.id, workDate: toDbDate(date) } },
      include: attendanceInclude,
    });
    return {
      date,
      timezone: zone,
      record: row ? attendanceDto(row) : null,
      onLeave: row?.status === 'leave',
    };
  }

  async checkIn(viewer: AuthUser): Promise<AttendanceDto> {
    const zone = await this.zoneOf(viewer.id);
    const now = this.clock.now();
    const date = localDate(now.getTime(), zone);
    const id = await this.prisma
      .$transaction(async (tx) => {
        // One check-in at a time per person.
        await lockRow(tx, 'users', viewer.id);
        const key = { userId_workDate: { userId: viewer.id, workDate: toDbDate(date) } };
        const row = await tx.staffAttendance.findUnique({ where: key });
        if (row?.checkInAt) throw payrollError(HttpStatus.CONFLICT, 'already_checked_in');
        if (row?.status === 'leave') throw payrollError(HttpStatus.CONFLICT, 'on_leave');
        const fields = {
          status: 'present' as const,
          paidLeave: true,
          checkInAt: now,
          timezone: zone,
          source: 'self' as const,
          updatedAt: now,
        };
        const saved = await tx.staffAttendance.upsert({
          where: key,
          create: { userId: viewer.id, workDate: toDbDate(date), ...fields, createdAt: now },
          update: fields,
        });
        await this.runs.touch(tx, date);
        return saved.id;
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw payrollError(HttpStatus.CONFLICT, 'already_checked_in');
        }
        throw error;
      });
    return this.show(id);
  }

  /** Closes the latest open day (a shift that crosses midnight still closes), within 24 h. */
  async checkOut(viewer: AuthUser): Promise<AttendanceDto> {
    const now = this.clock.now();
    const id = await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'users', viewer.id);
      const row = await tx.staffAttendance.findFirst({
        where: {
          userId: viewer.id,
          checkInAt: { not: null, gte: new Date(now.getTime() - DAY) },
          checkOutAt: null,
        },
        orderBy: { checkInAt: 'desc' },
      });
      if (!row) throw payrollError(HttpStatus.CONFLICT, 'not_checked_in');
      const worked = Math.floor(Math.max(0, now.getTime() - row.checkInAt!.getTime()) / MINUTE);
      await tx.staffAttendance.update({
        where: { id: row.id },
        data: { checkOutAt: now, workedMinutes: worked, updatedAt: now },
      });
      return row.id;
    });
    return this.show(id);
  }

  async list(
    q: z.output<typeof attendanceListQuerySchema>,
    viewer: AuthUser,
  ): Promise<AttendanceListDto> {
    const st = await this.settings.all();
    const period = q.month
      ? Period.parse(q.month)
      : Period.current(this.clock.nowMs(), st['academy.timezone']);
    const manager = managesAttendance(viewer);
    const userId = manager ? q.userId : viewer.id;
    const rows = await this.prisma.staffAttendance.findMany({
      where: {
        workDate: { gte: toDbDate(period.startsOn()), lte: toDbDate(period.endsOn()) },
        ...(userId ? { userId } : {}),
      },
      include: attendanceInclude,
      orderBy: [{ workDate: 'asc' }, { userId: 'asc' }],
      take: 500,
    });
    const groups = new Map<number, typeof rows>();
    for (const r of rows) groups.set(r.userId, [...(groups.get(r.userId) ?? []), r]);
    return {
      data: rows.map(attendanceDto),
      meta: {
        month: period.toString(),
        scope: manager ? 'all' : 'own',
        summary: [...groups.values()].map((g) => ({
          user: person(g[0]!.user),
          present: g.filter((r) => r.status === 'present').length,
          absent: g.filter((r) => r.status === 'absent').length,
          leave: g.filter((r) => r.status === 'leave').length,
          holiday: g.filter((r) => r.status === 'holiday').length,
          deductibleDays: g.filter(isDeductible).length,
          workedMinutes: g.reduce((a, r) => a + (r.workedMinutes ?? 0), 0),
        })),
      },
    };
  }

  /** Staff set or correct a day (reason required, audited). 409 `period_locked` once approved. */
  async mark(
    userId: number,
    date: string,
    input: z.output<typeof markAttendanceSchema>,
    by: AuthUser,
  ): Promise<AttendanceDto> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || dateStr(new Date(`${date}T00:00:00Z`)) !== date) {
      throw notFound();
    }
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!target) throw notFound();
    // P0-3 (B116): nobody marks their own day.
    if (userId === by.id) throw payrollError(HttpStatus.FORBIDDEN, 'self_decision');
    await this.runs.assertOpen(date);
    const zone = await this.zoneOf(userId);
    const id = await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'users', userId);
      await this.runs.assertOpen(date, tx);
      const key = { userId_workDate: { userId, workDate: toDbDate(date) } };
      const before = await tx.staffAttendance.findUnique({ where: key });
      const now = this.clock.now();
      const fields = {
        status: input.status,
        paidLeave: input.status === 'leave' ? (input.paidLeave ?? true) : true,
        note: input.note ?? null,
        source: 'staff' as const,
        recordedById: by.id,
        updatedAt: now,
      };
      const row = await tx.staffAttendance.upsert({
        where: key,
        create: { userId, workDate: toDbDate(date), timezone: zone, ...fields, createdAt: now },
        update: fields,
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'attendance_marked',
          subjectType: 'staff_attendance',
          subjectId: row.id,
          before: before
            ? { status: before.status, paidLeave: before.paidLeave, note: before.note }
            : null,
          after: { status: row.status, paidLeave: row.paidLeave, note: row.note, date },
          reason: input.reason,
        },
        tx,
      );
      await this.runs.touch(tx, date);
      return row.id;
    });
    return this.show(id);
  }

  /**
   * N5 follow-up (`crm.shift_source=attendance`): is the person on shift at an instant? Checked in
   * (within 24 h before) and not checked out yet at that instant, and no approved leave that day.
   */
  async isOnShift(userId: number, at: Date = this.clock.now()): Promise<boolean> {
    const row = await this.prisma.staffAttendance.findFirst({
      where: {
        userId,
        status: 'present',
        checkInAt: { lte: at, gte: new Date(at.getTime() - DAY) },
        OR: [{ checkOutAt: null }, { checkOutAt: { gt: at } }],
      },
      orderBy: { checkInAt: 'desc' },
    });
    if (!row) return false;
    const leave = await this.prisma.leaveRequest.count({
      where: {
        userId,
        status: 'approved',
        startsOn: { lte: row.workDate },
        endsOn: { gte: row.workDate },
      },
    });
    return leave === 0;
  }

  private async show(id: number): Promise<AttendanceDto> {
    return attendanceDto(
      await this.prisma.staffAttendance.findUniqueOrThrow({
        where: { id },
        include: attendanceInclude,
      }),
    );
  }
}
