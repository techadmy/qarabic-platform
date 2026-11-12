import {
  allPermissions,
  createRoleSchema,
  updateMeSchema,
  updateRoleSchema,
  type RoleDto,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import {
  MOCK_CATALOG,
  MOCK_PASSWORD,
  MOCK_RESET_TOKEN,
  MOCK_ROLES,
  MOCK_USERS,
  resetMockData,
  saveUserOverride,
  toMe,
  type MockUser,
} from './data';
import { billingHandlers } from './billing-handlers';
import { resetBillingDb } from './billing-db';
import { crmHandlers } from './crm-handlers';
import { resetCrmDb } from './crm-db';
import { peopleHandlers } from './people-handlers';
import { resetPeopleDb } from './people-db';
import { scheduleHandlers } from './schedule-handlers';
import { resetScheduleDb } from './schedule-db';
import { resetSupportDb } from './support-db';
import { supportHandlers } from './support-handlers';
import { resetTeachingDb } from './teaching-db';
import { teachingHandlers } from './teaching-handlers';
import {
  apiError,
  CSRF_TOKEN,
  csrfFailed,
  csrfOk,
  currentUser,
  guard,
  notFound,
  setSessionUserId,
  unauthenticated,
  validationFailed,
} from './session';

/**
 * MSW handlers for the API (`/api/v1`), same shapes as apps/api: errors are
 * `{ message, code, errors?, data? }`, a CSRF failure is 403 `csrf_mismatch`, a record is
 * `{ data }`, a list `{ data, meta }`. Used by unit tests (node) and by the optional mock mode in
 * the browser (`NEXT_PUBLIC_ENABLE_MOCKS=true`). Paths match any origin, so they work whatever
 * `NEXT_PUBLIC_API_URL` is. Fake data only.
 */
const API = '*/api/v1';
const MAX_FAILED_LOGINS = 5;

let failedLogins = 0;

/** Resets mock state between tests. */
export function resetMockState() {
  setSessionUserId(null);
  failedLogins = 0;
  resetMockData();
  resetPeopleDb();
  resetScheduleDb();
  resetTeachingDb();
  resetSupportDb();
  resetCrmDb();
  resetBillingDb();
}

/** Signs a mock user in without going through the login form (tests). */
export function mockSignIn(email: string) {
  const found = MOCK_USERS.find((u) => u.email === email);
  if (!found) throw new Error(`Unknown mock user ${email}`);
  setSessionUserId(found.id);
}

/** `editable` / `permissionsEditable` relative to the viewer (docs/29 §1 escalation rules). */
function roleFor(role: RoleDto, me: MockUser): RoleDto {
  const isOwner = me.role?.kind === 'owner';
  const editable =
    me.permissions.includes('roles.manage') &&
    (isOwner || (role.kind !== 'owner' && role.name !== me.role?.name));
  return {
    ...role,
    editable,
    permissionsEditable: editable && role.kind === 'staff',
    permissions: role.kind === 'owner' ? allPermissions() : role.permissions,
  };
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function labelTaken(labelAr: string, exceptId?: number) {
  return MOCK_ROLES.some((r) => r.labelAr === labelAr && r.id !== exceptId);
}

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

  http.get(`${API}/me`, () => {
    const me = currentUser();
    return me ? HttpResponse.json(toMe(me)) : unauthenticated();
  }),

  http.patch(`${API}/me`, async ({ request }) => {
    const g = guard(request);
    if ('error' in g) return g.error;
    const parsed = updateMeSchema.safeParse(await readBody(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const { currentPassword, password, ...rest } = parsed.data;
    if (password !== undefined) {
      if (currentPassword !== g.me.password) {
        return apiError(422, 'wrong_password', 'The current password is not correct.', {
          currentPassword: ['The current password is not correct.'],
        });
      }
      g.me.password = password;
    }
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) (g.me as Record<string, unknown>)[key] = value;
    }
    saveUserOverride(g.me);
    return HttpResponse.json(toMe(g.me));
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

  // ------------------------------------------------------------------ roles
  http.get(`${API}/roles`, ({ request }) => {
    const g = guard(request, 'roles.view');
    if ('error' in g) return g.error;
    return HttpResponse.json({ data: MOCK_ROLES.map((r) => roleFor(r, g.me)) });
  }),

  http.get(`${API}/roles/catalog`, ({ request }) => {
    const g = guard(request, 'roles.view');
    if ('error' in g) return g.error;
    return HttpResponse.json({ data: MOCK_CATALOG });
  }),

  http.get(`${API}/roles/:id`, ({ request, params }) => {
    const g = guard(request, 'roles.view');
    if ('error' in g) return g.error;
    const role = MOCK_ROLES.find((r) => r.id === Number(params.id));
    return role ? HttpResponse.json({ data: roleFor(role, g.me) }) : notFound();
  }),

  http.post(`${API}/roles`, async ({ request }) => {
    const g = guard(request, 'roles.manage');
    if ('error' in g) return g.error;
    const parsed = createRoleSchema.safeParse(await readBody(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    if (labelTaken(input.labelAr)) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        labelAr: ['This name is already used by another role.'],
      });
    }
    const source = input.copyFrom ? MOCK_ROLES.find((r) => r.id === input.copyFrom) : null;
    let permissions = input.permissions ?? source?.permissions ?? [];
    if (g.me.role?.kind !== 'owner') {
      if (input.permissions?.some((p) => !g.me.permissions.includes(p))) {
        return apiError(409, 'permission_not_held', 'You cannot grant a permission you lack.');
      }
      permissions = permissions.filter((p) => g.me.permissions.includes(p));
    }
    const id = Math.max(...MOCK_ROLES.map((r) => r.id)) + 1;
    const role: RoleDto = {
      id,
      name: `custom_${id}`,
      labelAr: input.labelAr,
      labelEn: input.labelEn ?? null,
      description: input.description ?? null,
      kind: 'staff',
      isSystem: false,
      editable: true,
      permissionsEditable: true,
      usersCount: 0,
      customizedAt: null,
      permissions: [...permissions].sort(),
    };
    MOCK_ROLES.push(role);
    return HttpResponse.json({ data: roleFor(role, g.me) }, { status: 201 });
  }),

  http.patch(`${API}/roles/:id`, async ({ request, params }) => {
    const g = guard(request, 'roles.manage');
    if ('error' in g) return g.error;
    const role = MOCK_ROLES.find((r) => r.id === Number(params.id));
    if (!role) return notFound();
    const parsed = updateRoleSchema.safeParse(await readBody(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    const isOwner = g.me.role?.kind === 'owner';
    if (role.name === g.me.role?.name && !isOwner) {
      return apiError(409, 'cannot_edit_own_role', 'You cannot edit your own role.');
    }
    if (role.kind === 'owner' && !isOwner) {
      return apiError(409, 'owner_role_locked', 'Only an owner edits the owner role.');
    }
    if (input.permissions !== undefined && role.kind !== 'staff') {
      return apiError(409, 'owner_role_locked', 'This role keeps its permissions.');
    }
    if (input.permissions && !isOwner) {
      const added = input.permissions.filter((p) => !role.permissions.includes(p));
      if (added.some((p) => !g.me.permissions.includes(p))) {
        return apiError(409, 'permission_not_held', 'You cannot grant a permission you lack.');
      }
    }
    if (input.labelAr && labelTaken(input.labelAr, role.id)) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        labelAr: ['This name is already used by another role.'],
      });
    }
    if (input.labelAr !== undefined) role.labelAr = input.labelAr;
    if (input.labelEn !== undefined) role.labelEn = input.labelEn;
    if (input.description !== undefined) role.description = input.description;
    if (input.permissions !== undefined) {
      role.permissions = [...input.permissions];
      role.customizedAt = new Date().toISOString();
    }
    return HttpResponse.json({ data: roleFor(role, g.me) });
  }),

  http.delete(`${API}/roles/:id`, ({ request, params }) => {
    const g = guard(request, 'roles.manage');
    if ('error' in g) return g.error;
    const index = MOCK_ROLES.findIndex((r) => r.id === Number(params.id));
    const role = MOCK_ROLES[index];
    if (!role) return notFound();
    if (role.isSystem) return apiError(409, 'system_role', 'System roles cannot be deleted.');
    if (role.name === g.me.role?.name) {
      return apiError(409, 'cannot_edit_own_role', 'You cannot delete your own role.');
    }
    if (role.usersCount > 0) {
      return apiError(409, 'role_in_use', 'The role is in use.', undefined, {
        usersCount: role.usersCount,
      });
    }
    MOCK_ROLES.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  ...supportHandlers,
  ...crmHandlers,
  ...billingHandlers,
  ...peopleHandlers,
  ...teachingHandlers,
  ...scheduleHandlers,
];

export { MOCK_PASSWORD };
