import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type DashboardEventsDto,
  dashboardEventsQuerySchema,
  type DashboardMetricsDto,
  dashboardQuerySchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CurrentUser } from '../auth/decorators.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { DashboardEventsService } from './events.service.js';
import { DashboardMetricsService } from './metrics.service.js';

/**
 * `GET /dashboard/metrics` (docs/40 D1, D144). The route needs `reports.view`; each widget also
 * needs its own module permissions (DASHBOARD_WIDGET_PERMISSIONS) and is absent otherwise.
 */
@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardMetricsController {
  constructor(
    private readonly metrics: DashboardMetricsService,
    private readonly events: DashboardEventsService,
  ) {}

  @Can('reports.view')
  @Get('metrics')
  async get(
    @ZodQuery(dashboardQuerySchema) q: z.output<typeof dashboardQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: DashboardMetricsDto }> {
    return { data: await this.metrics.metrics(q, viewer.permissions) };
  }

  /** «Recent events» (docs/40 §3): each kind gated like its widget (DASHBOARD_EVENT_PERMISSIONS). */
  @Can('reports.view')
  @Get('events')
  async recent(
    @ZodQuery(dashboardEventsQuerySchema) q: z.output<typeof dashboardEventsQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: DashboardEventsDto }> {
    return { data: await this.events.list(q, viewer.permissions) };
  }
}
