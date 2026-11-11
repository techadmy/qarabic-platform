import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  assignLeadSchema,
  bookTrialSchema,
  type BookedTrialDto,
  bulkAssignLeadsSchema,
  bulkLeadStatusSchema,
  type BulkResultDto,
  convertLeadSchema,
  CRM_SETTING_RULES,
  type CrmSettingsDto,
  createLeadAccountSchema,
  createLeadSchema,
  type LeadActivityDto,
  leadActivityInputSchema,
  type LeadAssigneeDto,
  type LeadDetailDto,
  type LeadDto,
  type LeadFunnelDto,
  leadFunnelQuerySchema,
  leadListQuerySchema,
  leadStatusChangeSchema,
  type LeadSummaryDto,
  leadSummaryQuerySchema,
  type Paginated,
  type PublicCourseDto,
  publicTrialRequestSchema,
  referralSchema,
  trialOutcomeSchema,
  updateCrmSettingsSchema,
  updateLeadSchema,
  WEB_LEAD_SIGNATURE_HEADER,
  WEB_LEAD_TIMESTAMP_HEADER,
  wpformsLeadSchema,
} from '@qarabic/shared';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CurrentUser, Public, SkipCsrf } from '../auth/decorators.js';
import { RateLimit } from '../auth/rate-limit.guard.js';
import { Clock } from '../common/clock.js';
import { validationError } from '../common/errors.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody, ZodPipe } from '../common/zod.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService, type SettingKey } from '../settings/settings.service.js';
import { CaptchaVerifier } from './captcha.js';
import { CrmConfig, verifyWebLead } from './crm.config.js';
import { crmError } from './errors.js';
import { LeadService } from './lead.service.js';
import { PublicIntake } from './public-intake.service.js';
import { activityDto, LeadReports } from './reports.service.js';
import { CrmThrottle, CrmThrottleGuard } from './throttle.js';
import { LeadTrialService } from './trial.service.js';

type Out<S extends z.ZodType> = z.output<S>;

/**
 * `/leads` (docs/26 §8): queue, workbench, timeline, assignment, status, trial and conversion.
 * Every staff member with `leads.view` sees every lead (D108); giving a lead to someone else
 * needs `leads.assign`. Trial and conversion also need the family and schedule permissions.
 */
@ApiTags('leads')
@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leads: LeadService,
    private readonly reports: LeadReports,
    private readonly trials: LeadTrialService,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  @Can('leads.view')
  @Get('summary')
  async summary(
    @ZodQuery(leadSummaryQuerySchema) q: Out<typeof leadSummaryQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: LeadSummaryDto }> {
    return { data: await this.reports.summary(q.tz, viewer) };
  }

  @Can('leads.view')
  @Get('assignees')
  async assignees(): Promise<{ data: LeadAssigneeDto[] }> {
    return { data: await this.reports.assignees() };
  }

  @Can('leads.view')
  @Get('funnel')
  async funnel(
    @ZodQuery(leadFunnelQuerySchema) q: Out<typeof leadFunnelQuerySchema>,
  ): Promise<{ data: LeadFunnelDto }> {
    return { data: await this.reports.funnel(q.from, q.to) };
  }

  @Can('leads.assign')
  @Post('bulk/assign')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(bulkAssignLeadsSchema) })
  async bulkAssign(
    @ZodBody(bulkAssignLeadsSchema) body: Out<typeof bulkAssignLeadsSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: BulkResultDto }> {
    return { data: await this.leads.bulkAssign(body.ids, body.userId, actor) };
  }

  @Can('leads.manage')
  @Post('bulk/status')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(bulkLeadStatusSchema) })
  async bulkStatus(
    @ZodBody(bulkLeadStatusSchema) body: Out<typeof bulkLeadStatusSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: BulkResultDto }> {
    return { data: await this.leads.bulkStatus(body, actor) };
  }

  @Can('leads.view')
  @RateLimit('search')
  @Get()
  list(
    @ZodQuery(leadListQuerySchema) q: Out<typeof leadListQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<LeadDto>> {
    return this.reports.list(q, viewer);
  }

  @Can('leads.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createLeadSchema) })
  async create(
    @ZodBody(createLeadSchema) body: Out<typeof createLeadSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: LeadDetailDto }> {
    const id = await this.leads.createManual(body, actor);
    return { data: await this.reports.detail(id, actor) };
  }

  @Can('leads.view')
  @Get(':id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: LeadDetailDto }> {
    return { data: await this.reports.detail(id, viewer) };
  }

  @Can('leads.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateLeadSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateLeadSchema) body: Out<typeof updateLeadSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: LeadDetailDto }> {
    await this.leads.update(id, body, actor);
    return { data: await this.reports.detail(id, actor) };
  }

  @Can('leads.manage')
  @Post(':id/activities')
  @ApiBody({ schema: jsonSchema(leadActivityInputSchema) })
  async addActivity(
    @Param('id', IdPipe) id: number,
    @ZodBody(leadActivityInputSchema) body: Out<typeof leadActivityInputSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: LeadActivityDto }> {
    const activityId = await this.leads.addActivity(id, body, actor);
    const row = await this.prisma.leadActivity.findUniqueOrThrow({
      where: { id: activityId },
      include: { user: { select: { id: true, name: true } } },
    });
    return { data: activityDto(row) };
  }

  @Can('leads.manage')
  @Post(':id/assign')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(assignLeadSchema) })
  async assign(
    @Param('id', IdPipe) id: number,
    @ZodBody(assignLeadSchema) body: Out<typeof assignLeadSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: LeadDetailDto }> {
    await this.leads.assign(id, body, actor);
    return { data: await this.reports.detail(id, actor) };
  }

  @Can('leads.manage')
  @Post(':id/status')
  @HttpCode(200)
  @ApiOperation({ summary: 'lost (reason) / spam / job_applicant / reopen (undo) / contacted' })
  @ApiBody({ schema: jsonSchema(leadStatusChangeSchema) })
  async changeStatus(
    @Param('id', IdPipe) id: number,
    @ZodBody(leadStatusChangeSchema) body: Out<typeof leadStatusChangeSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: LeadDetailDto }> {
    await this.leads.changeStatus(id, body, actor);
    return { data: await this.reports.detail(id, actor) };
  }

  @Can('leads.manage', 'families.manage')
  @Post(':id/account')
  @ApiBody({ schema: jsonSchema(createLeadAccountSchema) })
  async account(
    @Param('id', IdPipe) id: number,
    @ZodBody(createLeadAccountSchema) body: Out<typeof createLeadAccountSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: LeadDetailDto; meta: Record<string, never> }> {
    await this.trials.createAccount(id, body, actor);
    return { data: await this.reports.detail(id, actor), meta: {} };
  }

  @Can('leads.manage', 'schedule.manage')
  @Post(':id/trials')
  @ApiOperation({ summary: 'Book (or rebook) a trial class in the family zone' })
  @ApiBody({ schema: jsonSchema(bookTrialSchema) })
  async bookTrial(
    @Param('id', IdPipe) id: number,
    @ZodBody(bookTrialSchema) body: Out<typeof bookTrialSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: LeadDetailDto; meta: { trial: BookedTrialDto } }> {
    const sessionId = await this.trials.bookTrial(id, body, actor);
    const t = this.reports.trialDto(
      await this.reports.trialSession(sessionId),
      await this.settings.all(),
    );
    return {
      data: await this.reports.detail(id, actor),
      meta: {
        trial: {
          sessionId: t.sessionId,
          startsAt: t.startsAt,
          durationMinutes: t.durationMinutes,
          stage: t.stage,
          familyZone: t.familyZone,
          teacherZone: t.teacherZone,
          familyLocal: t.familyLocal,
          teacherLocal: t.teacherLocal,
        },
      },
    };
  }

  @Can('leads.manage')
  @Post(':id/trial-outcome')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(trialOutcomeSchema) })
  async outcome(
    @Param('id', IdPipe) id: number,
    @ZodBody(trialOutcomeSchema) body: Out<typeof trialOutcomeSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: LeadDetailDto; meta: Record<string, never> }> {
    await this.trials.recordOutcome(id, body, actor);
    return { data: await this.reports.detail(id, actor), meta: {} };
  }

  @Can('leads.manage', 'families.manage', 'schedule.manage')
  @Post(':id/convert')
  @HttpCode(200)
  @ApiOperation({ summary: 'Regular enrollments + weekly times; one transaction (D110)' })
  @ApiBody({ schema: jsonSchema(convertLeadSchema) })
  async convert(
    @Param('id', IdPipe) id: number,
    @ZodBody(convertLeadSchema) body: Out<typeof convertLeadSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: LeadDetailDto; meta: { enrollmentIds: number[] } }> {
    const enrollmentIds = await this.trials.convert(id, body, actor);
    return { data: await this.reports.detail(id, actor), meta: { enrollmentIds } };
  }
}

/** `POST /me/referrals` (`leads.refer`): a parent recommends a friend (docs/26 §5.6). */
@ApiTags('leads')
@Controller('me/referrals')
@UseGuards(CrmThrottleGuard)
export class ReferralsController {
  constructor(private readonly intake: PublicIntake) {}

  @Can('leads.refer')
  @CrmThrottle('referrals')
  @Post()
  @ApiBody({ schema: jsonSchema(referralSchema) })
  async store(
    @ZodBody(referralSchema) body: Out<typeof referralSchema>,
    @CurrentUser() actor: AuthUser,
    @Req() req: Request,
  ): Promise<{ data: { received: true } }> {
    await this.intake.referral(body, actor, req.ip ?? '');
    // Same answer whether new or merged: the parent learns nothing about other families.
    return { data: { received: true } };
  }
}

/**
 * Public intake (docs/33 §3.1): no login and no CSRF token (cross-site forms); guarded by a
 * honeypot, an optional captcha and per-IP rate limits instead, or by a signature (webhook).
 */
@ApiTags('public')
@Controller('public')
@UseGuards(CrmThrottleGuard)
export class PublicFormsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly intake: PublicIntake,
    private readonly captcha: CaptchaVerifier,
    private readonly config: CrmConfig,
    private readonly clock: Clock,
  ) {}

  /** The course list of the trial form: id, names and category only. */
  @Public()
  @CrmThrottle('public-courses')
  @Get('courses')
  async courses(): Promise<{ data: PublicCourseDto[] }> {
    const rows = await this.prisma.course.findMany({
      where: { isActive: true },
      select: { id: true, nameAr: true, nameEn: true, category: true },
      orderBy: [{ nameEn: 'asc' }, { id: 'asc' }],
    });
    return { data: rows };
  }

  /** The app's free-trial form. A filled honeypot answers 200 like a success and stores nothing. */
  @Public()
  @SkipCsrf()
  @CrmThrottle('trial-form')
  @Post('trial-requests')
  @ApiBody({ schema: jsonSchema(publicTrialRequestSchema) })
  async trialRequest(
    @Body() raw: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (await this.isBot(input, req)) {
      res.status(200).json({ success: true, data: null });
      return;
    }
    const data = new ZodPipe(publicTrialRequestSchema).transform(input);
    await this.intake.trialRequest(data, req.ip ?? '');
    res.status(201).json({ data: { received: true } });
  }

  /**
   * The website's WPForms entries (form 4823), signed by the WordPress snippet:
   * `X-Qarabic-Signature: sha256=HMAC_SHA256(secret, "{X-Qarabic-Timestamp}.{raw body}")`,
   * timestamp within 5 minutes. Idempotent on the entry id. 503 while no secret is set.
   */
  @Public()
  @SkipCsrf()
  @CrmThrottle('web-leads')
  @Post('web-leads/wpforms')
  @ApiBody({ schema: jsonSchema(wpformsLeadSchema) })
  async wpforms(@Req() req: Request & { rawBody?: Buffer }, @Res() res: Response): Promise<void> {
    const secret = this.config.webhookSecret;
    if (!secret) throw crmError(HttpStatus.SERVICE_UNAVAILABLE, 'webhook_disabled');
    const ok =
      Buffer.isBuffer(req.rawBody) &&
      verifyWebLead(
        secret,
        req.get(WEB_LEAD_TIMESTAMP_HEADER),
        req.get(WEB_LEAD_SIGNATURE_HEADER),
        req.rawBody,
        this.clock.nowMs(),
      );
    if (!ok) throw crmError(HttpStatus.UNAUTHORIZED, 'invalid_signature');
    const payload = new ZodPipe(wpformsLeadSchema).transform(req.body);
    const { duplicate } = await this.intake.webLead(payload, req.ip ?? '');
    res.status(duplicate ? 200 : 201).json({ data: { received: true, duplicate } });
  }

  private async isBot(input: Record<string, unknown>, req: Request): Promise<boolean> {
    const trap = input[this.config.honeypotField];
    if (typeof trap === 'string' ? trap.trim() !== '' : trap !== undefined && trap !== null) {
      return true;
    }
    if (this.captcha.enabled()) {
      const token = input[this.config.captchaField];
      if (!(await this.captcha.verify(typeof token === 'string' ? token : '', req.ip))) {
        throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'captcha_failed');
      }
    }
    return false;
  }
}

/**
 * `POST /api/class-request` (outside `/api/v1`): the developer's old public form endpoint, kept
 * with the same URL and field names (D105). Always answers 200 `{ success: true }`.
 */
@ApiTags('public')
@Controller('api/class-request')
@UseGuards(CrmThrottleGuard)
export class LegacyClassRequestController {
  constructor(
    private readonly intake: PublicIntake,
    private readonly config: CrmConfig,
  ) {}

  @Public()
  @SkipCsrf()
  @CrmThrottle('trial-form')
  @Post()
  @HttpCode(200)
  async store(@Body() raw: unknown, @Req() req: Request): Promise<{ success: true; data: null }> {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const trap = input[this.config.honeypotField];
    if (!(typeof trap === 'string' && trap.trim() !== '')) {
      await this.intake.classRequest(input, req.ip ?? '');
    }
    return { success: true, data: null };
  }
}

const CRM_KEYS = Object.keys(CRM_SETTING_RULES) as Array<keyof typeof CRM_SETTING_RULES>;

/** `GET/PUT /settings/crm`: the `crm.*` rules as flat keys (Laravel put them on `/settings/sessions`). */
@ApiTags('settings')
@Controller('settings/crm')
export class CrmSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  @Can('settings.view')
  @Get()
  async show(): Promise<{ data: CrmSettingsDto }> {
    return { data: await this.current() };
  }

  @Can('settings.manage')
  @Put()
  @ApiBody({ schema: jsonSchema(updateCrmSettingsSchema) })
  async update(
    @Body() raw: unknown,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: CrmSettingsDto }> {
    const input = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
      string,
      unknown
    >;
    const errors: Record<string, string[]> = {};
    for (const key of Object.keys(input)) {
      if (!(CRM_KEYS as string[]).includes(key)) errors[key] = ['This setting does not exist.'];
    }
    const known = Object.fromEntries(
      Object.entries(input).filter(([k]) => (CRM_KEYS as string[]).includes(k)),
    );
    let body: Out<typeof updateCrmSettingsSchema> = {};
    try {
      body = new ZodPipe(updateCrmSettingsSchema).transform(known);
    } catch (error) {
      const resp = (
        error as { getResponse?: () => { errors?: Record<string, string[]> } }
      ).getResponse?.();
      if (!resp?.errors) throw error;
      // One message list per setting key (`crm.auto_assign_roles`), like Laravel.
      for (const [path, messages] of Object.entries(resp.errors)) {
        const key = CRM_KEYS.find((k) => path === k || path.startsWith(`${k}.`)) ?? path;
        (errors[key] ??= []).push(...messages);
      }
    }
    const roles = body['crm.auto_assign_roles'];
    if (roles?.length) {
      const known = new Set(
        (await this.prisma.role.findMany({ select: { name: true } })).map((r) => r.name),
      );
      const bad = roles.filter((r) => !known.has(r));
      if (bad.length) {
        (errors['crm.auto_assign_roles'] ??= []).push(`Unknown role: ${bad.join(', ')}.`);
      }
    }
    if (Object.keys(errors).length) throw validationError(errors);
    const before = await this.current();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) await this.settings.set(key as SettingKey, value, actor.id);
    }
    await this.audit.record({
      actorId: actor.id,
      action: 'settings_updated',
      subjectType: 'settings',
      subjectId: null,
      before: Object.fromEntries(
        Object.keys(body).map((k) => [k, before[k as keyof CrmSettingsDto]]),
      ),
      after: body,
    });
    return { data: await this.current() };
  }

  private async current(): Promise<CrmSettingsDto> {
    const all = await this.settings.all();
    return Object.fromEntries(CRM_KEYS.map((k) => [k, all[k]])) as CrmSettingsDto;
  }
}
