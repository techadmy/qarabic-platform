import { permissionsFor, ROLES, SYSTEM_ROLES, type Me, type Role } from '@qarabic/shared';

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

export const MOCK_ROLES = ROLES.map((name, index) => ({
  id: index + 1,
  name,
  label_ar: SYSTEM_ROLES[name].ar,
  label_en: SYSTEM_ROLES[name].en,
  kind: SYSTEM_ROLES[name].kind,
  customized_at: name === 'monitor' ? '2026-11-09T10:00:00.000Z' : null,
  permissions: permissionsFor(name) as string[],
}));
