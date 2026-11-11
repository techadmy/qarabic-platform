import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiException } from '../common/errors.js';
import { ENV, type Env } from '../config/env.js';
import { CSRF_COOKIE, CSRF_HEADER } from './cookies.js';
import { SKIP_CSRF_KEY } from './decorators.js';
import { safeEqual, verifyCsrf } from './tokens.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF check (as Laravel Sanctum SPA): every unsafe request must echo the
 * `XSRF-TOKEN` cookie in the `X-XSRF-TOKEN` header, and the token must carry our signature.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE.has(req.method)) return true;
    if (
      this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [ctx.getHandler(), ctx.getClass()])
    ) {
      return true;
    }
    const cookies = req.cookies as Record<string, string | undefined>;
    const cookie = cookies[CSRF_COOKIE];
    const header = req.get(CSRF_HEADER);
    if (
      cookie &&
      header &&
      safeEqual(cookie, header) &&
      verifyCsrf(this.env.SESSION_SECRET, header)
    ) {
      return true;
    }
    throw new ApiException(HttpStatus.FORBIDDEN, {
      message: 'CSRF token mismatch. Reload the page and try again.',
      code: 'csrf_mismatch',
    });
  }
}
