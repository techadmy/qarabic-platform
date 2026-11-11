import { HttpResponse } from 'msw';
import { MOCK_USERS } from './data';

const SESSION_KEY = 'qarabic.mock.session';
export const CSRF_TOKEN = 'mock-csrf-token';

let memorySession: number | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function getSessionUserId(): number | null {
  const stored = storage()?.getItem(SESSION_KEY);
  if (stored) return Number(stored);
  return memorySession;
}

export function setSessionUserId(id: number | null) {
  memorySession = id;
  const s = storage();
  if (!s) return;
  if (id === null) s.removeItem(SESSION_KEY);
  else s.setItem(SESSION_KEY, String(id));
}

export function currentUser() {
  const id = getSessionUserId();
  return MOCK_USERS.find((u) => u.id === id) ?? null;
}

export function csrfOk(request: Request) {
  return request.headers.get('X-XSRF-TOKEN') === CSRF_TOKEN;
}

export function apiError(
  status: number,
  code: string,
  message: string,
  errors?: Record<string, string[]>,
  data?: Record<string, unknown>,
) {
  return HttpResponse.json(
    { message, code, ...(errors ? { errors } : {}), ...(data ? { data } : {}) },
    { status },
  );
}
export const csrfFailed = () =>
  apiError(403, 'csrf_mismatch', 'CSRF token mismatch. Reload the page and try again.');
export const unauthenticated = () => apiError(401, 'unauthenticated', 'Unauthenticated.');
export const forbidden = () => apiError(403, 'forbidden', 'Forbidden.');
export const notFound = () => apiError(404, 'not_found', 'Not found.');

/** zod issues → the API's 422 `validation_failed` body (`errors["permissions.1"]`). */
export function validationFailed(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || '_';
    (errors[key] ??= []).push(issue.message);
  }
  return apiError(422, 'validation_failed', 'The given data was invalid.', errors);
}

/** Signed in + CSRF on unsafe methods + every listed permission; else the error response. */
export function guard(request: Request, ...permissions: string[]) {
  const me = currentUser();
  if (!me) return { error: unauthenticated() } as const;
  if (request.method !== 'GET' && !csrfOk(request)) return { error: csrfFailed() } as const;
  if (permissions.length && !permissions.every((p) => me.permissions.includes(p))) {
    return { error: forbidden() } as const;
  }
  return { me } as const;
}

export function guardAny(request: Request, ...permissions: string[]) {
  const me = currentUser();
  if (!me) return { error: unauthenticated() } as const;
  if (request.method !== 'GET' && !csrfOk(request)) return { error: csrfFailed() } as const;
  if (!permissions.some((p) => me.permissions.includes(p))) return { error: forbidden() } as const;
  return { me } as const;
}
