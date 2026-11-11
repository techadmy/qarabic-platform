import { http, HttpResponse, type HttpHandler } from 'msw';
import { MOCK_RESET_TOKEN, MOCK_ROLES, MOCK_USERS, toMe } from './data';

/**
 * MSW handlers for the N0 API (`/api/v1`), same shapes as apps/api: errors are
 * `{ message, code, errors? }`, a CSRF failure is 403 `csrf_mismatch`, lists are `{ data }`. Used by unit tests (node) and by the optional
 * mock mode in the browser (`NEXT_PUBLIC_ENABLE_MOCKS=true`). Paths match any origin, so they work
 * whatever `NEXT_PUBLIC_API_URL` is.
 */
const API = '*/api/v1';
const SESSION_KEY = 'qarabic.mock.session';
const CSRF_TOKEN = 'mock-csrf-token';
const MAX_FAILED_LOGINS = 5;

let memorySession: number | null = null;
let failedLogins = 0;

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

function setSessionUserId(id: number | null) {
  memorySession = id;
  const s = storage();
  if (!s) return;
  if (id === null) s.removeItem(SESSION_KEY);
  else s.setItem(SESSION_KEY, String(id));
}

/** Resets mock state between tests. */
export function resetMockState() {
  setSessionUserId(null);
  failedLogins = 0;
}

/** Signs a mock user in without going through the login form (tests). */
export function mockSignIn(email: string) {
  const found = MOCK_USERS.find((u) => u.email === email);
  if (!found) throw new Error(`Unknown mock user ${email}`);
  setSessionUserId(found.id);
}

function currentUser() {
  const id = getSessionUserId();
  return MOCK_USERS.find((u) => u.id === id) ?? null;
}

function csrfOk(request: Request) {
  return request.headers.get('X-XSRF-TOKEN') === CSRF_TOKEN;
}

function apiError(
  status: number,
  code: string,
  message: string,
  errors?: Record<string, string[]>,
) {
  return HttpResponse.json({ message, code, ...(errors ? { errors } : {}) }, { status });
}
const csrfFailed = () =>
  apiError(403, 'csrf_mismatch', 'CSRF token mismatch. Reload the page and try again.');
const unauthenticated = () => apiError(401, 'unauthenticated', 'Unauthenticated.');

export const handlers: HttpHandler[] = [
  http.get(`${API}/auth/csrf`, () => {
    if (typeof document !== 'undefined') document.cookie = `XSRF-TOKEN=${CSRF_TOKEN}; path=/`;
    return HttpResponse.json({ csrfToken: CSRF_TOKEN });
  }),

  http.post(`${API}/auth/login`, async ({ request }) => {
    if (!csrfOk(request)) return csrfFailed();
    if (failedLogins >= MAX_FAILED_LOGINS) {
      return apiError(429, 'too_many_requests', 'Too many attempts.');
    }
    const body = (await request.json()) as { email?: string; password?: string };
    const found = MOCK_USERS.find((u) => u.email === body.email && u.password === body.password);
    if (!found) {
      failedLogins += 1;
      return apiError(422, 'invalid_credentials', 'These credentials do not match our records.', {
        email: ['These credentials do not match our records.'],
      });
    }
    failedLogins = 0;
    setSessionUserId(found.id);
    return HttpResponse.json(toMe(found));
  }),

  http.post(`${API}/auth/logout`, ({ request }) => {
    if (!csrfOk(request)) return csrfFailed();
    setSessionUserId(null);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${API}/auth/me`, () => {
    const me = currentUser();
    return me ? HttpResponse.json(toMe(me)) : unauthenticated();
  }),

  http.post(`${API}/auth/forgot-password`, ({ request }) => {
    if (!csrfOk(request)) return csrfFailed();
    // Always 200: the API never reveals whether an email is registered.
    return HttpResponse.json({
      message: 'If an active account uses this email, a password reset link has been sent to it.',
    });
  }),

  http.post(`${API}/auth/reset-password`, async ({ request }) => {
    if (!csrfOk(request)) return csrfFailed();
    const body = (await request.json()) as Record<string, unknown>;
    const keys = Object.keys(body).sort().join(',');
    if (keys !== 'password,token') {
      return apiError(422, 'validation_failed', 'The given data was invalid.');
    }
    if (body.token !== MOCK_RESET_TOKEN) {
      const message = 'This password reset link is invalid or has expired.';
      return apiError(422, 'invalid_reset_token', message, { token: [message] });
    }
    return HttpResponse.json({ message: 'Your password has been reset. Please sign in.' });
  }),

  http.get(`${API}/roles`, () => {
    const me = currentUser();
    if (!me) return unauthenticated();
    if (!me.permissions.includes('roles.view')) {
      return apiError(403, 'forbidden', 'Forbidden.');
    }
    return HttpResponse.json({ data: MOCK_ROLES });
  }),
];
