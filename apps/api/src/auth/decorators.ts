import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@qarabic/shared';
import type { AuthedRequest, AuthUser } from './auth.types.js';

export const PUBLIC_KEY = 'qarabic:public';
export const AUTHENTICATED_KEY = 'qarabic:authenticated';
export const PERMISSIONS_KEY = 'qarabic:permissions';
export const ANY_PERMISSION_KEY = 'qarabic:any-permission';
export const SKIP_CSRF_KEY = 'qarabic:skip-csrf';
export const RATE_LIMIT_KEY = 'qarabic:rate-limit';

/** No session needed. The global guard denies everything else by default. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/** Any signed-in user, no specific permission (only for "my own account" endpoints such as `auth/me`). */
export const Authenticated = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHENTICATED_KEY, true);

/** Signed-in user holding every listed permission (403 otherwise). */
export const Can = (
  ...permissions: [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator => SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Signed-in user holding at least one of the listed permissions (403 otherwise), e.g. staff with
 * `families.view` or a teacher with `sessions.conduct` for their own rows. The handler still
 * applies the row scope.
 */
export const CanAny = (
  ...permissions: [Permission, Permission, ...Permission[]]
): MethodDecorator & ClassDecorator => SetMetadata(ANY_PERMISSION_KEY, permissions);

/** Signed server-to-server callbacks (webhooks) only: they cannot carry the browser CSRF token. */
export const SkipCsrf = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_CSRF_KEY, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.auth) throw new Error('CurrentUser used on a route without a session.');
    return req.auth.user;
  },
);
