import { Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { forgotPasswordSchema, loginSchema, type Me, resetPasswordSchema } from '@qarabic/shared';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { ENV, type Env } from '../config/env.js';
import { AuthService, toMe } from './auth.service.js';
import type { AuthedRequest, AuthUser } from './auth.types.js';
import { clearSessionCookie, SESSION_COOKIE, setCsrfCookie, setSessionCookie } from './cookies.js';
import { Authenticated, CurrentUser, Public } from './decorators.js';
import { RateLimit } from './rate-limit.guard.js';
import { SessionsService } from './sessions.service.js';
import { signCsrf } from './tokens.js';

const GENERIC_FORGOT =
  'If an active account uses this email, a password reset link has been sent to it.';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Get('csrf')
  @ApiOperation({ summary: 'Issue the XSRF-TOKEN cookie (call before the first unsafe request)' })
  csrf(@Res({ passthrough: true }) res: Response): { csrfToken: string } {
    const csrfToken = signCsrf(this.env.SESSION_SECRET);
    setCsrfCookie(res, this.env, csrfToken);
    return { csrfToken };
  }

  @Public()
  @RateLimit('login')
  @Post('login')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(loginSchema) })
  async login(
    @ZodBody(loginSchema) body: z.output<typeof loginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Me> {
    const { token, ttlMs, remember } = await this.auth.login(body, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    // No session fixation: a session cookie the browser already had is dropped.
    const previous = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
    if (previous) await this.sessions.destroyToken(previous);
    setSessionCookie(res, this.env, token, remember ? ttlMs : undefined);
    // New session, new CSRF token.
    setCsrfCookie(res, this.env, signCsrf(this.env.SESSION_SECRET));
    const auth = await this.sessions.resolve(token);
    return toMe(auth!.user);
  }

  @Authenticated()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.destroy(req.auth!.sessionId);
    clearSessionCookie(res, this.env);
    setCsrfCookie(res, this.env, signCsrf(this.env.SESSION_SECRET));
  }

  @Authenticated()
  @Get('me')
  me(@CurrentUser() user: AuthUser): Me {
    return toMe(user);
  }

  @Public()
  @RateLimit('password')
  @Post('forgot-password')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(forgotPasswordSchema) })
  async forgot(
    @ZodBody(forgotPasswordSchema) body: z.output<typeof forgotPasswordSchema>,
  ): Promise<{ message: string }> {
    await this.auth.forgotPassword(body);
    return { message: GENERIC_FORGOT };
  }

  @Public()
  @RateLimit('password')
  @Post('reset-password')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(resetPasswordSchema) })
  async reset(
    @ZodBody(resetPasswordSchema) body: z.output<typeof resetPasswordSchema>,
  ): Promise<{ message: string }> {
    await this.auth.resetPassword(body);
    return { message: 'Your password has been reset. Please sign in.' };
  }
}
