import { Controller, Get, Param, Put } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  trialReportInputSchema,
  trialsTodayQuerySchema,
  type TrialChecklistItemDto,
  type TrialReportDto,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CanAny, CurrentUser } from '../auth/decorators.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { TrialFollowUp } from './followup.service.js';

type Out<S extends z.ZodType> = z.output<S>;

/**
 * The teacher's trial report (T4, docs/33 §3.6, B85). Only the class's teacher or staff with
 * `sessions.manage` (others: 404). Parents never see it.
 */
@ApiTags('sessions')
@Controller('sessions')
export class TrialReportsController {
  constructor(private readonly followUp: TrialFollowUp) {}

  @CanAny('sessions.conduct', 'sessions.manage')
  @Put(':id/trial-report')
  @ApiOperation({
    summary: 'Write (or edit) the trial report: closes an ended trial class and moves the lead',
  })
  @ApiBody({ schema: jsonSchema(trialReportInputSchema) })
  async submit(
    @Param('id', IdPipe) id: number,
    @ZodBody(trialReportInputSchema) body: Out<typeof trialReportInputSchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TrialReportDto | null }> {
    await this.followUp.submitReport(id, body, viewer);
    return { data: await this.followUp.showReport(id, viewer) };
  }

  @CanAny('sessions.conduct', 'sessions.manage')
  @Get(':id/trial-report')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: TrialReportDto | null }> {
    return { data: await this.followUp.showReport(id, viewer) };
  }
}

/** The CSR's view of the trial reports of a lead (for the convert form's prefill). */
@ApiTags('leads')
@Controller('leads')
export class LeadTrialReportsController {
  constructor(private readonly followUp: TrialFollowUp) {}

  @Can('leads.view')
  @Get(':id/trial-reports')
  async list(@Param('id', IdPipe) id: number): Promise<{ data: TrialReportDto[] }> {
    return { data: await this.followUp.listForLead(id) };
  }
}

/** The monitors' checklist of today's trial classes (docs/33 §3.5). */
@ApiTags('leads')
@Controller('trials')
export class TrialsTodayController {
  constructor(private readonly followUp: TrialFollowUp) {}

  @CanAny('sessions.manage', 'leads.manage')
  @Get('today')
  async today(
    @ZodQuery(trialsTodayQuerySchema) q: Out<typeof trialsTodayQuerySchema>,
  ): Promise<{ data: TrialChecklistItemDto[]; meta: { date: string; timezone: string } }> {
    return this.followUp.today(q);
  }
}
