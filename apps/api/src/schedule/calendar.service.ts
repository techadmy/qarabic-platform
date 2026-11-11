import { Injectable } from '@nestjs/common';
import type {
  createHolidaySchema,
  createTeacherBlockSchema,
  HolidayDto,
  replaceWorkHoursSchema,
  TeacherBlockDto,
  TimetableDto,
  timetableQuerySchema,
  updateHolidaySchema,
  updateTeacherBlockSchema,
  WorkHourDto,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound, validationError } from '../common/errors.js';
import type { Holiday, Prisma, TeacherBlock } from '../generated/prisma/client.js';
import { isParentViewer, isTeacherViewer } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionPresenter, sessionInclude } from '../sessions/presenter.js';
import { type ResyncScope, ResyncService } from '../sessions/resync.js';
import { SettingsService } from '../settings/settings.service.js';
import { validBetween, zoneOr } from './conflicts.js';
import { EnrollmentsService, slotDtoInclude } from './enrollments.service.js';
import { assertStaffOrTeacher, forbidden, LIVE_ENROLLMENT, viewerScope } from './scope.js';
import {
  addDays,
  fromDbDate,
  isoWeekday,
  isoZ,
  localDate,
  startOfLocalDay,
  toDbDate,
} from './time.js';

const holidayDto = (h: Holiday): HolidayDto => ({
  id: h.id,
  name: h.name,
  date: fromDbDate(h.date),
  endsOn: h.endsOn ? fromDbDate(h.endsOn) : null,
  paid: h.paid,
  appliesTo: h.appliesTo,
});

const blockDto = (b: TeacherBlock): TeacherBlockDto => ({
  id: b.id,
  teacherId: b.teacherId,
  kind: b.kind,
  reason: b.reason,
  weekday: b.weekday,
  localStartTime: b.localStartTime,
  durationMinutes: b.durationMinutes,
  timezone: b.timezone,
  validFrom: b.validFrom ? fromDbDate(b.validFrom) : null,
  validTo: b.validTo ? fromDbDate(b.validTo) : null,
  startsAt: isoZ(b.startsAt),
  endsAt: isoZ(b.endsAt),
  note: b.note,
});

/**
 * Holidays (academy-local dates; a change re-syncs generated classes) and the teacher's calendar:
 * blocks, work hours and the weekly timetable (Laravel `HolidayController`,
 * `TeacherScheduleController`).
 */
@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly resync: ResyncService,
    private readonly presenter: SessionPresenter,
    private readonly enrollments: EnrollmentsService,
  ) {}

  // ------------------------------------------------------------------ holidays

  async holidays(year?: number): Promise<HolidayDto[]> {
    const rows = await this.prisma.holiday.findMany({
      where: year
        ? { date: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) } }
        : {},
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    });
    return rows.map(holidayDto);
  }

  async createHoliday(
    input: z.output<typeof createHolidaySchema>,
    actor: AuthUser,
  ): Promise<HolidayDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const h = await tx.holiday.create({
        data: {
          name: input.name,
          date: toDbDate(input.date),
          endsOn: input.endsOn ? toDbDate(input.endsOn) : null,
          paid: input.paid ?? true,
        },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'created',
          subjectType: 'holiday',
          subjectId: h.id,
          after: holidayDto(h),
        },
        tx,
      );
      return h;
    });
    await this.resync.run(holidayScope(row));
    return holidayDto(row);
  }

  async updateHoliday(
    id: number,
    input: z.output<typeof updateHolidaySchema>,
    actor: AuthUser,
  ): Promise<HolidayDto> {
    const before = await this.prisma.holiday.findUnique({ where: { id } });
    if (!before) throw notFound();
    const date = input.date ?? fromDbDate(before.date);
    const endsOn =
      input.endsOn !== undefined ? input.endsOn : before.endsOn ? fromDbDate(before.endsOn) : null;
    if (endsOn && endsOn < date)
      throw validationError({ endsOn: ['Must be on or after the date.'] });
    const after = await this.prisma.$transaction(async (tx) => {
      const h = await tx.holiday.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          date: toDbDate(date),
          endsOn: endsOn ? toDbDate(endsOn) : null,
          ...(input.paid !== undefined ? { paid: input.paid } : {}),
        },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'updated',
          subjectType: 'holiday',
          subjectId: id,
          before: holidayDto(before),
          after: holidayDto(h),
        },
        tx,
      );
      return h;
    });
    await this.resync.run(holidayScope(before));
    await this.resync.run(holidayScope(after));
    return holidayDto(after);
  }

  async deleteHoliday(id: number, actor: AuthUser): Promise<void> {
    const row = await this.prisma.holiday.findUnique({ where: { id } });
    if (!row) throw notFound();
    await this.prisma.$transaction(async (tx) => {
      await tx.holiday.delete({ where: { id } });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'deleted',
          subjectType: 'holiday',
          subjectId: id,
          before: holidayDto(row),
        },
        tx,
      );
    });
    await this.resync.run(holidayScope(row));
  }

  // ------------------------------------------------------------------ teacher blocks

  async blocks(teacherId: number, viewer: AuthUser): Promise<TeacherBlockDto[]> {
    await this.assertCanSee(teacherId, viewer);
    const rows = await this.prisma.teacherBlock.findMany({
      where: { teacherId },
      orderBy: [{ kind: 'asc' }, { weekday: 'asc' }, { id: 'asc' }],
    });
    return rows.map(blockDto);
  }

  async createBlock(
    teacherId: number,
    input: z.output<typeof createTeacherBlockSchema>,
    actor: AuthUser,
  ): Promise<TeacherBlockDto> {
    const teacher = await this.teacher(teacherId);
    const row = await this.prisma.$transaction(async (tx) => {
      const b = await tx.teacherBlock.create({
        data: {
          teacherId,
          kind: input.kind,
          createdById: actor.id,
          ...blockData(input, teacher.timezone),
        } as Prisma.TeacherBlockUncheckedCreateInput,
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'block_created',
          subjectType: 'teacher',
          subjectId: teacherId,
          after: blockDto(b),
        },
        tx,
      );
      return b;
    });
    await this.resync.run({ teacherId });
    return blockDto(row);
  }

  async updateBlock(
    teacherId: number,
    blockId: number,
    input: z.output<typeof updateTeacherBlockSchema>,
    actor: AuthUser,
  ): Promise<TeacherBlockDto> {
    const teacher = await this.teacher(teacherId);
    const before = await this.prisma.teacherBlock.findFirst({ where: { id: blockId, teacherId } });
    if (!before) throw notFound();
    const kind = input.kind ?? before.kind;
    const row = await this.prisma.$transaction(async (tx) => {
      const b = await tx.teacherBlock.update({
        where: { id: blockId },
        data: blockData({ ...input, kind }, teacher.timezone),
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'block_updated',
          subjectType: 'teacher',
          subjectId: teacherId,
          before: blockDto(before),
          after: blockDto(b),
        },
        tx,
      );
      return b;
    });
    await this.resync.run({ teacherId });
    return blockDto(row);
  }

  async deleteBlock(teacherId: number, blockId: number, actor: AuthUser): Promise<void> {
    const before = await this.prisma.teacherBlock.findFirst({ where: { id: blockId, teacherId } });
    if (!before) throw notFound();
    await this.prisma.$transaction(async (tx) => {
      await tx.teacherBlock.delete({ where: { id: blockId } });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'block_deleted',
          subjectType: 'teacher',
          subjectId: teacherId,
          before: blockDto(before),
        },
        tx,
      );
    });
    await this.resync.run({ teacherId });
  }

  // ------------------------------------------------------------------ work hours

  async workHours(teacherId: number, viewer: AuthUser): Promise<WorkHourDto[]> {
    await this.assertCanSee(teacherId, viewer);
    return this.workHoursOf(teacherId);
  }

  /** PUT replaces the weekly set: staff with `schedule.manage`, or the teacher for themself. */
  async replaceWorkHours(
    teacherId: number,
    input: z.output<typeof replaceWorkHoursSchema>,
    actor: AuthUser,
  ): Promise<WorkHourDto[]> {
    const teacher = await this.teacher(teacherId);
    const self = teacher.userId === actor.id && actor.permissions.has('sessions.conduct');
    if (!actor.permissions.has('schedule.manage') && !self) throw forbidden();
    const before = await this.workHoursOf(teacherId);
    await this.prisma.$transaction(async (tx) => {
      await tx.teacherWorkHour.deleteMany({ where: { teacherId } });
      if (input.workHours.length) {
        await tx.teacherWorkHour.createMany({
          data: input.workHours.map((w) => ({
            teacherId,
            weekday: w.weekday,
            localStartTime: w.localStartTime,
            localEndTime: w.localEndTime,
            timezone: w.timezone ?? teacher.timezone,
          })),
        });
      }
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'work_hours_replaced',
          subjectType: 'teacher',
          subjectId: teacherId,
          before: { workHours: before },
          after: { workHours: input.workHours },
        },
        tx,
      );
    });
    return this.workHoursOf(teacherId);
  }

  // ------------------------------------------------------------------ timetable

  /** A teacher's week: live slots, blocks, work hours and classes in [from, to) (local dates). */
  async timetable(
    teacherId: number,
    q: z.output<typeof timetableQuerySchema>,
    viewer: AuthUser,
  ): Promise<TimetableDto> {
    await this.assertCanSee(teacherId, viewer);
    const teacher = await this.teacher(teacherId);
    const academy = (await this.settings.all())['academy.timezone'];
    const teacherZone = zoneOr(teacher.timezone, academy);
    const zone = q.tz ?? teacherZone;
    let from = q.from;
    if (!from) {
      // This week from Saturday (the academy's week), in the viewer zone.
      const today = localDate(this.clock.nowMs(), zone);
      from = addDays(today, -((isoWeekday(today) + 1) % 7));
    }
    const to = q.to ?? addDays(from, 7);

    const [slots, blocks, sessions] = await Promise.all([
      this.prisma.scheduleSlot.findMany({
        where: { teacherId, enrollment: LIVE_ENROLLMENT, ...validBetween(from, to) },
        include: slotDtoInclude,
        orderBy: [{ weekday: 'asc' }, { localStartTime: 'asc' }],
      }),
      this.prisma.teacherBlock.findMany({ where: { teacherId }, orderBy: { id: 'asc' } }),
      this.prisma.classSession.findMany({
        where: {
          teacherId,
          deletedAt: null,
          startsAt: {
            gte: new Date(startOfLocalDay(from, zone)),
            lt: new Date(startOfLocalDay(to, zone)),
          },
        },
        include: sessionInclude,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return {
      teacher: {
        id: teacher.id,
        name: [teacher.firstName, teacher.lastName].filter(Boolean).join(' '),
        timezone: teacherZone,
      },
      slots: slots.map((s) => this.enrollments.labelledSlot(s, academy)),
      blocks: blocks.map(blockDto),
      workHours: await this.workHoursOf(teacherId),
      sessions: await this.presenter.many(sessions, viewer),
    };
  }

  // ------------------------------------------------------------------ helpers

  private async teacher(id: number) {
    const teacher = await this.prisma.teacher.findUnique({ where: { id } });
    if (!teacher) throw notFound();
    return teacher;
  }

  private async workHoursOf(teacherId: number): Promise<WorkHourDto[]> {
    const rows = await this.prisma.teacherWorkHour.findMany({
      where: { teacherId },
      orderBy: [{ weekday: 'asc' }, { localStartTime: 'asc' }, { id: 'asc' }],
    });
    return rows.map((w) => ({
      weekday: w.weekday,
      localStartTime: w.localStartTime,
      localEndTime: w.localEndTime,
      timezone: w.timezone,
    }));
  }

  /** Staff with `schedule.view`, or the teacher themself (another teacher: 404); never a family. */
  private async assertCanSee(teacherId: number, viewer: AuthUser): Promise<void> {
    assertStaffOrTeacher(viewer, 'schedule.view');
    if (isTeacherViewer(viewer)) {
      const scope = await viewerScope(this.prisma, viewer);
      if (scope.kind !== 'teacher' || scope.teacherId !== teacherId) throw notFound();
    }
    if (isParentViewer(viewer)) throw notFound();
  }
}

function holidayScope(h: Holiday): ResyncScope {
  const from = fromDbDate(h.date);
  return { from, to: h.endsOn ? fromDbDate(h.endsOn) : from };
}

function blockData(
  input: z.output<typeof updateTeacherBlockSchema> & { kind?: 'recurring' | 'one_off' },
  teacherZone: string,
) {
  const data: Record<string, unknown> = {};
  for (const key of ['kind', 'reason', 'note'] as const) {
    if (input[key] !== undefined) data[key] = input[key];
  }
  if (input.kind === 'recurring') {
    Object.assign(data, {
      weekday: input.weekday ?? null,
      localStartTime: input.localStartTime ?? null,
      durationMinutes: input.durationMinutes ?? null,
      timezone: input.timezone ?? teacherZone,
      validFrom: input.validFrom ? toDbDate(input.validFrom) : null,
      validTo: input.validTo ? toDbDate(input.validTo) : null,
      startsAt: null,
      endsAt: null,
    });
  }
  if (input.kind === 'one_off') {
    Object.assign(data, {
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      weekday: null,
      localStartTime: null,
      durationMinutes: null,
      timezone: null,
      validFrom: null,
      validTo: null,
    });
  }
  return data as Prisma.TeacherBlockUncheckedUpdateInput;
}
