import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  addSlotSchema,
  type AvailabilityDto,
  availabilityQuerySchema,
  type ConflictResultDto,
  createEnrollmentSchema,
  createHolidaySchema,
  createTeacherBlockSchema,
  endEnrollmentSchema,
  endSlotSchema,
  type EnrollmentDetailDto,
  type EnrollmentDto,
  enrollmentListQuerySchema,
  type HolidayDto,
  holidayListQuerySchema,
  type Paginated,
  pauseEnrollmentSchema,
  replaceWorkHoursSchema,
  scheduleCheckSchema,
  type ScheduleSlotDto,
  type SessionDto,
  type TeacherBlockDto,
  type TimetableDto,
  timetableQuerySchema,
  updateEnrollmentSchema,
  updateHolidaySchema,
  updateSlotSchema,
  updateTeacherBlockSchema,
  type WorkHourDto,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CanAny, CurrentUser } from '../auth/decorators.js';
import { RateLimit } from '../auth/rate-limit.guard.js';
import { Clock } from '../common/clock.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { isParentViewer } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AvailabilityService } from './availability.service.js';
import { CalendarService } from './calendar.service.js';
import { ConflictChecker } from './conflicts.js';
import { EnrollmentsService } from './enrollments.service.js';
import { assertStaff, forbidden } from './scope.js';
import { localDate } from './time.js';
import { notFound } from '../common/errors.js';

type Out<S extends z.ZodType> = z.output<S>;

/**
 * `/enrollments` (docs/14 §8.2). Reads: staff with `schedule.view`, a teacher their own
 * (`sessions.conduct`, D138), a parent their children's. Writes: `schedule.manage`.
 */
@ApiTags('schedule')
@Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @CanAny('schedule.view', 'sessions.conduct')
  @RateLimit('search')
  @Get()
  list(
    @ZodQuery(enrollmentListQuerySchema) q: Out<typeof enrollmentListQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<EnrollmentDto>> {
    return this.enrollments.list(q, viewer);
  }

  @CanAny('schedule.view', 'sessions.conduct')
  @Get(':id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: EnrollmentDetailDto }> {
    return { data: await this.enrollments.show(id, viewer) };
  }

  @Can('schedule.manage')
  @Post()
  @ApiOperation({ summary: 'Enrollment + weekly slots; 409 schedule_conflict / 422 warnings' })
  @ApiBody({ schema: jsonSchema(createEnrollmentSchema) })
  async create(
    @ZodBody(createEnrollmentSchema) body: Out<typeof createEnrollmentSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: EnrollmentDto }> {
    const id = await this.enrollments.create(body, actor);
    return { data: await this.enrollments.dto(id, actor) };
  }

  @Can('schedule.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateEnrollmentSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateEnrollmentSchema) body: Out<typeof updateEnrollmentSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: EnrollmentDto; affectedManualSessions: SessionDto[] }> {
    const affected = await this.enrollments.update(id, body, actor);
    return { data: await this.enrollments.dto(id, actor), affectedManualSessions: affected };
  }

  @Can('schedule.manage')
  @Post(':id/pause')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(pauseEnrollmentSchema) })
  async pause(
    @Param('id', IdPipe) id: number,
    @ZodBody(pauseEnrollmentSchema) body: Out<typeof pauseEnrollmentSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: EnrollmentDto }> {
    await this.enrollments.pause(id, body.reason, actor);
    return { data: await this.enrollments.dto(id, actor) };
  }

  @Can('schedule.manage')
  @Post(':id/resume')
  @HttpCode(200)
  async resume(
    @Param('id', IdPipe) id: number,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: EnrollmentDto }> {
    await this.enrollments.resume(id, actor);
    return { data: await this.enrollments.dto(id, actor) };
  }

  @Can('schedule.manage')
  @Post(':id/end')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(endEnrollmentSchema) })
  async end(
    @Param('id', IdPipe) id: number,
    @ZodBody(endEnrollmentSchema) body: Out<typeof endEnrollmentSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: EnrollmentDto }> {
    await this.enrollments.end(id, body.endsOn, actor);
    return { data: await this.enrollments.dto(id, actor) };
  }

  @Can('schedule.manage')
  @Post(':id/slots')
  @ApiBody({ schema: jsonSchema(addSlotSchema) })
  async addSlot(
    @Param('id', IdPipe) id: number,
    @ZodBody(addSlotSchema) body: Out<typeof addSlotSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: ScheduleSlotDto }> {
    const slotId = await this.enrollments.addSlot(id, body, actor);
    return { data: await this.enrollments.slot(slotId) };
  }
}

/** Versioned slot edits (docs/14 §2.3): PATCH closes the row and opens a new one. */
@ApiTags('schedule')
@Controller('schedule-slots')
export class ScheduleSlotsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  @Can('schedule.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateSlotSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateSlotSchema) body: Out<typeof updateSlotSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: ScheduleSlotDto; affectedManualSessions: SessionDto[] }> {
    const { slotId, affected } = await this.enrollments.versionSlot(id, body, actor);
    return { data: await this.enrollments.slot(slotId), affectedManualSessions: affected };
  }

  @Can('schedule.manage')
  @Post(':id/end')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(endSlotSchema) })
  async end(
    @Param('id', IdPipe) id: number,
    @ZodBody(endSlotSchema) body: Out<typeof endSlotSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: ScheduleSlotDto }> {
    await this.enrollments.endSlot(id, body.validTo, actor);
    return { data: await this.enrollments.slot(id) };
  }
}

/** Staff scheduling tools: availability search and the dry-run conflict check. */
@ApiTags('schedule')
@Controller('schedule')
export class ScheduleToolsController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly checker: ConflictChecker,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  @Can('schedule.view')
  @RateLimit('search')
  @Get('availability')
  @ApiOperation({ summary: 'Free times of qualified teachers in the student zone (staff only)' })
  async search(
    @ZodQuery(availabilityQuerySchema) q: Out<typeof availabilityQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: AvailabilityDto }> {
    assertStaff(viewer);
    return { data: await this.availability.search(q) };
  }

  @Can('schedule.view')
  @Post('check')
  @HttpCode(200)
  @ApiOperation({ summary: 'Dry-run conflicts for a weekly slot or a single class' })
  @ApiBody({ schema: jsonSchema(scheduleCheckSchema) })
  async check(
    @ZodBody(scheduleCheckSchema) d: Out<typeof scheduleCheckSchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: ConflictResultDto }> {
    if (isParentViewer(viewer)) throw forbidden();
    const st = await this.settings.all();
    if ('startsAt' in d) {
      const e = await this.prisma.enrollment.findUnique({ where: { id: d.enrollmentId } });
      if (!e) throw notFound();
      const result = await this.checker.checkSession(
        this.prisma,
        {
          teacherId: d.teacherId ?? e.teacherId,
          studentId: e.studentId,
          startsAt: new Date(d.startsAt).getTime(),
          durationMinutes: d.durationMinutes,
          enrollmentId: e.id,
          excludeSessionId: d.excludeSessionId ?? null,
        },
        st,
      );
      return { data: result.toDto() };
    }
    const result = await this.checker.checkSlot(
      this.prisma,
      {
        teacherId: d.teacherId,
        studentId: d.studentId,
        weekday: d.weekday,
        localStartTime: d.localStartTime,
        durationMinutes: d.durationMinutes ?? 30,
        timezone: d.timezone,
        validFrom: d.validFrom ?? localDate(this.clock.nowMs(), d.timezone),
        validTo: null,
        enrollmentId: d.enrollmentId ?? null,
        excludeSlotIds: d.excludeSlotId ? [d.excludeSlotId] : [],
      },
      st,
    );
    return { data: result.toDto() };
  }
}

/** `/holidays`: academy-local dates; a change re-syncs generated classes. */
@ApiTags('schedule')
@Controller('holidays')
export class HolidaysController {
  constructor(private readonly calendar: CalendarService) {}

  @Can('schedule.view')
  @Get()
  async list(
    @ZodQuery(holidayListQuerySchema) q: Out<typeof holidayListQuerySchema>,
  ): Promise<{ data: HolidayDto[] }> {
    return { data: await this.calendar.holidays(q.year) };
  }

  @Can('schedule.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createHolidaySchema) })
  async create(
    @ZodBody(createHolidaySchema) body: Out<typeof createHolidaySchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: HolidayDto }> {
    return { data: await this.calendar.createHoliday(body, actor) };
  }

  @Can('schedule.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateHolidaySchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateHolidaySchema) body: Out<typeof updateHolidaySchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: HolidayDto }> {
    return { data: await this.calendar.updateHoliday(id, body, actor) };
  }

  @Can('schedule.manage')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', IdPipe) id: number, @CurrentUser() actor: AuthUser): Promise<void> {
    await this.calendar.deleteHoliday(id, actor);
  }
}

/**
 * A teacher's timetable, blocks and work hours (docs/14 §2.7). Staff with `schedule.view` read;
 * a teacher reads their own (another teacher's: 404). Blocks need `schedule.manage`; work hours
 * `schedule.manage` or the teacher themself.
 */
@ApiTags('schedule')
@Controller('teachers/:teacherId')
export class TeacherScheduleController {
  constructor(private readonly calendar: CalendarService) {}

  @CanAny('schedule.view', 'sessions.conduct')
  @Get('timetable')
  async timetable(
    @Param('teacherId', IdPipe) teacherId: number,
    @ZodQuery(timetableQuerySchema) q: Out<typeof timetableQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TimetableDto }> {
    return { data: await this.calendar.timetable(teacherId, q, viewer) };
  }

  @CanAny('schedule.view', 'sessions.conduct')
  @Get('blocks')
  async blocks(
    @Param('teacherId', IdPipe) teacherId: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TeacherBlockDto[] }> {
    return { data: await this.calendar.blocks(teacherId, viewer) };
  }

  @Can('schedule.manage')
  @Post('blocks')
  @ApiBody({ schema: jsonSchema(createTeacherBlockSchema) })
  async createBlock(
    @Param('teacherId', IdPipe) teacherId: number,
    @ZodBody(createTeacherBlockSchema) body: Out<typeof createTeacherBlockSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: TeacherBlockDto }> {
    return { data: await this.calendar.createBlock(teacherId, body, actor) };
  }

  @Can('schedule.manage')
  @Patch('blocks/:blockId')
  @ApiBody({ schema: jsonSchema(updateTeacherBlockSchema) })
  async updateBlock(
    @Param('teacherId', IdPipe) teacherId: number,
    @Param('blockId', IdPipe) blockId: number,
    @ZodBody(updateTeacherBlockSchema) body: Out<typeof updateTeacherBlockSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: TeacherBlockDto }> {
    return { data: await this.calendar.updateBlock(teacherId, blockId, body, actor) };
  }

  @Can('schedule.manage')
  @Delete('blocks/:blockId')
  @HttpCode(204)
  async deleteBlock(
    @Param('teacherId', IdPipe) teacherId: number,
    @Param('blockId', IdPipe) blockId: number,
    @CurrentUser() actor: AuthUser,
  ): Promise<void> {
    await this.calendar.deleteBlock(teacherId, blockId, actor);
  }

  @CanAny('schedule.view', 'sessions.conduct')
  @Get('work-hours')
  async workHours(
    @Param('teacherId', IdPipe) teacherId: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: WorkHourDto[] }> {
    return { data: await this.calendar.workHours(teacherId, viewer) };
  }

  @CanAny('schedule.manage', 'sessions.conduct')
  @Put('work-hours')
  @ApiBody({ schema: jsonSchema(replaceWorkHoursSchema) })
  async replaceWorkHours(
    @Param('teacherId', IdPipe) teacherId: number,
    @ZodBody(replaceWorkHoursSchema) body: Out<typeof replaceWorkHoursSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: WorkHourDto[] }> {
    return { data: await this.calendar.replaceWorkHours(teacherId, body, actor) };
  }
}
