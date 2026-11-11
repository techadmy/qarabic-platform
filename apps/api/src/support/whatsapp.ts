import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public, SkipCsrf } from '../auth/decorators.js';
import { RateLimit } from '../auth/rate-limit.guard.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { ApiException, notFound } from '../common/errors.js';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DAY, MINUTE } from '../schedule/time.js';
import { SupportContext } from './policy.js';
import { TicketsService } from './tickets.service.js';

/** Messages from the same sender within N minutes join their last open WhatsApp ticket. */
const GROUP_MINUTES = 30;

/**
 * WhatsApp Cloud API intake settings (docs/22 §5.2, D102), from the environment. Off by default;
 * tests switch it with `configure()` (like the Zoom driver). No credentials live in the code.
 */
@Injectable()
export class WhatsAppConfig {
  enabled: boolean;
  allowUnknown: boolean;
  appSecret: string | null;
  verifyToken: string | null;
  private readonly initial: Pick<
    WhatsAppConfig,
    'enabled' | 'allowUnknown' | 'appSecret' | 'verifyToken'
  >;

  constructor(@Inject(ENV) env: Env) {
    this.enabled = env.FEEDBACK_WHATSAPP_ENABLED;
    this.allowUnknown = env.FEEDBACK_WHATSAPP_ALLOW_UNKNOWN;
    this.appSecret = env.WHATSAPP_APP_SECRET ?? null;
    this.verifyToken = env.WHATSAPP_VERIFY_TOKEN ?? null;
    this.initial = {
      enabled: this.enabled,
      allowUnknown: this.allowUnknown,
      appSecret: this.appSecret,
      verifyToken: this.verifyToken,
    };
  }

  /** Tests only. `reset()` goes back to the environment's values. */
  configure(
    values: Partial<Pick<WhatsAppConfig, 'enabled' | 'allowUnknown' | 'appSecret' | 'verifyToken'>>,
  ): void {
    Object.assign(this, values);
  }

  reset(): void {
    Object.assign(this, this.initial);
  }
}

/** `sha256=` + HMAC-SHA256(app secret, raw body), Meta's `X-Hub-Signature-256`. */
export function signWebhook(body: Buffer | string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const digits = (value: string) => value.replace(/\D+/g, '');

/**
 * Whether a stored phone and Meta's international digits are the same number (Laravel
 * `PhoneMatcher::same`): exact digits, or the national part when the stored one is local (`0…`).
 */
export function samePhone(wa: string, stored: string): boolean {
  let s = digits(stored);
  if (s.startsWith('00')) s = s.slice(2);
  if (s.length < 9) return false;
  if (s === wa) return true;
  const national = s.replace(/^0+/, '');
  return s.startsWith('0') && national.length >= 9 && wa.endsWith(national);
}

interface WaMessage {
  id?: unknown;
  from?: unknown;
  type?: unknown;
  timestamp?: unknown;
  text?: { body?: unknown };
  image?: { caption?: unknown };
}

/**
 * Turns one WhatsApp message into a ticket or a reply on one (Laravel `ProcessWhatsAppMessage`).
 * Runs inline (no queue yet). Out of scope for now: sending replies and downloading media through
 * the Graph API (no Meta credentials, B50) — a media message is recorded with a placeholder and an
 * internal note saying the file was not fetched.
 */
@Injectable()
export class WhatsAppIntake {
  private readonly logger = new Logger(WhatsAppIntake.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly tickets: TicketsService,
    private readonly context: SupportContext,
    private readonly config: WhatsAppConfig,
    @Inject(ENV) private readonly env: Env,
  ) {}

  hashPhone(waDigits: string): string {
    return createHmac('sha256', this.env.SESSION_SECRET).update(`wa:${waDigits}`).digest('hex');
  }

  /** The one active user behind the number, or null (none or several). */
  async matchUser(waDigits: string): Promise<AuthUser | null> {
    if (waDigits.length < 9) return null;
    const users = await this.prisma.user.findMany({
      where: { isActive: true, archivedAt: null, phone: { not: null } },
      select: { id: true, phone: true },
    });
    const ids = users.filter((u) => samePhone(waDigits, u.phone!)).map((u) => u.id);
    return ids.length === 1 ? this.context.loadUser(ids[0]!) : null;
  }

  /** Records each message once (Meta retries are ignored) and processes the new ones. */
  async receive(payload: unknown): Promise<void> {
    const entries = (payload as { entry?: unknown })?.entry;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const changes = (entry as { changes?: unknown })?.changes;
      for (const change of Array.isArray(changes) ? changes : []) {
        const c = change as { field?: unknown; value?: { messages?: unknown } };
        if (c.field !== 'messages') continue;
        const messages = c.value?.messages;
        for (const m of Array.isArray(messages) ? messages : []) {
          // `statuses[]` (sent / delivered / read) are acknowledged and ignored.
          await this.record((m ?? {}) as WaMessage).catch((error: unknown) => {
            this.logger.error(`WhatsApp message failed: ${(error as Error).message}`);
          });
        }
      }
    }
  }

  private async record(m: WaMessage): Promise<void> {
    const id = typeof m.id === 'string' ? m.id : '';
    const from = digits(typeof m.from === 'string' ? m.from : '');
    if (!id || !from || id.length > 191) return;
    const type = ['text', 'image', 'audio', 'document'].includes(String(m.type))
      ? String(m.type)
      : 'other';
    const ts =
      typeof m.timestamp === 'string' && /^\d+$/.test(m.timestamp)
        ? Number(m.timestamp) * 1000
        : null;
    const now = this.clock.now();
    const inserted = await this.prisma.whatsAppInboundMessage.createMany({
      data: [
        {
          waMessageId: id,
          fromHash: this.hashPhone(from),
          type,
          status: 'received',
          receivedAt: ts ? new Date(ts) : now,
          createdAt: now,
          updatedAt: now,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return; // a Meta retry of a message we already have
    const row = await this.prisma.whatsAppInboundMessage.findUniqueOrThrow({
      where: { waMessageId: id },
    });
    await this.process(row.id, m, from);
  }

  private async process(inboundId: number, m: WaMessage, from: string): Promise<void> {
    const done = (data: {
      status: string;
      userId?: number | null;
      ticketId?: number | null;
      error?: string | null;
    }) =>
      this.prisma.whatsAppInboundMessage.update({
        where: { id: inboundId },
        data: { ...data, updatedAt: this.clock.now() },
      });
    const user = await this.matchUser(from);
    if (!user && !this.config.allowUnknown) {
      await done({ status: 'ignored_unknown' });
      return;
    }
    const type = String(m.type);
    if (!['text', 'image', 'audio'].includes(type)) {
      // Laravel replies that only text, images and voice notes are accepted (sending: later).
      await done({ status: 'ignored_type', userId: user?.id ?? null });
      return;
    }
    const raw = type === 'text' ? m.text?.body : type === 'image' ? m.image?.caption : '';
    const text = (typeof raw === 'string' ? raw : '').trim();
    const placeholder = type === 'image' ? '(صورة عبر واتساب)' : '(رسالة صوتية عبر واتساب)';
    const mediaNote =
      type === 'text'
        ? null
        : 'The WhatsApp file was not downloaded (media download is not enabled yet).';
    const hash = this.hashPhone(from);
    const label = user ? null : 'WhatsApp';
    const actor = { user, label };

    const target = await this.findTarget(user, hash, text);
    if (target) {
      await this.prisma.$transaction(async (tx) => {
        await this.tickets.addRow(tx, target.id, actor, 'comment', text || placeholder, false);
        if (mediaNote)
          await this.tickets.addRow(
            tx,
            target.id,
            { user: null, label: 'WhatsApp' },
            'system',
            mediaNote,
            true,
          );
        await tx.ticket.update({
          where: { id: target.id },
          data: { whatsappWindowUntil: new Date(this.clock.nowMs() + DAY) },
        });
        await this.tickets.reporterReplied(tx, target, actor);
      });
      await done({
        status: 'appended',
        userId: user?.id ?? null,
        ticketId: target.id,
        error: mediaNote ? 'media not downloaded' : null,
      });
      return;
    }
    const ticketId = await this.tickets.create(
      user,
      {
        type: 'bug',
        description: text.length >= 1 ? text : placeholder,
        context: { portal: 'whatsapp' },
        contactPhone: from,
        contactHash: hash,
      },
      'whatsapp',
    );
    if (mediaNote) {
      await this.prisma.$transaction((tx) =>
        this.tickets.addRow(
          tx,
          ticketId,
          { user: null, label: 'WhatsApp' },
          'system',
          mediaNote,
          true,
        ),
      );
    }
    await done({
      status: 'ticket_created',
      userId: user?.id ?? null,
      ticketId,
      error: mediaNote ? 'media not downloaded' : null,
    });
  }

  /** "#12 …" → the sender's open ticket 12; else their needs_info one; else a new one within 30 min. */
  private async findTarget(user: AuthUser | null, hash: string, text: string) {
    const own = user ? { reporterId: user.id } : { reporterId: null, contactHash: hash };
    const ref = /^#(\d{1,9})\b/u.exec(text);
    if (ref) {
      const t = await this.prisma.ticket.findFirst({ where: { ...own, id: Number(ref[1]) } });
      if (t && !['verified', 'wont_fix'].includes(t.status)) return t;
    }
    const needsInfo = await this.prisma.ticket.findFirst({
      where: { ...own, status: 'needs_info' },
      orderBy: { id: 'desc' },
    });
    if (needsInfo) return needsInfo;
    return this.prisma.ticket.findFirst({
      where: {
        ...own,
        channel: 'whatsapp',
        status: 'new',
        updatedAt: { gte: new Date(this.clock.nowMs() - GROUP_MINUTES * MINUTE) },
      },
      orderBy: { id: 'desc' },
    });
  }
}

/**
 * `/webhooks/whatsapp` (docs/22 §5.2, D102). While `FEEDBACK_WHATSAPP_ENABLED` is off both routes
 * answer 404. GET = Meta's subscription check (verify token); POST = events signed with the app
 * secret (`X-Hub-Signature-256` over the raw body, constant-time compare), 401 otherwise.
 */
@ApiExcludeController()
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(
    private readonly config: WhatsAppConfig,
    private readonly intake: WhatsAppIntake,
  ) {}

  @Public()
  @RateLimit('webhook')
  @Get()
  verify(@Query() query: Record<string, unknown>, @Res() res: Response): void {
    if (!this.config.enabled) throw notFound();
    const token = this.config.verifyToken ?? '';
    const given = typeof query['hub.verify_token'] === 'string' ? query['hub.verify_token'] : '';
    if (query['hub.mode'] !== 'subscribe' || !token || !safeEqual(token, given)) {
      throw new ApiException(HttpStatus.FORBIDDEN, { message: 'Forbidden.', code: 'forbidden' });
    }
    const challenge = typeof query['hub.challenge'] === 'string' ? query['hub.challenge'] : '';
    res.status(200).type('text/plain').send(challenge.slice(0, 200));
  }

  @Public()
  @SkipCsrf()
  @RateLimit('webhook')
  @Post()
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }): Promise<{ ok: true }> {
    if (!this.config.enabled) throw notFound();
    const secret = this.config.appSecret ?? '';
    const given = req.get('x-hub-signature-256') ?? '';
    const raw = req.rawBody;
    if (!secret || !given || !raw || !safeEqual(signWebhook(raw, secret), given)) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        message: 'Invalid signature.',
        code: 'invalid_signature',
      });
    }
    await this.intake.receive(req.body);
    return { ok: true };
  }
}
