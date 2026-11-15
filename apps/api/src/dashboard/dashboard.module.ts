import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DashboardMetricsController } from './metrics.controller.js';
import { DashboardMetricsService } from './metrics.service.js';

/** D1 (docs/40): the management dashboard's metrics, in USD (D144). */
@Module({
  imports: [AuthModule, AccountingModule],
  controllers: [DashboardMetricsController],
  providers: [DashboardMetricsService],
  exports: [DashboardMetricsService],
})
export class DashboardModule {}
