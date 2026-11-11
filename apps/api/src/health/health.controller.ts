import { Controller, Get, HttpStatus } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators.js';
import { ApiException } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** For uptime monitors: statuses only, no details. */
  @Public()
  @Get()
  async health(): Promise<{ status: 'ok'; db: 'ok' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, {
        message: 'Database unavailable.',
        code: 'db_down',
      });
    }
    return { status: 'ok', db: 'ok' };
  }
}
