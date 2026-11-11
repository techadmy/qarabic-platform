import type { Me } from '@qarabic/shared';
import { HomeIcon, ShieldCheckIcon, type LucideIcon } from 'lucide-react';

export type NavItem = {
  /** Message key under `nav`. */
  key: 'home' | 'roles';
  href: string;
  icon: LucideIcon;
  /** Shown only to users who have this permission. */
  permission?: string;
};

/** Sidebar items in order. Unbuilt modules are not listed (docs/15 §5.1, D34). */
export const NAV_ITEMS: NavItem[] = [
  { key: 'home', href: '/', icon: HomeIcon },
  { key: 'roles', href: '/roles', icon: ShieldCheckIcon, permission: 'roles.view' },
];

export function navItemsFor(me: Pick<Me, 'permissions'>): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.permission || me.permissions.includes(item.permission));
}

export function isActive(item: NavItem, pathname: string): boolean {
  return item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
}
