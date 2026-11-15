import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CalendarController } from './calendar.controller.js';
import { CalendarViewService } from './calendar.service.js';
import { UtilizationController } from './utilization.controller.js';
import { UtilizationService } from './utilization.service.js';

/** The calendar module's reads (docs/42 C1) and the utilization reports (R1). */
@Module({
  imports: [AuthModule],
  controllers: [CalendarController, UtilizationController],
  providers: [CalendarViewService, UtilizationService],
})
export class CalendarModule {}
