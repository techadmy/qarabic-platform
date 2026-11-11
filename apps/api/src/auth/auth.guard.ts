import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { ApiException } from '../common/errors.js';
import { ENV, type Env } from '../config/env.js';
import type { AuthedRequest } from './auth.types.js';
import { clearSessionCookie, SESSION_COOKIE } from './cookies.js';
import {
  ANY_PERMISSION_KEY,
  AUTHENTICATED_KEY,
  PERMISSIONS_KEY,
  PUBLIC_KEY,
} from './decorators.js';
import { SessionsService } from './sessions.service.js';

const forbidden = () =>
  new ApiException(HttpStatus.FORBIDDEN, {
    message: 'You do not have permission to do this.',
    code: 'forbidden',
  });

/**
 * Deny by default: a route is open only with `@Public()`. Every other route needs a session, and
 * then `@Can(...)` (every listed permission), `@CanAny(...)` (one of them) or `@Authenticated()` (own account). A route with neither is a
 * bug: it answers 403 and is caught by the route coverage test.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
    const auth = token ? await this.sessions.resolve(token) : null;
    if (!auth) {
      if (token) clearSessionCookie(ctx.switchToHttp().getResponse<Response>(), this.env);
      throw new ApiException(HttpStatus.UNAUTHORIZED, {
        message: 'Unauthenticated.',
        code: 'unauthenticated',
      });
    }
    req.auth = auth;

    const needed = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, targets);
    if (needed) {
      if (needed.every((p) => auth.user.permissions.has(p))) return true;
      throw forbidden();
    }
    const any = this.reflector.getAllAndOverride<string[] | undefined>(ANY_PERMISSION_KEY, targets);
    if (any) {
      if (any.some((p) => auth.user.permissions.has(p))) return true;
      throw forbidden();
    }
    if (this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, targets)) return true;

    this.logger.error(`Route without @Public/@Can/@Authenticated: ${req.method} ${req.path}`);
    throw forbidden();
  }
}
