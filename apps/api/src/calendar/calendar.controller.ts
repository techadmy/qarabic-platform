import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type CalendarBackgroundDto,
  calendarBackgroundQuerySchema,
  type CalendarEventsDto,
  calendarEventsQuerySchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { CanAny, CurrentUser } from '../auth/decorators.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { CalendarViewService } from './calendar.service.js';

/**
 * `/calendar` (docs/42 C1, D148): staff with `schedule.view` see every teacher; a teacher
 * (`sessions.conduct`) only their own; parents are refused (portal calendar later).
 */
@ApiTags('calendar')
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarViewService) {}

  @CanAny('schedule.view', 'sessions.conduct')
  @Get('events')
  async events(
    @ZodQuery(calendarEventsQuerySchema) q: z.output<typeof calendarEventsQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: CalendarEventsDto }> {
    return { data: await this.calendar.events(q, viewer) };
  }

  @CanAny('schedule.view', 'sessions.conduct')
  @Get('background')
  async background(
    @ZodQuery(calendarBackgroundQuerySchema) q: z.output<typeof calendarBackgroundQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: CalendarBackgroundDto }> {
    return { data: await this.calendar.background(q, viewer) };
  }
}
