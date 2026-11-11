import { http, HttpResponse, type HttpHandler } from 'msw';
import { MOCK_ROLES, MOCK_USERS, toMe } from './data';

/**
 * MSW handlers for the N0 API contract (`/api/v1`). Used by unit tests (node) and by the optional
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

const csrfFailed = () => HttpResponse.json({ message: 'CSRF token mismatch.' }, { status: 419 });
const unauthenticated = () => HttpResponse.json({ message: 'Unauthenticated.' }, { status: 401 });

export const handlers: HttpHandler[] = [
  http.get(`${API}/auth/csrf`, () => {
    if (typeof document !== 'undefined') document.cookie = `XSRF-TOKEN=${CSRF_TOKEN}; path=/`;
    return HttpResponse.json({ csrfToken: CSRF_TOKEN });
  }),

  http.post(`${API}/auth/login`, async ({ request }) => {
    if (!csrfOk(request)) return csrfFailed();
    if (failedLogins >= MAX_FAILED_LOGINS) {
      return HttpResponse.json({ message: 'Too many attempts.' }, { status: 429 });
    }
    const body = (await request.json()) as { email?: string; password?: string };
    const found = MOCK_USERS.find((u) => u.email === body.email && u.password === body.password);
    if (!found) {
      failedLogins += 1;
      return HttpResponse.json(
        { message: 'Invalid credentials.', errors: { email: ['auth.failed'] } },
        { status: 422 },
      );
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
    return HttpResponse.json({ status: 'ok' });
  }),

  http.post(`${API}/auth/reset-password`, async ({ request }) => {
    if (!csrfOk(request)) return csrfFailed();
    const body = (await request.json()) as { token?: string };
    if (body.token !== 'valid-token') {
      return HttpResponse.json(
        { message: 'Invalid token.', errors: { email: ['passwords.token'] } },
        { status: 422 },
      );
    }
    return HttpResponse.json({ status: 'ok' });
  }),

  http.get(`${API}/roles`, () => {
    const me = currentUser();
    if (!me) return unauthenticated();
    if (!me.permissions.includes('roles.view')) {
      return HttpResponse.json({ message: 'Forbidden.' }, { status: 403 });
    }
    return HttpResponse.json(MOCK_ROLES);
  }),
];
