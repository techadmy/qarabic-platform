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
import { CrmConfig, PUBLIC_COURSES_PER_MINUTE } from './crm.config.js';
import { crmError } from './errors.js';

const CRM_THROTTLE_KEY = 'qarabic:crm-throttle';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Laravel limiters of the CRM routes (`AppServiceProvider`): `class-request`, `web-leads`, `crm-referrals`, `throttle:60,1`. */
type Policy = 'trial-form' | 'web-leads' | 'referrals' | 'public-courses';

/** Rate limit of a CRM route (its own guard, so the shared policies stay untouched). */
export const CrmThrottle = (policy: Policy): MethodDecorator =>
  SetMetadata(CRM_THROTTLE_KEY, policy);

@Injectable()
export class CrmThrottleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiterService,
    private readonly config: CrmConfig,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const policy = this.reflector.get<Policy | undefined>(CRM_THROTTLE_KEY, ctx.getHandler());
    if (!policy) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const user = (req as AuthedRequest).auth?.user.id;
    const [key, max, window] = ((): [string, number, number] => {
      switch (policy) {
        case 'trial-form':
          return [`crm-form:${req.ip}`, this.config.classRequestPerMinute, MINUTE];
        case 'web-leads':
          return [`crm-web-leads:${req.ip}`, this.config.webLeadsPerMinute, MINUTE];
        case 'referrals':
          return [`crm-referral:${user ?? req.ip}`, this.config.referralsPerHour, HOUR];
        case 'public-courses':
          return [`crm-courses:${req.ip}`, PUBLIC_COURSES_PER_MINUTE, MINUTE];
      }
    })();
    const wait = this.limiter.hit(key, max, window);
    if (wait > 0) {
      ctx.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(wait));
      throw crmError(HttpStatus.TOO_MANY_REQUESTS, 'too_many_requests');
    }
    return true;
  }
}
