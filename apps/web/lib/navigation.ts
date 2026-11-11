import type { Me } from '@qarabic/shared';
import {
  BadgeCheckIcon,
  CalendarCheckIcon,
  CalendarClockIcon,
  CalendarDaysIcon,
  CalendarOffIcon,
  CalendarRangeIcon,
  GraduationCapIcon,
  LayoutDashboardIcon,
  SlidersHorizontalIcon,
  UsersRoundIcon,
  ShieldCheckIcon,
  UserCogIcon,
  UsersIcon,
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
  | 'account';

export type NavItem = {
  /** Message key under `nav`. */
  key: NavKey;
  href: string;
  icon: LucideIcon;
  /** Shown only to users who have this permission. */
  permission?: string;
  /** A live count beside the item (K3: badge counts in the sidebar items). */
  badge?: 'pendingRequests';
};

export type NavGroup = {
  /** Message key under `nav.groups`. */
  group: 'users' | 'settings';
  icon: LucideIcon;
  items: NavItem[];
};

export type NavEntry = NavItem | NavGroup;

export const isGroup = (entry: NavEntry): entry is NavGroup => 'group' in entry;

const HOME: NavItem = { key: 'home', href: '/', icon: LayoutDashboardIcon };

/**
 * Staff sidebar, grouped like the current app (and the developer admin it copies): top items
 * («حصص اليوم», «الجدول», «طلبات الحصص» with its pending count), then «المستخدمون» and
 * «الإعدادات» (holidays, class rules, roles). Unbuilt modules are not listed (docs/15 §5.1, D34).
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
    group: 'users',
    icon: UsersIcon,
    items: [
      { key: 'families', href: '/families', icon: UsersRoundIcon, permission: 'families.view' },
      { key: 'students', href: '/students', icon: GraduationCapIcon, permission: 'families.view' },
      { key: 'teachers', href: '/teachers', icon: BadgeCheckIcon, permission: 'staff.view' },
      { key: 'staff', href: '/staff', icon: UserCogIcon, permission: 'users.view' },
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
      { key: 'roles', href: '/roles', icon: ShieldCheckIcon, permission: 'roles.view' },
    ],
  },
];

/** Teacher portal (D138): own classes, own requests, own students. */
export const TEACHER_NAV: NavEntry[] = [
  HOME,
  { key: 'myClasses', href: '/my-classes', icon: CalendarDaysIcon, permission: 'sessions.conduct' },
  {
    key: 'myRequests',
    href: '/requests',
    icon: CalendarClockIcon,
    permission: 'session_requests.view',
    badge: 'pendingRequests',
  },
  { key: 'myStudents', href: '/students', icon: GraduationCapIcon, permission: 'sessions.conduct' },
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
  {
    key: 'myRequests',
    href: '/requests',
    icon: CalendarClockIcon,
    permission: 'session_requests.view',
    badge: 'pendingRequests',
  },
  { key: 'myFamily', href: '/my-family', icon: UsersRoundIcon, permission: 'families.view' },
];

/** Pages outside the sidebar that still name the top bar. */
const OTHER_PAGES: NavItem[] = [{ key: 'account', href: '/account', icon: UserCogIcon }];

function allowed(me: Pick<Me, 'permissions'>, item: NavItem) {
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

export function isActive(item: Pick<NavItem, 'href'>, pathname: string): boolean {
  return item.href === '/'
    ? pathname === '/'
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** The page the top bar names: the sidebar item (or account) matching the path. */
export function currentPage(
  me: Pick<Me, 'permissions' | 'role'>,
  pathname: string,
): NavItem | undefined {
  return [...navItemsFor(me), ...OTHER_PAGES].find((item) => isActive(item, pathname));
}
