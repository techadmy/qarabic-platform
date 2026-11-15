import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CalendarController } from './calendar.controller.js';
import { CalendarViewService } from './calendar.service.js';

/** The calendar module's reads (docs/42 C1). Writes stay on /sessions and /schedule. */
@Module({
  imports: [AuthModule],
  controllers: [CalendarController],
  providers: [CalendarViewService],
})
export class CalendarModule {}
