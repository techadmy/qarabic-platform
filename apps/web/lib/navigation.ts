import type { Me } from '@qarabic/shared';
import {
  BadgeCheckIcon,
  CalendarCheckIcon,
  CalendarClockIcon,
  CalendarDaysIcon,
  CalendarOffIcon,
  CalendarRangeIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  GraduationCapIcon,
  HeadsetIcon,
  InboxIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  UserCheckIcon,
  MessagesSquareIcon,
  SlidersHorizontalIcon,
  UsersRoundIcon,
  ShieldCheckIcon,
  UserCogIcon,
  UserSearchIcon,
  ContactRoundIcon,
  PackageIcon,
  ReceiptTextIcon,
  WalletIcon,
  UsersIcon,
  BanknoteIcon,
  CalendarCheck2Icon,
  FileWarningIcon,
  IdCardIcon,
  ScaleIcon,
  WalletCardsIcon,
  ListTodoIcon,
  MegaphoneIcon,
  BookOpenTextIcon,
  LandmarkIcon,
  ChartColumnIcon,
  LockKeyholeIcon,
  ListTreeIcon,
  ReceiptIcon,
  type LucideIcon,
} from 'lucide-react';

export type NavKey =
  | 'home'
  | 'families'
  | 'students'
  | 'teachers'
  | 'staff'
  | 'roles'
  | 'myStudents'
  | 'myFamily'
  | 'today'
  | 'schedule'
  | 'requests'
  | 'holidays'
  | 'sessionSettings'
  | 'myClasses'
  | 'childrenClasses'
  | 'myRequests'
  | 'lessonReports'
  | 'tests'
  | 'myTests'
  | 'mySchedule'
  | 'supportInbox'
  | 'feedbackTriage'
  | 'supportSettings'
  | 'leads'
  | 'trialsToday'
  | 'crmSettings'
  | 'invoices'
  | 'packages'
  | 'billingSettings'
  | 'myInvoices'
  | 'attendance'
  | 'myAttendance'
  | 'fines'
  | 'payrollRuns'
  | 'salaryProfiles'
  | 'wallets'
  | 'mySalary'
  | 'payRules'
  | 'tasks'
  | 'announcements'
  | 'journal'
  | 'vouchers'
  | 'chartOfAccounts'
  | 'financialReports'
  | 'periods'
  | 'ticket'
  | 'account';

export type NavItem = {
  /** Message key under `nav`. */
  key: NavKey;
  href: string;
  icon: LucideIcon;
  /** Shown only to users who have this permission. */
  permission?: string;
  /** Shown to users who have any of these permissions (instead of `permission`). */
  anyPermission?: string[];
  /** A live count beside the item (K3: badge counts in the sidebar items). */
  badge?: 'pendingRequests' | 'supportOpen' | 'triageNew' | 'mineUpdates' | 'leads';
  /** Other paths that belong to this item (a teacher's student profile under «طلابي»). */
  also?: string[];
  /** Active only on `href` itself (and `also`), not on its sub-paths («ملفات الرواتب» under /payroll). */
  exact?: boolean;
  /**
   * The section has a create action (D141 §6): the sidebar shows «+» beside it for users with this
   * permission; it opens `${href}?new=1`, which the list turns into its own «add» dialog.
   */
  create?: string;
};

export type NavGroup = {
  /** Message key under `nav.groups`. */
  group: 'users' | 'billing' | 'payroll' | 'accounting' | 'settings';
  icon: LucideIcon;
  items: NavItem[];
};

export type NavEntry = NavItem | NavGroup;

export const isGroup = (entry: NavEntry): entry is NavGroup => 'group' in entry;

const HOME: NavItem = { key: 'home', href: '/', icon: LayoutDashboardIcon };

/** «الإعلانات» (M8): what the academy published for the viewer's role. */
const ANNOUNCEMENTS: NavItem = {
  key: 'announcements',
  href: '/announcements',
  icon: MegaphoneIcon,
  permission: 'announcements.view',
};

/**
 * «طلباتي» for parents and teachers (N4, docs/32 S2): support requests and class requests in one
 * list, with the count of requests that have news. The old class-request list stays reachable.
 */
const MY_REQUESTS: NavItem = {
  key: 'myRequests',
  href: '/my-requests',
  icon: MessagesSquareIcon,
  permission: 'feedback.request',
  badge: 'mineUpdates',
  also: ['/requests', '/tickets'],
};

/**
 * Staff sidebar, grouped like the current app (and the developer admin it copies): top items
 * («حصص اليوم», «الجدول», «طلبات الحصص» with its pending count), then «المستخدمون» and
 * «الحسابات» (invoices, fee packages; docs/20 §12) and «الإعدادات» (holidays, class rules, roles). Unbuilt modules are not listed (docs/15 §5.1, D34).
 */
export const STAFF_NAV: NavEntry[] = [
  HOME,
  { key: 'today', href: '/today', icon: CalendarCheckIcon, permission: 'sessions.view' },
  { key: 'schedule', href: '/schedule', icon: CalendarRangeIcon, permission: 'schedule.view' },
  {
    key: 'requests',
    href: '/requests',
    icon: CalendarClockIcon,
    permission: 'session_requests.view',
    badge: 'pendingRequests',
  },
  {
    key: 'leads',
    href: '/leads',
    icon: UserSearchIcon,
    permission: 'leads.view',
    create: 'leads.manage',
    badge: 'leads',
  },
  {
    // T4 (docs/33 §3.5): today's trial classes for monitors and customer service.
    key: 'trialsToday',
    href: '/trials',
    icon: UserCheckIcon,
    anyPermission: ['sessions.manage', 'leads.manage'],
  },
  {
    key: 'lessonReports',
    href: '/lesson-reports',
    icon: ClipboardCheckIcon,
    permission: 'sessions.view',
  },
  { key: 'tests', href: '/tests', icon: ClipboardListIcon, permission: 'tests.view' },
  {
    key: 'supportInbox',
    href: '/support',
    icon: InboxIcon,
    permission: 'support.view',
    badge: 'supportOpen',
  },
  {
    key: 'feedbackTriage',
    href: '/feedback',
    icon: ListChecksIcon,
    permission: 'feedback.review',
    badge: 'triageNew',
  },
  {
    key: 'myRequests',
    href: '/my-requests',
    icon: MessagesSquareIcon,
    permission: 'feedback.request',
    badge: 'mineUpdates',
  },
  { key: 'tasks', href: '/tasks', icon: ListTodoIcon, permission: 'tasks.view' },
  ANNOUNCEMENTS,
  {
    group: 'users',
    icon: UsersIcon,
    items: [
      {
        key: 'families',
        href: '/families',
        icon: UsersRoundIcon,
        permission: 'families.view',
        create: 'families.manage',
      },
      {
        key: 'students',
        href: '/students',
        icon: GraduationCapIcon,
        permission: 'families.view',
        create: 'families.manage',
      },
      {
        key: 'teachers',
        href: '/teachers',
        icon: BadgeCheckIcon,
        permission: 'staff.view',
        create: 'staff.manage',
      },
      {
        key: 'staff',
        href: '/staff',
        icon: UserCogIcon,
        permission: 'users.view',
        create: 'users.manage',
      },
    ],
  },
  {
    group: 'billing',
    icon: WalletIcon,
    items: [
      { key: 'invoices', href: '/invoices', icon: ReceiptTextIcon, permission: 'invoices.view' },
      { key: 'packages', href: '/packages', icon: PackageIcon, permission: 'packages.view' },
    ],
  },
  {
    group: 'payroll',
    icon: BanknoteIcon,
    items: [
      {
        key: 'attendance',
        href: '/attendance',
        icon: CalendarCheck2Icon,
        permission: 'attendance.request',
      },
      {
        key: 'fines',
        href: '/fines',
        icon: FileWarningIcon,
        anyPermission: ['fines.view', 'payroll.manage'],
      },
      {
        key: 'payrollRuns',
        href: '/payroll',
        icon: BanknoteIcon,
        anyPermission: ['payroll.manage', 'payroll.review', 'payroll.approve'],
        exact: true,
        also: ['/payroll/runs', '/payroll/payslips'],
      },
      {
        key: 'salaryProfiles',
        href: '/payroll/profiles',
        icon: IdCardIcon,
        permission: 'payroll.manage',
      },
      {
        key: 'wallets',
        href: '/payroll/wallets',
        icon: WalletCardsIcon,
        permission: 'wallet.manage',
      },
    ],
  },
  {
    group: 'accounting',
    icon: LandmarkIcon,
    items: [
      {
        key: 'journal',
        href: '/accounting/journal',
        icon: BookOpenTextIcon,
        permission: 'accounting.view',
      },
      {
        key: 'vouchers',
        href: '/accounting/vouchers',
        icon: ReceiptIcon,
        permission: 'accounting.view',
      },
      {
        key: 'chartOfAccounts',
        href: '/accounting/accounts',
        icon: ListTreeIcon,
        permission: 'accounting.view',
      },
      {
        key: 'financialReports',
        href: '/accounting/reports',
        icon: ChartColumnIcon,
        permission: 'accounting.view',
      },
      {
        key: 'periods',
        href: '/accounting/periods',
        icon: LockKeyholeIcon,
        permission: 'accounting.view',
      },
    ],
  },
  {
    group: 'settings',
    icon: ShieldCheckIcon,
    items: [
      { key: 'holidays', href: '/holidays', icon: CalendarOffIcon, permission: 'schedule.view' },
      {
        key: 'sessionSettings',
        href: '/settings/sessions',
        icon: SlidersHorizontalIcon,
        permission: 'settings.view',
      },
      {
        key: 'supportSettings',
        href: '/settings/support',
        icon: HeadsetIcon,
        permission: 'settings.view',
      },
      {
        key: 'crmSettings',
        href: '/settings/crm',
        icon: ContactRoundIcon,
        permission: 'settings.view',
      },
      {
        key: 'billingSettings',
        href: '/settings/billing',
        icon: WalletIcon,
        permission: 'settings.view',
      },
      {
        key: 'payRules',
        href: '/settings/pay-rules',
        icon: ScaleIcon,
        permission: 'settings.view',
      },
      { key: 'roles', href: '/roles', icon: ShieldCheckIcon, permission: 'roles.view' },
    ],
  },
];

/**
 * Teacher portal (D71, D138): «حصصي» (the week), «طلابي», «جدولي» (own timetable and work hours),
 * «الاختبارات» (tests they examine), own requests.
 */
export const TEACHER_NAV: NavEntry[] = [
  HOME,
  { key: 'myClasses', href: '/my-classes', icon: CalendarDaysIcon, permission: 'sessions.conduct' },
  {
    key: 'myStudents',
    href: '/my-students',
    icon: GraduationCapIcon,
    permission: 'sessions.conduct',
    also: ['/students'],
  },
  {
    key: 'mySchedule',
    href: '/my-schedule',
    icon: CalendarRangeIcon,
    permission: 'sessions.conduct',
  },
  { key: 'myTests', href: '/tests', icon: ClipboardListIcon, permission: 'tests.view' },
  {
    key: 'myAttendance',
    href: '/attendance',
    icon: CalendarCheck2Icon,
    permission: 'attendance.request',
  },
  {
    key: 'mySalary',
    href: '/payroll',
    icon: WalletIcon,
    permission: 'payroll.view',
    exact: true,
    also: ['/payroll/payslips'],
  },
  MY_REQUESTS,
  ANNOUNCEMENTS,
];

/** Parent portal: the children's classes, own requests, own family. */
export const PARENT_NAV: NavEntry[] = [
  HOME,
  {
    key: 'childrenClasses',
    href: '/my-classes',
    icon: CalendarDaysIcon,
    permission: 'sessions.view',
  },
  { key: 'myInvoices', href: '/invoices', icon: ReceiptTextIcon, permission: 'invoices.view' },
  MY_REQUESTS,
  { key: 'myFamily', href: '/my-family', icon: UsersRoundIcon, permission: 'families.view' },
  ANNOUNCEMENTS,
];

/** Pages outside the sidebar that still name the top bar. */
const OTHER_PAGES: NavItem[] = [
  { key: 'account', href: '/account', icon: UserCogIcon },
  { key: 'ticket', href: '/tickets', icon: MessagesSquareIcon },
];

function allowed(me: Pick<Me, 'permissions'>, item: NavItem) {
  if (item.anyPermission) return item.anyPermission.some((p) => me.permissions.includes(p));
  return !item.permission || me.permissions.includes(item.permission);
}

/** The sidebar for this user: the portal by role kind, items filtered by permission, empty groups dropped. */
export function navFor(me: Pick<Me, 'permissions' | 'role'>): NavEntry[] {
  const kind = me.role?.kind;
  const nav = kind === 'teacher' ? TEACHER_NAV : kind === 'parent' ? PARENT_NAV : STAFF_NAV;
  return nav.flatMap((entry): NavEntry[] => {
    if (!isGroup(entry)) return allowed(me, entry) ? [entry] : [];
    const items = entry.items.filter((i) => allowed(me, i));
    return items.length ? [{ ...entry, items }] : [];
  });
}

/** Flat list of the user's pages (sidebar + account). */
export function navItemsFor(me: Pick<Me, 'permissions' | 'role'>): NavItem[] {
  return navFor(me).flatMap((e) => (isGroup(e) ? e.items : [e]));
}

export function isActive(
  item: Pick<NavItem, 'href' | 'also' | 'exact'>,
  pathname: string,
): boolean {
  if (item.href === '/') return pathname === '/';
  if (item.exact && pathname === item.href) return true;
  return [...(item.exact ? [] : [item.href]), ...(item.also ?? [])].some(
    (href) => pathname === href || pathname.startsWith(`${href}/`),
  );
}

/** The page the top bar names: the sidebar item (or account) matching the path. */
export function currentPage(
  me: Pick<Me, 'permissions' | 'role'>,
  pathname: string,
): NavItem | undefined {
  return [...navItemsFor(me), ...OTHER_PAGES].find((item) => isActive(item, pathname));
}
