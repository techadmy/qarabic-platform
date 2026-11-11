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
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  confirmTicketSchema,
  createTicketCommentSchema,
  createTicketSchema,
  type FeedbackSummaryDto,
  inboxQuerySchema,
  type InboxResponse,
  isClosedStatus,
  myRequestsQuerySchema,
  type MyRequestsResponse,
  type PersonRef,
  supportAssigneesQuerySchema,
  supportPeopleQuerySchema,
  type SupportPeopleDto,
  SUPPORT_SETTING_RULES,
  type SupportSettingKey,
  type SupportSettingsDto,
  type SupportSummaryDto,
  TICKET_UPLOAD_LIMITS,
  type TicketCommentDto,
  type TicketDetailDto,
  ticketListQuerySchema,
  type TicketListResponse,
  updateSupportSettingsSchema,
  updateTicketSchema,
} from '@qarabic/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CanAny, CurrentUser } from '../auth/decorators.js';
import { RateLimit } from '../auth/rate-limit.guard.js';
import { ApiException, notFound, validationError } from '../common/errors.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody, ZodPipe } from '../common/zod.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { InboxService } from './inbox.service.js';
import { SupportContext, SupportPolicy } from './policy.js';
import { extensionFor, FileStorage } from './storage.js';
import { TicketsService, userActor } from './tickets.service.js';
import { type MulterFile, readImages, TicketFiles } from './uploads.js';

type Out<S extends z.ZodType> = z.output<S>;

/** Laravel `$any` in `api_v1_feedback.php`: anyone who reports or handles tickets. */
const ANY = [
  'feedback.view',
  'feedback.request',
  'feedback.review',
  'feedback.manage',
  'support.view',
  'support.handle',
] as const;

/**
 * `/feedback/…` (docs/22 §9, docs/32 S1–S2): «تواصل معنا» tickets. Own vs all is decided by the
 * ticket policy: a ticket the viewer may not see answers 404 (never 403), an action they may not
 * take on a ticket they see answers 403.
 */
@ApiTags('support')
@Controller('feedback')
export class FeedbackController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly context: SupportContext,
    private readonly prisma: PrismaService,
    private readonly storage: FileStorage,
  ) {}

  /** Badge counts for the menu. */
  @CanAny(...ANY)
  @Get('summary')
  async summary(@CurrentUser() user: AuthUser): Promise<{ data: FeedbackSummaryDto }> {
    return { data: await this.tickets.summary(await this.context.viewer(user)) };
  }

  /** People a ticket can be assigned to on the triage board (holders of `feedback.manage`). */
  @Can('feedback.manage')
  @Get('assignees')
  async assignees(): Promise<{ data: PersonRef[] }> {
    return { data: await this.tickets.triagers() };
  }

  @CanAny(...ANY)
  @RateLimit('search')
  @Get('tickets')
  async list(
    @ZodQuery(ticketListQuerySchema) q: Out<typeof ticketListQuerySchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<TicketListResponse> {
    return this.tickets.list(q, await this.context.viewer(user));
  }

  /** File a ticket («تواصل معنا»): JSON or multipart with `screenshot` + `attachments`. */
  @Can('feedback.request')
  @RateLimit('feedback-create')
  @Post('tickets')
  @UseInterceptors(TicketFiles())
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({ schema: jsonSchema(createTicketSchema) })
  async create(
    @ZodBody(createTicketSchema) body: Out<typeof createTicketSchema>,
    @UploadedFiles() files: MulterFile[] | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: TicketDetailDto }> {
    const images = readImages(files, true);
    await this.tickets.validateCreate(user, body);
    const id = await this.tickets.create(user, body, body.channel ?? 'in_app', images);
    return { data: await this.tickets.detail(id, await this.context.viewer(user)) };
  }

  @CanAny(...ANY)
  @Get('tickets/:id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: TicketDetailDto }> {
    return { data: await this.tickets.detail(id, await this.context.viewer(user)) };
  }

  /** Triage (`feedback.manage`, or `support.handle` in the ticket's queue). */
  @CanAny('feedback.manage', 'support.handle')
  @Patch('tickets/:id')
  @ApiBody({ schema: jsonSchema(updateTicketSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateTicketSchema) body: Out<typeof updateTicketSchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: TicketDetailDto }> {
    const v = await this.context.viewer(user);
    await this.tickets.find(id, v, 'manage');
    await this.tickets.update(id, body, userActor(user));
    return { data: await this.tickets.detail(id, v) };
  }

  /** Reporter replies, staff replies or internal notes (JSON or multipart with `attachments`). */
  @CanAny(...ANY)
  @RateLimit('feedback-comment')
  @Post('tickets/:id/comments')
  @UseInterceptors(TicketFiles())
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({ schema: jsonSchema(createTicketCommentSchema) })
  async comment(
    @Param('id', IdPipe) id: number,
    @ZodBody(createTicketCommentSchema) body: Out<typeof createTicketCommentSchema>,
    @UploadedFiles() files: MulterFile[] | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: TicketCommentDto }> {
    const v = await this.context.viewer(user);
    const t = await this.tickets.find(id, v, 'comment');
    // Triagers and the ticket's queue handlers may add internal notes and reply on closed tickets.
    const manage = SupportPolicy.canManage(v, t);
    const internal = manage && body.internal === true;
    if (!manage && isClosedStatus(t.status)) {
      throw validationError({ body: ['This request is closed. Open a new one if you need help.'] });
    }
    const images = readImages(files, false);
    if (
      (await this.tickets.attachmentCount(id)) + images.length >
      TICKET_UPLOAD_LIMITS.maxAttachmentsPerTicket
    ) {
      throw validationError({ attachments: ['This request already has the most files allowed.'] });
    }
    const commentId = await this.tickets.comment(id, userActor(user), body.body, internal, images);
    const detail = await this.tickets.detail(id, v);
    return { data: detail.timeline.find((c) => c.id === commentId)! };
  }

  /** The reporter confirms a fix (verified) or says it still happens (back to triaged). */
  @Can('feedback.request')
  @RateLimit('feedback-comment')
  @Post('tickets/:id/confirm')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(confirmTicketSchema) })
  async confirm(
    @Param('id', IdPipe) id: number,
    @ZodBody(confirmTicketSchema) body: Out<typeof confirmTicketSchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: TicketDetailDto }> {
    const v = await this.context.viewer(user);
    await this.tickets.find(id, v, 'confirm');
    await this.tickets.confirm(id, user, body.resolved, body.body);
    return { data: await this.tickets.detail(id, v) };
  }

  /** The reporter opened it: clears the «طلباتي» dot. */
  @Can('feedback.request')
  @Post('tickets/:id/seen')
  @HttpCode(204)
  async seen(@Param('id', IdPipe) id: number, @CurrentUser() user: AuthUser): Promise<void> {
    await this.tickets.find(id, await this.context.viewer(user), 'confirm');
    await this.tickets.markSeen(id);
  }

  /**
   * Streams a private file behind the ticket policy (D102). Files on internal notes are staff-only;
   * a pruned file answers 410. Served inline, no-sniff, sandboxed, never cached publicly.
   */
  @CanAny(...ANY)
  @RateLimit('attachments')
  @Get('attachments/:id')
  async attachment(
    @Param('id', IdPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    const a = await this.prisma.ticketAttachment.findUnique({
      where: { id },
      include: { comment: { select: { internal: true } } },
    });
    if (!a) throw notFound();
    const v = await this.context.viewer(user);
    const t = await this.tickets.find(a.ticketId, v);
    if (a.comment?.internal && !SupportPolicy.isStaffView(v, t)) throw notFound();
    if (a.prunedAt) {
      throw new ApiException(HttpStatus.GONE, { message: 'The file was removed.', code: 'gone' });
    }
    const bytes = await this.storage.get(a.storageKey);
    if (!bytes) throw notFound();
    res.set({
      'Content-Type': a.mime,
      'Content-Length': String(bytes.length),
      'Content-Disposition': `inline; filename="ticket-${a.ticketId}-${a.id}.${extensionFor(a.mime)}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
      'Cache-Control': 'private, max-age=300',
    });
    res.status(200).end(bytes);
  }
}

/**
 * `/support/…` (docs/32 §4–§6, D135): the unified staff inbox, the dashboard counters, the queue
 * assignees, the side panel, «take» and the merged «طلباتي».
 */
@ApiTags('support')
@Controller('support')
export class SupportController {
  constructor(
    private readonly inbox: InboxService,
    private readonly tickets: TicketsService,
    private readonly context: SupportContext,
  ) {}

  @Can('support.view')
  @RateLimit('search')
  @Get('inbox')
  @ApiOperation({ summary: 'Tickets of my queues + pending class requests, breached first' })
  async list(
    @ZodQuery(inboxQuerySchema) q: Out<typeof inboxQuerySchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<InboxResponse> {
    return this.inbox.inbox(q, await this.context.viewer(user));
  }

  @Can('support.view')
  @Get('summary')
  async summary(@CurrentUser() user: AuthUser): Promise<{ data: SupportSummaryDto }> {
    return { data: await this.inbox.summary(await this.context.viewer(user)) };
  }

  /** People who may handle a queue (assign within the queue); 422 for a queue I do not see. */
  @CanAny('support.handle', 'support.manage')
  @Get('assignees')
  async assignees(
    @ZodQuery(supportAssigneesQuerySchema) q: Out<typeof supportAssigneesQuerySchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: PersonRef[] }> {
    const v = await this.context.viewer(user);
    if (!SupportPolicy.visibleQueues(v).includes(q.queue)) {
      throw validationError({ queue: ['The selected queue is invalid.'] });
    }
    return { data: await this.tickets.handlers(q.queue, v.config) };
  }

  @Can('support.view')
  @Get('people')
  async people(
    @ZodQuery(supportPeopleQuerySchema) q: Out<typeof supportPeopleQuerySchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: SupportPeopleDto }> {
    return { data: await this.inbox.people(q, await this.context.viewer(user)) };
  }

  /** Take a ticket: assign it to me (queue members). */
  @CanAny('support.handle', 'support.manage')
  @RateLimit('feedback-comment')
  @Post('tickets/:id/take')
  @HttpCode(200)
  async take(
    @Param('id', IdPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: TicketDetailDto }> {
    const v = await this.context.viewer(user);
    await this.tickets.find(id, v, 'manage');
    await this.tickets.update(id, { assigneeId: user.id }, userActor(user));
    return { data: await this.tickets.detail(id, v) };
  }

  @CanAny('feedback.request', 'session_requests.request')
  @Get('mine')
  async mine(
    @ZodQuery(myRequestsQuerySchema) q: Out<typeof myRequestsQuerySchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<MyRequestsResponse> {
    return this.inbox.mine(q, await this.context.viewer(user));
  }
}

const SUPPORT_KEYS = Object.keys(SUPPORT_SETTING_RULES) as SupportSettingKey[];

/**
 * `GET/PUT /settings/support` (docs/32 §5): routing, queue members (role names), restricted
 * queues, per-queue SLA targets and the working week. PUT takes any subset; each key replaced.
 */
@ApiTags('settings')
@Controller('settings/support')
export class SupportSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  @Can('settings.view')
  @Get()
  async show(): Promise<{ data: SupportSettingsDto }> {
    return { data: await this.current() };
  }

  @Can('settings.manage')
  @Put()
  @ApiBody({ schema: jsonSchema(updateSupportSettingsSchema) })
  async update(
    @Body() raw: unknown,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: SupportSettingsDto }> {
    const input = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
      string,
      unknown
    >;
    const errors: Record<string, string[]> = {};
    for (const key of Object.keys(input)) {
      if (!(SUPPORT_KEYS as string[]).includes(key)) errors[key] = ['This setting does not exist.'];
    }
    const known = Object.fromEntries(
      Object.entries(input).filter(([k]) => (SUPPORT_KEYS as string[]).includes(k)),
    );
    let body: Out<typeof updateSupportSettingsSchema> = {};
    try {
      body = new ZodPipe(updateSupportSettingsSchema).transform(known);
    } catch (error) {
      const resp = (
        error as { getResponse?: () => { errors?: Record<string, string[]> } }
      ).getResponse?.();
      if (!resp?.errors) throw error;
      // One message per setting key (`support.sla_hours`), like Laravel.
      for (const [path, messages] of Object.entries(resp.errors)) {
        const key = SUPPORT_KEYS.find((k) => path === k || path.startsWith(`${k}.`)) ?? 'support';
        (errors[key] ??= []).push(...messages);
      }
    }
    const members = body['support.queue_members'];
    if (members) {
      const roles = new Set(
        (await this.prisma.role.findMany({ select: { name: true } })).map((r) => r.name),
      );
      if (Object.values(members).some((list) => list?.some((r) => !roles.has(r)))) {
        errors['support.queue_members'] = ['Every member must be an existing role.'];
      }
    }
    if (Object.keys(errors).length) throw validationError(errors);
    const before = await this.current();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) {
        await this.settings.set(key as SupportSettingKey, value, actor.id);
      }
    }
    await this.audit.record({
      actorId: actor.id,
      action: 'support_settings_updated',
      subjectType: 'settings',
      subjectId: null,
      before: Object.fromEntries(Object.keys(body).map((k) => [k, before[k as SupportSettingKey]])),
      after: body,
    });
    return { data: await this.current() };
  }

  private async current(): Promise<SupportSettingsDto> {
    const all = await this.settings.all();
    return Object.fromEntries(
      SUPPORT_KEYS.map((k) => [k, all[k]]),
    ) as unknown as SupportSettingsDto;
  }
}
