import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { AuthedRequest } from '../auth/auth.types.js';
import { RateLimiterService } from '../auth/rate-limiter.service.js';
import { ApiException } from '../common/errors.js';

const BILLING_THROTTLE_KEY = 'qarabic:billing-throttle';
const MINUTE = 60_000;

/** Laravel limiters (`AppServiceProvider`): `checkout` 10/min per user, `payment-webhook` 300/min per IP. */
type Policy = 'checkout' | 'payment-webhook';

/** Rate limit of a billing route (its own guard, so the shared policies stay untouched). */
export const BillingThrottle = (policy: Policy): MethodDecorator =>
  SetMetadata(BILLING_THROTTLE_KEY, policy);

@Injectable()
export class BillingThrottleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiterService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const policy = this.reflector.get<Policy | undefined>(BILLING_THROTTLE_KEY, ctx.getHandler());
    if (!policy) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const user = (req as AuthedRequest).auth?.user.id;
    const [key, max] =
      policy === 'checkout'
        ? [`checkout:${user ?? req.ip}`, 10]
        : [`payment-webhook:${req.ip}`, 300];
    const wait = this.limiter.hit(key, max, MINUTE);
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
