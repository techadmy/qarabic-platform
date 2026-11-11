import type { CookieOptions, Response } from 'express';
import type { Env } from '../config/env.js';

export const SESSION_COOKIE = 'qarabic_session';
export const CSRF_COOKIE = 'XSRF-TOKEN';
export const CSRF_HEADER = 'x-xsrf-token';

function base(env: Env): CookieOptions {
  return {
    path: '/',
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

/** httpOnly session cookie. `maxAge` only when "remember me": otherwise it dies with the browser. */
export function setSessionCookie(res: Response, env: Env, token: string, maxAgeMs?: number): void {
  res.cookie(SESSION_COOKIE, token, {
    ...base(env),
    httpOnly: true,
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  });
}

export function clearSessionCookie(res: Response, env: Env): void {
  res.clearCookie(SESSION_COOKIE, { ...base(env), httpOnly: true });
}

/** Readable by the web app's JS, which echoes it in the `X-XSRF-TOKEN` header (double submit). */
export function setCsrfCookie(res: Response, env: Env, token: string): void {
  res.cookie(CSRF_COOKIE, token, { ...base(env), httpOnly: false });
}
