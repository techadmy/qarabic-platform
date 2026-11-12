import type { PeopleKind } from '@/lib/api/people';

/** Sections the top-bar search covers (D141 §5). Each needs its list's view permission. */
export const SEARCH_SECTIONS = [
  { key: 'families', path: '/families', permission: 'families.view' },
  { key: 'students', path: '/students', permission: 'families.view' },
  { key: 'teachers', path: '/teachers', permission: 'staff.view' },
  { key: 'staff', path: '/staff', permission: 'users.view' },
  { key: 'leads', path: '/leads', permission: 'leads.view' },
  { key: 'invoices', path: '/invoices', permission: 'invoices.view' },
] as const;

export type SearchSection = (typeof SEARCH_SECTIONS)[number]['key'];
export const isPeopleSection = (s: SearchSection): s is PeopleKind =>
  s === 'families' || s === 'students' || s === 'teachers' || s === 'staff';

/** The sections this user may search, in menu order. */
export function allowedSections(permissions: readonly string[]): SearchSection[] {
  return SEARCH_SECTIONS.filter((s) => permissions.includes(s.permission)).map((s) => s.key);
}

/**
 * The default scope: the section the user is in (`/leads/12` → leads), else the first allowed
 * one. `null` when the user may search nothing (the search button is then hidden).
 */
export function defaultSection(pathname: string, allowed: SearchSection[]): SearchSection | null {
  const here = SEARCH_SECTIONS.find(
    (s) => pathname === s.path || pathname.startsWith(`${s.path}/`),
  );
  if (here && allowed.includes(here.key)) return here.key;
  return allowed[0] ?? null;
}

/** `/` opens the search unless the user is typing somewhere (D141 §5). */
export function isSearchShortcut(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target'>,
) {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return false;
  const el = e.target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return true;
  return !el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}
