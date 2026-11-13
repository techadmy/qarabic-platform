import { Controller, Get, HttpCode, Inject, Injectable, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  contactPath,
  ON_BEHALF_TARGET_PCT,
  PARENT_CONTACT_CARDS,
  renderSavedReplySchema,
  savedReplyInputSchema,
  SUPPORT_REQUEST_ORIGINS,
  supportChannelsQuerySchema,
  supportLinksQuerySchema,
  updateSavedReplySchema,
  type ContactLink,
  type RenderedReplyDto,
  type SavedReplyDto,
  type SupportChannelsDto,
  type SupportLinksDto,
  type SupportRequestOrigin,
} from '@qarabic/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CurrentUser } from '../auth/decorators.js';
import { Clock } from '../common/clock.js';
import { ApiException, notFound } from '../common/errors.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { ENV, type Env } from '../config/env.js';
import { Prisma, type SupportSavedReply } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, isoWeekday, local, toUtc } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';

type Out<S extends z.ZodType> = z.output<S>;
const listRepliesQuerySchema = z.object({
  all: z
    .enum(['1', '0', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});
const DAY = 86_400_000;
const STAFF_KINDS = ['staff', 'owner'];

const replyDto = (r: SupportSavedReply): SavedReplyDto => ({
  id: r.id,
  key: r.key,
  title: { ar: r.titleAr, en: r.titleEn },
  body: { ar: r.bodyAr, en: r.bodyEn },
  link: (r.link as ContactLink | null) ?? null,
  isActive: r.isActive,
  updatedAt: r.updatedAt.toISOString(),
});

/**
 * S5 (docs/32 §7): deep links, saved replies and the channel report. Links are built here and in
 * the web from the same `contactPath`; opening one still needs the person's sign-in and their row
 * scope, so a pasted link never shows anything to the wrong family.
 */
@Injectable()
export class SupportOffRamp {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  url(link: ContactLink): string {
    return new URL(contactPath(link), this.env.APP_URL).toString();
  }

  /** Ready links for one family: the hub, its four cards, the next classes, the open invoices. */
  async links(familyId: number): Promise<SupportLinksDto> {
    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      include: { user: { select: { name: true } } },
    });
    if (!family) throw notFound();
    const st = await this.settings.all();
    const zone = family.timezone || st['academy.timezone'];
    const now = this.clock.now();
    const [classes, invoices] = await Promise.all([
      this.prisma.classSession.findMany({
        where: {
          student: { familyId },
          stage: 'scheduled',
          deletedAt: null,
          startsAt: { gt: now },
        },
        include: { student: { select: { name: true } } },
        orderBy: { startsAt: 'asc' },
        take: 5,
      }),
      this.prisma.invoice.findMany({
        where: { familyId, status: { in: ['issued', 'partially_paid'] } },
        orderBy: { id: 'desc' },
        take: 5,
      }),
    ]);
    const general = [
      { key: 'contact', label: { ar: 'تواصل معنا', en: 'Contact us' }, url: this.url({}) },
      ...PARENT_CONTACT_CARDS.map((c) => ({
        key: `card:${c.key}`,
        label: c.label,
        url: this.url({ card: c.key }),
      })),
    ].map((l) => ({ ...l, detail: null }));
    const classLinks = classes.flatMap((s) => {
      const at = local(s.startsAt.getTime(), zone);
      const detail = `${s.student.name} — ${at.date} ${at.time}`;
      return (['reschedule', 'leave', 'session_issue'] as const).map((choice) => ({
        key: `class:${s.id}:${choice}`,
        label: PARENT_CONTACT_CARDS[0]!.choices.find((c) => c.key === choice)!.label,
        url: this.url({ card: 'classes', choice, sessionId: s.id }),
        detail,
      }));
    });
    const billing = PARENT_CONTACT_CARDS.find((c) => c.key === 'billing')!;
    const invoiceLinks = invoices.map((i) => ({
      key: `invoice:${i.id}`,
      label: billing.choices.find((c) => c.key === 'invoice_question')!.label,
      url: this.url({ card: 'billing', choice: 'invoice_question', invoiceId: i.id }),
      detail: i.number ?? `#${i.id}`,
    }));
    return {
      family: { id: family.id, name: family.user.name },
      general,
      classes: classLinks,
      invoices: invoiceLinks,
    };
  }

  // ---------------------------------------------------------------- saved replies

  async replies(all: boolean): Promise<SavedReplyDto[]> {
    const rows = await this.prisma.supportSavedReply.findMany({
      where: all ? {} : { isActive: true },
      orderBy: [{ isActive: 'desc' }, { key: 'asc' }],
    });
    return rows.map(replyDto);
  }

  async createReply(input: Out<typeof savedReplyInputSchema>, actor: AuthUser) {
    try {
      const row = await this.prisma.supportSavedReply.create({
        data: {
          key: input.key,
          titleAr: input.titleAr,
          titleEn: input.titleEn,
          bodyAr: input.bodyAr,
          bodyEn: input.bodyEn,
          link: input.link ? (input.link as Prisma.InputJsonValue) : Prisma.DbNull,
          createdById: actor.id,
          updatedAt: this.clock.now(),
        },
      });
      await this.audit.record({
        actorId: actor.id,
        action: 'created',
        subjectType: 'saved_reply',
        subjectId: row.id,
        after: { key: row.key },
      });
      return replyDto(row);
    } catch (error) {
      throw keyTaken(error);
    }
  }

  async updateReply(id: number, input: Out<typeof updateSavedReplySchema>, actor: AuthUser) {
    if (!(await this.prisma.supportSavedReply.findUnique({ where: { id } }))) throw notFound();
    try {
      const row = await this.prisma.supportSavedReply.update({
        where: { id },
        data: {
          ...(input.key !== undefined ? { key: input.key } : {}),
          ...(input.titleAr !== undefined ? { titleAr: input.titleAr } : {}),
          ...(input.titleEn !== undefined ? { titleEn: input.titleEn } : {}),
          ...(input.bodyAr !== undefined ? { bodyAr: input.bodyAr } : {}),
          ...(input.bodyEn !== undefined ? { bodyEn: input.bodyEn } : {}),
          ...(input.link !== undefined
            ? { link: input.link ? (input.link as Prisma.InputJsonValue) : Prisma.DbNull }
            : {}),
          updatedAt: this.clock.now(),
        },
      });
      await this.audit.record({
        actorId: actor.id,
        action: 'updated',
        subjectType: 'saved_reply',
        subjectId: id,
        after: { fields: Object.keys(input) },
      });
      return replyDto(row);
    } catch (error) {
      throw keyTaken(error);
    }
  }

  /** Archive (D31: reversible, so no confirm) or restore. */
  async setActive(id: number, active: boolean, actor: AuthUser) {
    if (!(await this.prisma.supportSavedReply.findUnique({ where: { id } }))) throw notFound();
    const row = await this.prisma.supportSavedReply.update({
      where: { id },
      data: { isActive: active, updatedAt: this.clock.now() },
    });
    await this.audit.record({
      actorId: actor.id,
      action: active ? 'restored' : 'archived',
      subjectType: 'saved_reply',
      subjectId: id,
    });
    return replyDto(row);
  }

  /** The text to paste: `{link}` = the reply's deep link (with the given class / invoice / child). */
  async render(id: number, q: Out<typeof renderSavedReplySchema>): Promise<RenderedReplyDto> {
    const r = await this.prisma.supportSavedReply.findUnique({ where: { id } });
    if (!r) throw notFound();
    let name = '';
    if (q.familyId) {
      const family = await this.prisma.family.findUnique({
        where: { id: q.familyId },
        include: { user: { select: { name: true } } },
      });
      if (!family) throw notFound();
      name = family.user.name;
    }
    const base = r.link as ContactLink | null;
    const url = base
      ? this.url({
          ...base,
          ...(q.sessionId ? { sessionId: q.sessionId } : {}),
          ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}),
          ...(q.studentId ? { studentId: q.studentId } : {}),
        })
      : null;
    const fill = (body: string) =>
      body
        .replaceAll('{link}', url ?? '')
        .replaceAll('{name}', name)
        .replace(/\s{2,}/g, ' ')
        .trim();
    return { ar: fill(r.bodyAr), en: fill(r.bodyEn), url };
  }

  // ---------------------------------------------------------------- channel report

  /** Requests by origin per week, on behalf (filed by staff), and who files on behalf. */
  async channels(from: string | undefined, to: string | undefined): Promise<SupportChannelsDto> {
    const st = await this.settings.all();
    const zone = st['academy.timezone'];
    const today = local(this.clock.nowMs(), zone).date;
    const end = to ?? today;
    const start = from ?? addDays(end, -55);
    if ((Date.parse(end) - Date.parse(start)) / DAY > 366) {
      throw new ApiException(422, {
        message: 'Choose a period of at most one year.',
        code: 'range_too_long',
        errors: { to: ['Choose a period of at most one year.'] },
      });
    }
    const range = {
      gte: new Date(toUtc(start, '00:00', zone)),
      lt: new Date(toUtc(addDays(end, 1), '00:00', zone)),
    };
    const [tickets, requests] = await Promise.all([
      this.prisma.ticket.findMany({
        where: { createdAt: range },
        select: {
          channel: true,
          createdAt: true,
          reporterId: true,
          reporter: { select: { id: true, name: true, role: { select: { kind: true } } } },
        },
      }),
      this.prisma.sessionRequest.findMany({
        where: { createdAt: range },
        select: {
          createdAt: true,
          requestedBy: { select: { id: true, name: true, role: { select: { kind: true } } } },
        },
      }),
    ]);
    type Item = { origin: SupportRequestOrigin; at: Date; by: { id: number; name: string } | null };
    const items: Item[] = [
      ...tickets.map((t) => ({
        origin: t.channel,
        at: t.createdAt,
        by: t.reporter && STAFF_KINDS.includes(t.reporter.role?.kind ?? '') ? t.reporter : null,
      })),
      ...requests.map((r) => ({
        origin: 'class_request' as const,
        at: r.createdAt,
        by:
          r.requestedBy && STAFF_KINDS.includes(r.requestedBy.role?.kind ?? '')
            ? r.requestedBy
            : null,
      })),
    ];
    const count = (group: Item[]) => {
      const byOrigin = Object.fromEntries(SUPPORT_REQUEST_ORIGINS.map((o) => [o, 0])) as Record<
        SupportRequestOrigin,
        number
      >;
      for (const i of group) byOrigin[i.origin]++;
      return { total: group.length, onBehalf: group.filter((i) => i.by).length, byOrigin };
    };
    const weekOf = (d: Date) => {
      const date = local(d.getTime(), zone).date;
      return addDays(date, 1 - isoWeekday(date));
    };
    const weeks = new Map<string, Item[]>();
    for (const i of items) weeks.set(weekOf(i.at), [...(weeks.get(weekOf(i.at)) ?? []), i]);
    const staff = new Map<number, { user: { id: number; name: string }; count: number }>();
    for (const i of items) {
      if (!i.by) continue;
      const e = staff.get(i.by.id) ?? { user: { id: i.by.id, name: i.by.name }, count: 0 };
      e.count++;
      staff.set(i.by.id, e);
    }
    const total = count(items);
    return {
      from: start,
      to: end,
      total: {
        ...total,
        onBehalfPct: total.total ? Math.round((total.onBehalf / total.total) * 1000) / 10 : null,
      },
      targetPct: ON_BEHALF_TARGET_PCT,
      weeks: [...weeks]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([weekStart, g]) => ({ weekStart, ...count(g) })),
      byStaff: [...staff.values()].sort((a, b) => b.count - a.count),
    };
  }
}

function keyTaken(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ApiException(422, {
      message: 'The given data was invalid.',
      code: 'validation_failed',
      errors: { key: ['This key is already used.'] },
    });
  }
  return error;
}

/** `/support/links`, `/support/saved-replies`, `/support/channels` (docs/32 §7, S5). */
@ApiTags('support')
@Controller('support')
export class SupportOffRampController {
  constructor(private readonly offramp: SupportOffRamp) {}

  @Can('support.view')
  @Get('links')
  @ApiOperation({ summary: 'Deep links to paste for one family (instead of handling on WhatsApp)' })
  async links(
    @ZodQuery(supportLinksQuerySchema) q: Out<typeof supportLinksQuerySchema>,
  ): Promise<{ data: SupportLinksDto }> {
    return { data: await this.offramp.links(q.familyId) };
  }

  @Can('support.view')
  @Get('channels')
  async channels(
    @ZodQuery(supportChannelsQuerySchema) q: Out<typeof supportChannelsQuerySchema>,
  ): Promise<{ data: SupportChannelsDto }> {
    return { data: await this.offramp.channels(q.from, q.to) };
  }

  /** Active replies; `support.manage` also gets the archived ones (`?all=1`). */
  @Can('support.view')
  @Get('saved-replies')
  async list(
    @ZodQuery(listRepliesQuerySchema) q: Out<typeof listRepliesQuerySchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: SavedReplyDto[] }> {
    return {
      data: await this.offramp.replies(q.all && user.permissions.has('support.manage')),
    };
  }

  @Can('support.manage')
  @Post('saved-replies')
  @ApiBody({ schema: jsonSchema(savedReplyInputSchema) })
  async create(
    @ZodBody(savedReplyInputSchema) body: Out<typeof savedReplyInputSchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: SavedReplyDto }> {
    return { data: await this.offramp.createReply(body, user) };
  }

  @Can('support.manage')
  @Patch('saved-replies/:id')
  @ApiBody({ schema: jsonSchema(updateSavedReplySchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateSavedReplySchema) body: Out<typeof updateSavedReplySchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: SavedReplyDto }> {
    return { data: await this.offramp.updateReply(id, body, user) };
  }

  @Can('support.manage')
  @Post('saved-replies/:id/archive')
  @HttpCode(200)
  async archive(
    @Param('id', IdPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: SavedReplyDto }> {
    return { data: await this.offramp.setActive(id, false, user) };
  }

  @Can('support.manage')
  @Post('saved-replies/:id/restore')
  @HttpCode(200)
  async restore(
    @Param('id', IdPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: SavedReplyDto }> {
    return { data: await this.offramp.setActive(id, true, user) };
  }

  @Can('support.view')
  @Post('saved-replies/:id/render')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(renderSavedReplySchema) })
  async render(
    @Param('id', IdPipe) id: number,
    @ZodBody(renderSavedReplySchema) body: Out<typeof renderSavedReplySchema>,
  ): Promise<{ data: RenderedReplyDto }> {
    return { data: await this.offramp.render(id, body) };
  }
}
