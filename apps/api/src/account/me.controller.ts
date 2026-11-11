import { Controller, Get, HttpStatus, Patch, Req } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { type Me, updateMeSchema } from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { toMe } from '../auth/auth.service.js';
import type { AuthedRequest, AuthUser } from '../auth/auth.types.js';
import { SESSION_COOKIE } from '../auth/cookies.js';
import { Authenticated, CurrentUser } from '../auth/decorators.js';
import { PasswordsService } from '../auth/passwords.service.js';
import { RateLimiterService } from '../auth/rate-limiter.service.js';
import { SessionsService } from '../auth/sessions.service.js';
import { ApiException, validationError } from '../common/errors.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * `/me`: the signed-in user's own account (D68, D74). Only that user is ever touched: there is no
 * user id in the route or the body.
 */
@ApiTags('account')
@Controller('me')
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordsService,
    private readonly sessions: SessionsService,
    private readonly limiter: RateLimiterService,
    private readonly audit: AuditService,
  ) {}

  @Authenticated()
  @Get()
  me(@CurrentUser() user: AuthUser): Me {
    return toMe(user);
  }

  /**
   * Name, language, time zone and phone. A password change needs the current password, is rate
   * limited like the other password routes, and signs out every other session.
   */
  @Authenticated()
  @Patch()
  @ApiBody({ schema: jsonSchema(updateMeSchema) })
  async update(
    @ZodBody(updateMeSchema) body: z.output<typeof updateMeSchema>,
    @Req() req: AuthedRequest,
  ): Promise<Me> {
    const { user, sessionId } = req.auth!;
    let passwordHash: string | undefined;
    if (body.password !== undefined) {
      if (this.limiter.hit(`me-password:${user.id}`, 5, 60_000) > 0) {
        throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, {
          message: 'Too many attempts. Please try again later.',
          code: 'too_many_requests',
        });
      }
      const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      if (!(await this.passwords.verify(row.passwordHash, body.currentPassword ?? ''))) {
        throw validationError(
          { currentPassword: ['The current password is not correct.'] },
          'The current password is not correct.',
          'wrong_password',
        );
      }
      passwordHash = await this.passwords.hash(body.password);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.locale !== undefined ? { locale: body.locale } : {}),
          ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(passwordHash ? { passwordHash } : {}),
        },
      });
      if (passwordHash) {
        await tx.session.deleteMany({ where: { userId: user.id, id: { not: sessionId } } });
        await this.audit.record(
          { actorId: user.id, action: 'password_changed', subjectType: 'user', subjectId: user.id },
          tx,
        );
      }
    });
    const token = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE]!;
    const fresh = await this.sessions.resolve(token);
    return toMe(fresh!.user);
  }
}
