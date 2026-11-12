import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  type NotificationDto,
  notificationListQuerySchema,
  type NotificationListResponse,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Authenticated, CurrentUser } from '../auth/decorators.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { IdPipe } from '../common/id.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * `/me/notifications`: the bell in the top bar (Laravel `notifications`, database channel). Only
 * the signed-in user's own rows: another user's id answers 404.
 */
@ApiTags('account')
@Controller('me/notifications')
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Newest first (unread first is the client's choice); `meta.unread` is the badge count. */
  @Authenticated()
  @Get()
  async index(
    @ZodQuery(notificationListQuerySchema) q: z.output<typeof notificationListQuerySchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<NotificationListResponse> {
    const [rows, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId: user.id, ...(q.unread ? { readAt: null } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit,
      }),
      this.prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    ]);
    return {
      data: rows.map((r): NotificationDto => ({
        id: r.id,
        kind: r.kind,
        event: r.event,
        data: (r.data ?? {}) as Record<string, unknown>,
        readAt: r.readAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      meta: { unread },
    };
  }

  /** Marks every unread row read. */
  @Authenticated()
  @Post('read-all')
  @HttpCode(200)
  async readAll(@CurrentUser() user: AuthUser): Promise<{ data: { updated: number } }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: this.clock.now() },
    });
    return { data: { updated: count } };
  }

  /** Marks one row read (idempotent). */
  @Authenticated()
  @Post(':id/read')
  @HttpCode(204)
  async read(@Param('id', IdPipe) id: number, @CurrentUser() user: AuthUser): Promise<void> {
    const row = await this.prisma.notification.findFirst({ where: { id, userId: user.id } });
    if (!row) throw notFound();
    if (!row.readAt) {
      await this.prisma.notification.update({ where: { id }, data: { readAt: this.clock.now() } });
    }
  }
}
