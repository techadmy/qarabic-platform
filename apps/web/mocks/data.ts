import {
  permissionsFor,
  ROLES,
  SYSTEM_ROLES,
  type Me,
  type Role,
  type RoleDto,
} from '@qarabic/shared';

/** Demo password of every mock user (mock mode and tests only; never a real credential). */
export const MOCK_PASSWORD = 'Qarabic-demo-123';

type MockUser = Me & { password: string };

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
    password: MOCK_PASSWORD,
  };
}

export const MOCK_USERS: MockUser[] = [
  user(1, 'مدير النظام', 'admin@qarabic.test', 'admin'),
  user(2, 'معلم تجريبي', 'teacher@qarabic.test', 'teacher'),
  user(3, 'ولي أمر تجريبي', 'parent@qarabic.test', 'parent'),
];

export function toMe({ password: _password, ...me }: MockUser): Me {
  return me;
}

/** Same shape as the API's `GET /roles` rows (`RoleDto`). */
export const MOCK_ROLES: RoleDto[] = ROLES.map((name, index) => ({
  id: index + 1,
  name,
  labelAr: SYSTEM_ROLES[name].ar,
  labelEn: SYSTEM_ROLES[name].en,
  description: null,
  kind: SYSTEM_ROLES[name].kind,
  isSystem: true,
  editable: true,
  permissionsEditable: SYSTEM_ROLES[name].kind === 'staff',
  usersCount: name === 'admin' ? 1 : 0,
  customizedAt: name === 'monitor' ? '2026-11-09T10:00:00.000Z' : null,
  permissions: permissionsFor(name),
}));

/** A reset token the mock API accepts (real tokens are 20–200 characters). */
export const MOCK_RESET_TOKEN = 'mock-reset-token-0123456789';
