import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SupportModule } from '../support/support.module.js';
import { DashboardMetricsController } from './metrics.controller.js';
import { DashboardEventsService } from './events.service.js';
import { DashboardMetricsService } from './metrics.service.js';
import { DashboardWaitingService } from './waiting.service.js';

/** D1 (docs/40): the management dashboard's metrics, in USD (D144). */
@Module({
  imports: [AuthModule, AccountingModule, SupportModule],
  controllers: [DashboardMetricsController],
  providers: [DashboardMetricsService, DashboardEventsService, DashboardWaitingService],
  exports: [DashboardMetricsService],
})
export class DashboardModule {}
