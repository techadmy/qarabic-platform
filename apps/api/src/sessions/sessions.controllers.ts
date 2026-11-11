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
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  approveSessionRequestSchema,
  boardQuerySchema,
  createSessionRequestSchema,
  createSessionSchema,
  createZoomHostSchema,
  type GenerateResultDto,
  generateSessionsSchema,
  type Paginated,
  type RequestCountsDto,
  rejectSessionRequestSchema,
  SESSION_SETTING_RULES,
  type SessionDetailDto,
  type SessionDto,
  sessionListQuerySchema,
  type SessionRequestDto,
  sessionRequestListQuerySchema,
  type SessionSettingsDto,
  transitionSchema,
  updateSessionSchema,
  updateSessionSettingsSchema,
  updateZoomHostSchema,
  type ZoomHostDto,
} from '@qarabic/shared';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CanAny, CurrentUser } from '../auth/decorators.js';
import { RateLimit } from '../auth/rate-limit.guard.js';
import { Clock } from '../common/clock.js';
import { notFound, validationError } from '../common/errors.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody, ZodPipe } from '../common/zod.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import type { ZoomHost } from '../generated/prisma/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, isoZ, localDate, MINUTE } from '../schedule/time.js';
import { SettingsService, type SettingKey } from '../settings/settings.service.js';
import { SessionReads } from './board.js';
import { fail } from './errors.js';
import { SessionGenerator } from './generator.js';
import { SessionRequestsService } from './requests.service.js';
import { SessionsService } from './sessions.service.js';
import { Actor, SessionStateMachine, StaleSessionError } from './state-machine.js';
import { ZoomDriver, ZoomMeetings } from './zoom.js';
import { recordEvent } from './events.js';

type Out<S extends z.ZodType> = z.output<S>;

/** Teacher start link from 15 minutes before; the family / staff join link from 60 (docs/14 §7.3). */
const START_BEFORE_MIN = 15;
const JOIN_BEFORE_MIN = 60;

/**
 * `/sessions` (docs/14 §8.2): rows are scoped to the viewer — a teacher their own classes, a
 * parent their children's (404 outside the scope, never 403).
 */
@ApiTags('sessions')
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly reads: SessionReads,
    private readonly sessions: SessionsService,
    private readonly machine: SessionStateMachine,
    private readonly generator: SessionGenerator,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly zoom: ZoomDriver,
    private readonly meetings: ZoomMeetings,
  ) {}

  @Can('sessions.view')
  @RateLimit('search')
  @Get()
  list(
    @ZodQuery(sessionListQuerySchema) q: Out<typeof sessionListQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<SessionDto>> {
    return this.reads.list(q, viewer);
  }

  /**
   * The Today board: counters + rows + cursor; a weak ETag answers 304 when nothing changed
   * (`serverTime` is left out of the ETag).
   */
  @Can('sessions.view')
  @Get('board')
  async board(
    @ZodQuery(boardQuerySchema) q: Out<typeof boardQuerySchema>,
    @CurrentUser() viewer: AuthUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { body, etag } = await this.reads.board(q, viewer);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    const sent = (req.headers['if-none-match'] ?? '').split(',').map((t) => t.trim());
    if (sent.includes(etag)) {
      res.status(304).end();
      return;
    }
    res.status(200).json({ data: { ...body, serverTime: isoZ(this.clock.nowMs()) } });
  }

  /**
   * «مزامنة حصص اليوم» (docs/14 §6.2): runs the generator for one academy-local date with a dry
   * run preview. Never deletes or edits anything (D40).
   */
  @Can('schedule.manage')
  @Post('generate')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(generateSessionsSchema) })
  async generate(
    @ZodBody(generateSessionsSchema) body: Out<typeof generateSessionsSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: GenerateResultDto }> {
    const academy = (await this.settings.all())['academy.timezone'];
    // Slots are in local zones: cover the date in every zone (±1 day), then keep the asked date.
    const options = { from: addDays(body.date, -1), to: addDays(body.date, 1) };
    const preview = await this.generator.run({ ...options, dryRun: true });
    const toCreate = preview.toCreate.filter(
      (row) => localDate(new Date(row.startsAt).getTime(), academy) === body.date,
    );
    let created: number[] = [];
    if (!body.dryRun) {
      const result = await this.generator.withLock(() => this.generator.run(options), 10_000);
      if (!result)
        throw fail(HttpStatus.CONFLICT, 'conflict', {
          message: 'Another generator run is in progress.',
        });
      created = result.created;
      await this.audit.record({
        actorId: actor.id,
        action: 'sessions_sync_day',
        subjectType: 'class_session',
        subjectId: null,
        after: { date: body.date, created: created.length },
      });
    }
    return { data: { toCreate, created } };
  }

  @Can('sessions.manage')
  @Post()
  @ApiOperation({
    summary: 'A one-off class on an enrollment (409 schedule_conflict / 422 warnings)',
  })
  @ApiBody({ schema: jsonSchema(createSessionSchema) })
  async create(
    @ZodBody(createSessionSchema) body: Out<typeof createSessionSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: SessionDto }> {
    if (!(await this.prisma.enrollment.findUnique({ where: { id: body.enrollmentId } }))) {
      throw validationError({ enrollmentId: ['The selected enrollment is invalid.'] });
    }
    const id = await this.sessions.create(
      { ...body, source: 'manual' },
      await Actor.of(this.prisma, actor),
      body.acknowledgeWarnings,
    );
    return { data: await this.reads.dto(id, actor) };
  }

  @Can('sessions.view')
  @Get(':id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: SessionDetailDto }> {
    return { data: await this.reads.detail(id, viewer) };
  }

  /** Shift a scheduled class or change its teacher (it becomes detached). */
  @Can('sessions.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateSessionSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateSessionSchema) body: Out<typeof updateSessionSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: SessionDto }> {
    await this.reads.find(id, actor);
    await this.stale(id, actor, async () =>
      this.sessions.reschedule(
        id,
        body,
        await Actor.of(this.prisma, actor),
        body.acknowledgeWarnings,
      ),
    );
    return { data: await this.reads.dto(id, actor) };
  }

  /** The state machine (docs/14 §3.2). */
  @CanAny('sessions.conduct', 'sessions.manage')
  @Post(':id/transitions')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(transitionSchema) })
  async transition(
    @Param('id', IdPipe) id: number,
    @ZodBody(transitionSchema) body: Out<typeof transitionSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: SessionDto }> {
    await this.reads.find(id, actor);
    const { action, ...input } = body;
    await this.stale(id, actor, async () =>
      this.machine.apply(id, action, await Actor.of(this.prisma, actor), input),
    );
    return { data: await this.reads.dto(id, actor) };
  }

  /** The teacher's start link: own teacher only, fresh, never stored or logged. */
  @Can('sessions.conduct')
  @Get(':id/zoom/start')
  async zoomStart(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: { startUrl: string } }> {
    const s = await this.reads.find(id, viewer);
    if (!(await Actor.of(this.prisma, viewer)).isOwnTeacher(s)) {
      throw fail(HttpStatus.FORBIDDEN, 'forbidden');
    }
    this.assertWindow(s, START_BEFORE_MIN);
    let url: string;
    if (s.zoomStatus === 'external' && s.zoomJoinUrl) {
      url = s.zoomJoinUrl; // the teacher's own meeting link (until Zoom, B7)
    } else if (s.zoomStatus === 'ready' && s.zoomMeetingId && this.zoom.client.enabled()) {
      try {
        url = await this.zoom.client.startUrl(s.zoomMeetingId);
      } catch {
        throw fail(HttpStatus.SERVICE_UNAVAILABLE, 'zoom_unavailable');
      }
    } else {
      throw fail(HttpStatus.SERVICE_UNAVAILABLE, 'zoom_unavailable');
    }
    await recordEvent(this.prisma, this.clock, s.id, 'zoom_start_url_issued', { actor: viewer });
    res.setHeader('Cache-Control', 'no-store, private');
    return { data: { startUrl: url } };
  }

  @Can('sessions.view')
  @Get(':id/zoom/join')
  async zoomJoin(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: { joinUrl: string } }> {
    const s = await this.reads.find(id, viewer);
    this.assertWindow(s, JOIN_BEFORE_MIN);
    if ((s.zoomStatus !== 'ready' && s.zoomStatus !== 'external') || !s.zoomJoinUrl) {
      throw fail(HttpStatus.SERVICE_UNAVAILABLE, 'zoom_unavailable');
    }
    res.setHeader('Cache-Control', 'no-store, private');
    return { data: { joinUrl: s.zoomJoinUrl } };
  }

  /** Staff: try the meeting again (a failed or missing one, class not started). */
  @Can('sessions.manage')
  @Post(':id/zoom/retry')
  @HttpCode(200)
  async zoomRetry(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: SessionDto }> {
    const s = await this.reads.find(id, viewer);
    if (!this.zoom.client.enabled()) throw fail(HttpStatus.SERVICE_UNAVAILABLE, 'zoom_unavailable');
    if (!['failed', 'none'].includes(s.zoomStatus) || s.stage !== 'scheduled') {
      throw fail(HttpStatus.CONFLICT, 'conflict');
    }
    await this.prisma.classSession.update({
      where: { id },
      data: { zoomStatus: 'pending', zoomError: null, updatedAt: this.clock.now() },
    });
    await this.meetings.create(id);
    return { data: await this.reads.dto(id, viewer) };
  }

  private assertWindow(
    s: { stage: string; startsAt: Date; endsAt: Date },
    beforeMinutes: number,
  ): void {
    const now = this.clock.nowMs();
    const open = s.startsAt.getTime() - beforeMinutes * MINUTE;
    const live = ['scheduled', 'activated', 'in_progress'].includes(s.stage);
    if (!live || now < open || now > s.endsAt.getTime()) {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'outside_window', {
        errors: { availableFrom: [isoZ(open)!], availableUntil: [isoZ(s.endsAt)!] },
      });
    }
  }

  /** 409 `stale_session` with the fresh class in `data`. */
  private async stale<T>(id: number, viewer: AuthUser, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof StaleSessionError) {
        throw fail(HttpStatus.CONFLICT, 'stale_session', {
          data: await this.reads.dto(id, viewer),
        });
      }
      throw error;
    }
  }
}

/** `/session-requests` (docs/14 §3.4, §8.2). */
@ApiTags('sessions')
@Controller('session-requests')
export class SessionRequestsController {
  constructor(private readonly requests: SessionRequestsService) {}

  @Can('session_requests.view')
  @RateLimit('search')
  @Get()
  async list(
    @ZodQuery(sessionRequestListQuerySchema) q: Out<typeof sessionRequestListQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<SessionRequestDto> | { data: RequestCountsDto }> {
    if (q.countOnly) return { data: await this.requests.counts(viewer) };
    return this.requests.list(q, viewer);
  }

  @Can('session_requests.view')
  @Get(':id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: SessionRequestDto }> {
    return { data: await this.requests.show(id, viewer) };
  }

  @CanAny('session_requests.request', 'session_requests.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createSessionRequestSchema) })
  async create(
    @ZodBody(createSessionRequestSchema) body: Out<typeof createSessionRequestSchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: SessionRequestDto }> {
    const id = await this.requests.create(body, user);
    return { data: await this.requests.show(id, user) };
  }

  @Can('session_requests.approve')
  @Post(':id/approve')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(approveSessionRequestSchema) })
  async approve(
    @Param('id', IdPipe) id: number,
    @ZodBody(approveSessionRequestSchema) body: Out<typeof approveSessionRequestSchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: SessionRequestDto }> {
    await this.requests.show(id, user);
    await this.requests.decide(id, user, body);
    return { data: await this.requests.show(id, user) };
  }

  @Can('session_requests.approve')
  @Post(':id/reject')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(rejectSessionRequestSchema) })
  async reject(
    @Param('id', IdPipe) id: number,
    @ZodBody(rejectSessionRequestSchema) body: Out<typeof rejectSessionRequestSchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: SessionRequestDto }> {
    await this.requests.reject(id, user, body.note);
    return { data: await this.requests.show(id, user) };
  }

  @CanAny('session_requests.request', 'session_requests.manage')
  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(
    @Param('id', IdPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: SessionRequestDto }> {
    await this.requests.cancel(id, user);
    return { data: await this.requests.show(id, user) };
  }
}

const SETTING_KEYS = Object.keys(SESSION_SETTING_RULES) as Array<
  keyof typeof SESSION_SETTING_RULES
>;

/** `GET/PUT /settings/sessions`: the class rules as flat keys (§8.3). */
@ApiTags('settings')
@Controller('settings/sessions')
export class SessionSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Can('settings.view')
  @Get()
  async show(): Promise<{ data: SessionSettingsDto }> {
    return { data: await this.current() };
  }

  @Can('settings.manage')
  @Put()
  @ApiBody({ schema: jsonSchema(updateSessionSettingsSchema) })
  async update(
    @Body() raw: unknown,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: SessionSettingsDto }> {
    // Flat dotted keys: an unknown key is an error on that key (Laravel `prohibited`).
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const unknown = Object.keys(input).filter((k) => !(SETTING_KEYS as string[]).includes(k));
    let body: Out<typeof updateSessionSettingsSchema> = {};
    let errors: Record<string, string[]> = {};
    try {
      const known = Object.fromEntries(Object.entries(input).filter(([k]) => !unknown.includes(k)));
      body = new ZodPipe(updateSessionSettingsSchema).transform(known);
    } catch (error) {
      const resp = (
        error as { getResponse?: () => { errors?: Record<string, string[]> } }
      ).getResponse?.();
      if (!resp?.errors) throw error;
      errors = resp.errors;
    }
    for (const key of unknown) errors[key] = ['This setting does not exist.'];
    if (Object.keys(errors).length) throw validationError(errors);
    const before = await this.current();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) await this.settings.set(key as SettingKey, value, actor.id);
    }
    const after = await this.current();
    await this.audit.record({
      actorId: actor.id,
      action: 'settings_updated',
      subjectType: 'settings',
      subjectId: null,
      before: Object.fromEntries(
        Object.keys(body).map((k) => [k, before[k as keyof SessionSettingsDto]]),
      ),
      after: body,
    });
    return { data: after };
  }

  private async current(): Promise<SessionSettingsDto> {
    const all = await this.settings.all();
    return Object.fromEntries(SETTING_KEYS.map((k) => [k, all[k]])) as SessionSettingsDto;
  }
}

const hostDto = (h: ZoomHost): ZoomHostDto => ({
  id: h.id,
  zoomUserId: h.zoomUserId,
  email: h.email,
  label: h.label,
  teacherId: h.teacherId,
  isActive: h.isActive,
});

/** The Zoom host pool (docs/14 §2.9, §7.2). */
@ApiTags('settings')
@Controller('zoom-hosts')
export class ZoomHostsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Can('settings.manage')
  @Get()
  async list(): Promise<{ data: ZoomHostDto[] }> {
    return { data: (await this.prisma.zoomHost.findMany({ orderBy: { id: 'asc' } })).map(hostDto) };
  }

  @Can('settings.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createZoomHostSchema) })
  async create(
    @ZodBody(createZoomHostSchema) body: Out<typeof createZoomHostSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: ZoomHostDto }> {
    await this.assertTeacher(body.teacherId);
    const host = await this.prisma.zoomHost
      .create({
        data: {
          zoomUserId: body.zoomUserId,
          email: body.email,
          label: body.label ?? null,
          teacherId: body.teacherId ?? null,
          isActive: body.isActive ?? true,
        },
      })
      .catch(rethrowZoomUserTaken);
    await this.audit.record({
      actorId: actor.id,
      action: 'created',
      subjectType: 'zoom_host',
      subjectId: host.id,
      after: hostDto(host),
    });
    return { data: hostDto(host) };
  }

  @Can('settings.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateZoomHostSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateZoomHostSchema) body: Out<typeof updateZoomHostSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: ZoomHostDto }> {
    const before = await this.prisma.zoomHost.findUnique({ where: { id } });
    if (!before) throw notFound();
    await this.assertTeacher(body.teacherId);
    const host = await this.prisma.zoomHost
      .update({
        where: { id },
        data: {
          ...(body.zoomUserId !== undefined ? { zoomUserId: body.zoomUserId } : {}),
          ...(body.email !== undefined ? { email: body.email } : {}),
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.teacherId !== undefined ? { teacherId: body.teacherId } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        },
      })
      .catch(rethrowZoomUserTaken);
    await this.audit.record({
      actorId: actor.id,
      action: 'updated',
      subjectType: 'zoom_host',
      subjectId: id,
      before: hostDto(before),
      after: hostDto(host),
    });
    return { data: hostDto(host) };
  }

  private async assertTeacher(id: number | null | undefined): Promise<void> {
    if (id && !(await this.prisma.teacher.findUnique({ where: { id } }))) {
      throw validationError({ teacherId: ['The selected teacher is invalid.'] });
    }
  }
}

function rethrowZoomUserTaken(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw validationError({ zoomUserId: ['The Zoom user is already in the pool.'] });
  }
  throw error;
}
