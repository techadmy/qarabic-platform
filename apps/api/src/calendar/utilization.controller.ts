import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type FreeCapacityDto,
  freeCapacityQuerySchema,
  type UtilizationReportDto,
  utilizationQuerySchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { CanAny, CurrentUser } from '../auth/decorators.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { UtilizationService } from './utilization.service.js';

/**
 * R1 (docs/42 §5): staff with `reports.view`; a teacher (`sessions.conduct`) gets only their own
 * numbers; parents never.
 */
@ApiTags('reports')
@Controller('reports')
export class UtilizationController {
  constructor(private readonly utilization: UtilizationService) {}

  @CanAny('reports.view', 'sessions.conduct')
  @Get('teacher-utilization')
  async teacherUtilization(
    @ZodQuery(utilizationQuerySchema) q: z.output<typeof utilizationQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: UtilizationReportDto }> {
    return { data: await this.utilization.utilization(q, viewer) };
  }

  @CanAny('reports.view', 'sessions.conduct')
  @Get('free-capacity')
  async freeCapacity(
    @ZodQuery(freeCapacityQuerySchema) q: z.output<typeof freeCapacityQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: FreeCapacityDto }> {
    return { data: await this.utilization.freeCapacity(q, viewer) };
  }
}
