import type { z } from 'zod';

/**
 * API client for the NestJS API (`/api/v1`). Sessions live in an httpOnly cookie, so every request
 * sends credentials. Unsafe methods carry the CSRF token: the API sets an `XSRF-TOKEN` cookie
 * (readable by JS) and expects it back in the `X-XSRF-TOKEN` header (double-submit cookie).
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');
export const API_PREFIX = '/api/v1';

const CSRF_COOKIE = 'XSRF-TOKEN';
const CSRF_HEADER = 'X-XSRF-TOKEN';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

export function isApiError(error: unknown, status?: number): error is ApiError {
  return error instanceof ApiError && (status === undefined || error.status === status);
}

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

let csrfFromBody: string | null = null;

/** Returns the CSRF token, fetching `GET /auth/csrf` first when the cookie is missing. */
export async function ensureCsrfToken(force = false): Promise<string | null> {
  const existing = readCookie(CSRF_COOKIE);
  if (existing && !force) return existing;
  const res = await fetch(`${API_URL}${API_PREFIX}/auth/csrf`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  // The cookie is the source of truth; a token in the body is a fallback for when the API
  // lives on another site and its cookie cannot be read by this page.
  const body: unknown = await res.json().catch(() => null);
  if (
    body &&
    typeof body === 'object' &&
    'csrfToken' in body &&
    typeof body.csrfToken === 'string'
  ) {
    csrfFromBody = body.csrfToken;
  }
  return readCookie(CSRF_COOKIE) ?? csrfFromBody;
}

type RequestOptions<S extends z.ZodType | undefined> = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  schema?: S;
  signal?: AbortSignal;
};

type Result<S> = S extends z.ZodType ? z.infer<S> : unknown;

async function send(path: string, method: string, body: unknown, signal?: AbortSignal) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!SAFE_METHODS.has(method)) {
    const token = await ensureCsrfToken();
    if (token) headers[CSRF_HEADER] = token;
  }
  return fetch(`${API_URL}${API_PREFIX}${path}`, {
    method,
    credentials: 'include',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
}

export async function apiFetch<S extends z.ZodType | undefined = undefined>(
  path: string,
  { method = 'GET', body, schema, signal }: RequestOptions<S> = {},
): Promise<Result<S>> {
  let res = await send(path, method, body, signal);
  // 419: the CSRF token expired or rotated. Fetch a fresh one and retry once.
  if (res.status === 419 && !SAFE_METHODS.has(method)) {
    await ensureCsrfToken(true);
    res = await send(path, method, body, signal);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return (schema ? schema.parse(data) : data) as Result<S>;
}
