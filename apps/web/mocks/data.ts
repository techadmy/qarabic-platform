import {
  GROUPS,
  MODULES,
  PERMISSION_ACTION_LABELS,
  PERMISSION_GROUP_LABELS,
  PERMISSION_HINTS,
  PERMISSION_MODULE_LABELS,
  permissionsFor,
  ROLES,
  SYSTEM_ROLES,
  type Me,
  type Module,
  type Permission,
  type PermissionCatalog,
  type Role,
  type RoleDto,
} from '@qarabic/shared';
import { SUPERVISOR_ROLE } from './people-db';

/** Demo password of every mock user (mock mode and tests only; never a real credential). */
export const MOCK_PASSWORD = 'Qarabic-demo-123';

export type MockUser = Me & { password: string };

function user(id: number, name: string, email: string, role: Role): MockUser {
  return {
    id,
    name,
    email,
    locale: 'ar',
    timezone: 'Africa/Cairo',
    phone: null,
    role: {
      name: role,
      labelAr: SYSTEM_ROLES[role].ar,
      labelEn: SYSTEM_ROLES[role].en,
      kind: SYSTEM_ROLES[role].kind,
    },
    roles: [role],
    permissions: permissionsFor(role),
    // The demo teacher login is mock teacher 1 (people-db: userId 2).
    teacherId: role === 'teacher' ? 1 : null,
    password: MOCK_PASSWORD,
  };
}

/** A custom staff role holder: may manage roles but holds only some permissions (docs/29 escalation rule). */
export const SUPERVISOR_PERMISSIONS: Permission[] = [
  'families.view',
  'families.manage',
  'staff.view',
  'users.view',
  'sessions.view',
  'roles.view',
  'roles.manage',
];

function buildUsers(): MockUser[] {
  return [
    user(1, 'مدير النظام', 'admin@qarabic.test', 'admin'),
    user(2, 'معلم تجريبي', 'teacher@qarabic.test', 'teacher'),
    user(3, 'ولي أمر تجريبي', 'parent@qarabic.test', 'parent'),
    // N7: a monitor proposes fines and marks attendance (people-db staff row 12).
    user(12, 'Rana Monitor', 'monitor@qarabic.test', 'monitor'),
    // M7: the accounts role posts entries and vouchers and closes periods.
    user(13, 'Accounts Officer', 'accounts@qarabic.test', 'accounts'),
    {
      id: 4,
      name: 'مشرف تجريبي',
      email: 'supervisor@qarabic.test',
      locale: 'ar',
      timezone: 'Africa/Cairo',
      phone: null,
      role: {
        name: SUPERVISOR_ROLE.name,
        labelAr: SUPERVISOR_ROLE.labelAr,
        labelEn: SUPERVISOR_ROLE.labelEn,
        kind: 'staff',
      },
      roles: [SUPERVISOR_ROLE.name],
      permissions: [...SUPERVISOR_PERMISSIONS],
      teacherId: null,
      password: MOCK_PASSWORD,
    },
  ];
}

const OVERRIDES_KEY = 'qarabic.mock.users';

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Mock mode in the browser: `PATCH /me` changes survive a page load (tests reset them). */
function withOverrides(users: MockUser[]): MockUser[] {
  try {
    const saved = JSON.parse(storage()?.getItem(OVERRIDES_KEY) ?? '{}') as Record<
      string,
      Partial<MockUser>
    >;
    return users.map((u) => ({ ...u, ...saved[u.id] }));
  } catch {
    return users;
  }
}

export function saveUserOverride(user: MockUser) {
  const s = storage();
  if (!s) return;
  try {
    const saved = JSON.parse(s.getItem(OVERRIDES_KEY) ?? '{}') as Record<string, unknown>;
    const { name, locale, timezone, phone, password } = user;
    saved[user.id] = { name, locale, timezone, phone, password };
    s.setItem(OVERRIDES_KEY, JSON.stringify(saved));
  } catch {
    /* storage unavailable: the change lasts until reload */
  }
}

export let MOCK_USERS: MockUser[] = withOverrides(buildUsers());

export function toMe({ password: _password, ...me }: MockUser): Me {
  return me;
}

const USERS_COUNT: Record<Role, number> = {
  admin: 1,
  senior_manager: 0,
  manager: 1,
  monitor: 2,
  csr: 1,
  billing: 1,
  accounts: 1,
  teacher: 8,
  parent: 28,
};

/** Stored roles; `editable`/`permissionsEditable` are worked out per viewer by the handlers. */
function buildRoles(): RoleDto[] {
  const system = ROLES.map((name, index): RoleDto => ({
    id: index + 1,
    name,
    labelAr: SYSTEM_ROLES[name].ar,
    labelEn: SYSTEM_ROLES[name].en,
    description: null,
    kind: SYSTEM_ROLES[name].kind,
    isSystem: true,
    editable: true,
    permissionsEditable: SYSTEM_ROLES[name].kind === 'staff',
    usersCount: USERS_COUNT[name],
    customizedAt: name === 'monitor' ? '2026-11-09T10:00:00.000Z' : null,
    permissions: permissionsFor(name),
  }));
  return [
    ...system,
    {
      id: SUPERVISOR_ROLE.id,
      name: SUPERVISOR_ROLE.name,
      labelAr: SUPERVISOR_ROLE.labelAr,
      labelEn: SUPERVISOR_ROLE.labelEn,
      description: 'Follows families and keeps the roles in order.',
      kind: 'staff',
      isSystem: false,
      editable: true,
      permissionsEditable: true,
      usersCount: 1,
      customizedAt: '2026-11-09T12:00:00.000Z',
      permissions: [...SUPERVISOR_PERMISSIONS].sort(),
    },
  ];
}

export let MOCK_ROLES: RoleDto[] = buildRoles();

export function resetMockData() {
  storage()?.removeItem(OVERRIDES_KEY);
  MOCK_USERS = buildUsers();
  MOCK_ROLES = buildRoles();
}

/** Same shape as `GET /roles/catalog` (labels from `@qarabic/shared`). */
export const MOCK_CATALOG: PermissionCatalog = Object.entries(GROUPS).flatMap(([group, modules]) =>
  modules.map((module: Module) => ({
    module,
    labelAr: PERMISSION_MODULE_LABELS[module].ar,
    labelEn: PERMISSION_MODULE_LABELS[module].en,
    group,
    groupLabelAr: PERMISSION_GROUP_LABELS[group]!.ar,
    groupLabelEn: PERMISSION_GROUP_LABELS[group]!.en,
    actions: MODULES[module].map((key: string) => {
      const permission = `${module}.${key}` as Permission;
      return {
        key,
        permission,
        labelAr: PERMISSION_ACTION_LABELS[key]!.ar,
        labelEn: PERMISSION_ACTION_LABELS[key]!.en,
        hintAr: PERMISSION_HINTS[permission].ar,
        hintEn: PERMISSION_HINTS[permission].en,
      };
    }),
  })),
);

/** A reset token the mock API accepts (real tokens are 20–200 characters). */
export const MOCK_RESET_TOKEN = 'mock-reset-token-0123456789';
