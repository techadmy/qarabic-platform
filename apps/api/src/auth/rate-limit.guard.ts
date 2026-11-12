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
import type { AuthedRequest } from './auth.types.js';
import { RATE_LIMIT_KEY } from './decorators.js';
import { RateLimiterService } from './rate-limiter.service.js';

type Policy =
  | 'login'
  | 'password'
  | 'search'
  | 'feedback-create'
  | 'feedback-comment'
  | 'attachments'
  | 'webhook'
  | 'clock';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const userKey = (req: Request) => String((req as AuthedRequest).auth?.user.id ?? req.ip);

function emailOf(req: Request): string {
  const body: unknown = req.body;
  const raw =
    typeof body === 'object' && body !== null && 'email' in body && typeof body.email === 'string'
      ? body.email
      : '';
  return cleanCredential(raw).toLowerCase();
}

/** Same budgets as the Laravel API (AppServiceProvider): login 5/min per email+IP and 20/min per IP. */
/** `[key, max, window]` (window: one minute unless given). */
const POLICIES: Record<
  Policy,
  (req: Request) => Array<[key: string, max: number, windowMs?: number]>
> = {
  login: (req) => [
    [`login:${emailOf(req)}|${req.ip}`, 5],
    [`login-ip:${req.ip}`, 20],
  ],
  password: (req) => [[`password:${req.ip}`, 5]],
  // Instant-search lists fire as the user types (debounced): Laravel `throttle:120,1`.
  search: (req) => [[`search:${req.ip}`, 120]],
  // N4 «تواصل معنا» (Laravel `feedback-create` / `feedback-comment`): per user.
  'feedback-create': (req) => [
    [`feedback-create-h:${userKey(req)}`, 10, HOUR],
    [`feedback-create-d:${userKey(req)}`, 30, DAY],
  ],
  'feedback-comment': (req) => [[`feedback-comment:${userKey(req)}`, 30, HOUR]],
  attachments: (req) => [[`attachments:${userKey(req)}`, 120]],
  // Signed webhooks (WhatsApp): per IP.
  webhook: (req) => [[`webhook:${req.ip}`, 300]],
  // N7 attendance check-in / check-out: Laravel `throttle:30,1`.
  clock: (req) => [[`clock:${req.ip}`, 30]],
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
    for (const [key, max, windowMs] of POLICIES[policy](req)) {
      wait = Math.max(wait, this.limiter.hit(key, max, windowMs ?? MINUTE));
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
