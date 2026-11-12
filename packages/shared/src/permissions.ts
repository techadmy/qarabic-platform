/**
 * Roles and permissions (docs/07 §B.2, docs/29, D132, D138), ported from the Laravel `RoleMatrix`.
 * Permission names are `module.action`. Row scoping (a teacher's own students, a parent's own
 * children) is enforced by the API on top of these permissions.
 * The Laravel LEGACY sidebar names are not ported: the new system has no old admin UI.
 */

export const ROLES = [
  'admin',
  'senior_manager',
  'manager',
  'monitor',
  'csr',
  'billing',
  'accounts',
  'teacher',
  'parent',
] as const;
export type Role = (typeof ROLES)[number];

export type RoleKind = 'owner' | 'staff' | 'teacher' | 'parent';

export const SYSTEM_ROLES: Record<Role, { ar: string; en: string; kind: RoleKind }> = {
  admin: { ar: 'المالك (مدير النظام)', en: 'Owner (super admin)', kind: 'owner' },
  senior_manager: { ar: 'مدير أول', en: 'Senior manager', kind: 'staff' },
  manager: { ar: 'مدير', en: 'Manager', kind: 'staff' },
  monitor: { ar: 'مشرف متابعة', en: 'Monitor', kind: 'staff' },
  csr: { ar: 'خدمة العملاء', en: 'Customer service', kind: 'staff' },
  billing: { ar: 'الفوترة', en: 'Billing', kind: 'staff' },
  accounts: { ar: 'الحسابات', en: 'Accounts', kind: 'staff' },
  teacher: { ar: 'معلم', en: 'Teacher', kind: 'teacher' },
  parent: { ar: 'ولي أمر', en: 'Parent', kind: 'parent' },
};

export const MODULES = {
  leads: ['view', 'manage', 'assign', 'refer'],
  families: ['view', 'manage'],
  staff: ['view', 'manage'],
  courses: ['view', 'manage'],
  packages: ['view', 'manage'],
  schedule: ['view', 'manage'],
  sessions: ['view', 'manage', 'conduct'],
  session_requests: ['view', 'manage', 'request', 'approve'],
  attendance: ['view', 'manage', 'request'],
  fines: ['view', 'manage', 'request', 'approve'],
  tests: ['view', 'manage', 'conduct'],
  invoices: ['view', 'manage', 'request', 'pay'],
  payroll: ['view', 'manage', 'review', 'approve'],
  wallet: ['view', 'manage', 'request'],
  accounting: ['view', 'manage'],
  tasks: ['view', 'manage', 'oversee'],
  complaints: ['view', 'manage', 'request'],
  announcements: ['view', 'manage'],
  reports: ['view', 'financial'],
  users: ['view', 'manage'],
  roles: ['view', 'manage'],
  audit_logs: ['view'],
  settings: ['view', 'manage'],
  feedback: ['view', 'manage', 'request', 'review'],
  support: ['view', 'handle', 'manage', 'view_restricted'],
} as const;

type Modules = typeof MODULES;
export type Module = keyof Modules;
export type Permission = {
  [M in Module]: `${M}.${Modules[M][number]}`;
}[Module];

/** Modules grouped like the app sidebar, for the permission matrix (docs/29 §3). */
export const GROUPS: Record<string, Module[]> = {
  people: ['leads', 'families', 'staff', 'users'],
  classes: ['courses', 'schedule', 'sessions', 'session_requests', 'tests', 'attendance', 'fines'],
  finance: ['packages', 'invoices', 'payroll', 'wallet', 'accounting'],
  communication: ['tasks', 'complaints', 'announcements', 'feedback', 'support'],
  reports: ['reports', 'audit_logs'],
  settings: ['roles', 'settings'],
};

type Entry = Permission | `${Module}.*`;

/** Permissions of each role except admin (admin gets every permission). */
// prettier-ignore
export const ROLE_PERMISSIONS: Record<Exclude<Role, 'admin'>, Entry[]> = {
  senior_manager: [
    'leads.view',
    'leads.manage',
    'leads.assign',
    'families.*',
    'staff.*',
    'courses.*',
    'packages.*',
    'schedule.*',
    'sessions.*',
    'session_requests.*',
    'attendance.*',
    'fines.*',
    'tests.*',
    'invoices.view',
    'invoices.manage',
    'payroll.view',
    'payroll.review',
    'accounting.view',
    'tasks.*',
    'complaints.*',
    'announcements.*',
    'reports.view',
    'reports.financial',
    'users.view',
    'feedback.*',
    'support.*',
  ],
  manager: [
    'leads.view',
    'leads.manage',
    'leads.assign',
    'families.*',
    'staff.view',
    'courses.view',
    'packages.view',
    'schedule.*',
    'sessions.*',
    'session_requests.*',
    'attendance.*',
    'fines.*',
    'tests.*',
    'invoices.view',
    'tasks.*',
    'complaints.*',
    'announcements.*',
    'reports.view',
    'feedback.view',
    'feedback.request',
    'support.view',
    'support.handle',
  ],
  monitor: [
    'families.view',
    'staff.view',
    'courses.view',
    'packages.view',
    'schedule.*',
    'sessions.*',
    'session_requests.*',
    'attendance.*',
    'fines.view',
    'fines.request',
    'tests.*',
    'tasks.view',
    'tasks.manage',
    'complaints.*',
    'announcements.view',
    'reports.view',
    'feedback.view',
    'feedback.request',
    'support.view',
    'support.handle',
  ],
  csr: [
    'leads.view',
    'leads.manage',
    'families.*',
    'staff.view',
    'courses.view',
    'packages.view',
    'schedule.*',
    'sessions.view',
    'session_requests.view',
    'session_requests.request',
    'tests.view',
    'attendance.view',
    'attendance.request',
    'invoices.view',
    'invoices.request',
    'tasks.view',
    'tasks.manage',
    'complaints.*',
    'announcements.view',
    'reports.view',
    'feedback.view',
    'feedback.request',
    'support.view',
    'support.handle',
  ],
  billing: [
    'families.view',
    'packages.view',
    'packages.manage',
    'attendance.view',
    'attendance.request',
    'invoices.view',
    'invoices.manage',
    'tasks.view',
    'tasks.manage',
    'complaints.view',
    'complaints.request',
    'announcements.view',
    'reports.view',
    'reports.financial',
    'feedback.view',
    'feedback.request',
    'support.view',
    'support.handle',
  ],
  accounts: [
    'invoices.view',
    'attendance.view',
    'attendance.request',
    'payroll.view',
    'payroll.manage',
    'payroll.approve',
    'wallet.view',
    'wallet.manage',
    'accounting.*',
    'tasks.view',
    'tasks.manage',
    'announcements.view',
    'reports.view',
    'reports.financial',
    'feedback.view',
    'feedback.request',
    'support.view',
    'support.handle',
  ],
  // Teacher privacy (D138): own students, classes, schedule, requests, tests, attendance, pay, wallet only.
  teacher: [
    'courses.view',
    'sessions.view',
    'sessions.conduct',
    'session_requests.view',
    'session_requests.request',
    'attendance.view',
    'attendance.request',
    'fines.view',
    'tests.view',
    'tests.conduct',
    'payroll.view',
    'wallet.view',
    'wallet.request',
    'announcements.view',
    'feedback.view',
    'feedback.request',
  ],
  parent: [
    'leads.refer',
    'families.view',
    'courses.view',
    'schedule.view',
    'sessions.view',
    'session_requests.view',
    'session_requests.request',
    'tests.view',
    'invoices.view',
    'invoices.pay',
    'complaints.view',
    'complaints.request',
    'announcements.view',
    'feedback.view',
    'feedback.request',
  ],
};

export function allPermissions(): Permission[] {
  return (Object.keys(MODULES) as Module[]).flatMap((m) =>
    MODULES[m].map((a) => `${m}.${a}` as Permission),
  );
}

/** Expands `module.*` wildcards into concrete permission names. */
export function permissionsFor(role: Role): Permission[] {
  if (role === 'admin') return allPermissions();
  const out = new Set<Permission>();
  for (const entry of ROLE_PERMISSIONS[role]) {
    const [module, action] = entry.split('.') as [Module, string];
    const actions: readonly string[] = action === '*' ? MODULES[module] : [action];
    for (const a of actions) out.add(`${module}.${a}` as Permission);
  }
  return [...out];
}
