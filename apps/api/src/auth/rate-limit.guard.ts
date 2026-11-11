import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { cleanCredential } from '@qarabic/shared';
import type { Request, Response } from 'express';
import { ApiException } from '../common/errors.js';
import { RATE_LIMIT_KEY } from './decorators.js';
import { RateLimiterService } from './rate-limiter.service.js';

type Policy = 'login' | 'password';

const MINUTE = 60_000;

function emailOf(req: Request): string {
  const body: unknown = req.body;
  const raw =
    typeof body === 'object' && body !== null && 'email' in body && typeof body.email === 'string'
      ? body.email
      : '';
  return cleanCredential(raw).toLowerCase();
}

/** Same budgets as the Laravel API (AppServiceProvider): login 5/min per email+IP and 20/min per IP. */
const POLICIES: Record<Policy, (req: Request) => Array<[key: string, max: number]>> = {
  login: (req) => [
    [`login:${emailOf(req)}|${req.ip}`, 5],
    [`login-ip:${req.ip}`, 20],
  ],
  password: (req) => [[`password:${req.ip}`, 5]],
};

export const RateLimit = (policy: Policy): MethodDecorator => SetMetadata(RATE_LIMIT_KEY, policy);

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiterService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const policy = this.reflector.get<Policy | undefined>(RATE_LIMIT_KEY, ctx.getHandler());
    if (!policy) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    let wait = 0;
    for (const [key, max] of POLICIES[policy](req)) {
      wait = Math.max(wait, this.limiter.hit(key, max, MINUTE));
    }
    if (wait > 0) {
      ctx.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(wait));
      throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, {
        message: 'Too many attempts. Please try again later.',
        code: 'too_many_requests',
      });
    }
    return true;
  }
}
