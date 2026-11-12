import { Controller, Delete, Get, HttpCode, Module, Param, Post } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { type DeviceDto, registerDeviceSchema } from '@qarabic/shared';
import type { z } from 'zod';
import { AuthModule } from '../auth/auth.module.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Authenticated, CurrentUser } from '../auth/decorators.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import type { DeviceToken } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Most phones a person keeps registered; the oldest is dropped beyond it. */
const MAX_DEVICES = 10;

function present(d: DeviceToken): DeviceDto {
  return {
    id: d.id,
    platform: d.platform,
    appVersion: d.appVersion,
    deviceName: d.deviceName,
    lastSeenAt: d.lastSeenAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
  };
}

/**
 * `/me/devices` (docs/17 §5): the signed-in person's phones for push notifications. Own rows only
 * (another person's id = 404); the token itself is never returned. Registering a known token moves
 * it to the current person (a shared phone after a sign-in) and refreshes `lastSeenAt`.
 */
@ApiTags('account')
@Controller('me/devices')
export class DevicesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  @Authenticated()
  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<{ data: DeviceDto[] }> {
    const rows = await this.prisma.deviceToken.findMany({
      where: { userId: user.id },
      orderBy: { lastSeenAt: 'desc' },
    });
    return { data: rows.map(present) };
  }

  @Authenticated()
  @Post()
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(registerDeviceSchema) })
  async register(
    @ZodBody(registerDeviceSchema) body: z.output<typeof registerDeviceSchema>,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: DeviceDto }> {
    const now = this.clock.now();
    const fields = {
      userId: user.id,
      platform: body.platform,
      appVersion: body.appVersion ?? null,
      deviceName: body.deviceName ?? null,
      lastSeenAt: now,
    };
    const row = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.deviceToken.upsert({
        where: { token: body.token },
        create: { token: body.token, ...fields, createdAt: now },
        update: fields,
      });
      const extra = await tx.deviceToken.findMany({
        where: { userId: user.id },
        orderBy: { lastSeenAt: 'desc' },
        skip: MAX_DEVICES,
        select: { id: true },
      });
      if (extra.length)
        await tx.deviceToken.deleteMany({ where: { id: { in: extra.map((e) => e.id) } } });
      return saved;
    });
    return { data: present(row) };
  }

  /** Unregister (sign-out on the phone). */
  @Authenticated()
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', IdPipe) id: number, @CurrentUser() user: AuthUser): Promise<void> {
    const gone = await this.prisma.deviceToken.deleteMany({ where: { id, userId: user.id } });
    if (gone.count === 0) throw notFound();
  }
}

@Module({ imports: [AuthModule], controllers: [DevicesController] })
export class DevicesModule {}
