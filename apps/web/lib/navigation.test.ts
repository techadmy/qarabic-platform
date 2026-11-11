import { permissionsFor } from '@qarabic/shared';
import { describe, expect, it } from 'vitest';
import { isActive, NAV_ITEMS, navItemsFor } from './navigation';

describe('navItemsFor', () => {
  it('filters the sidebar by permission', () => {
    expect(navItemsFor({ permissions: permissionsFor('admin') }).map((i) => i.key)).toEqual([
      'home',
      'roles',
    ]);
    expect(navItemsFor({ permissions: permissionsFor('teacher') }).map((i) => i.key)).toEqual([
      'home',
    ]);
  });

  it('matches home exactly and sections by prefix', () => {
    const [home, roles] = NAV_ITEMS as [(typeof NAV_ITEMS)[0], (typeof NAV_ITEMS)[0]];
    expect(isActive(home, '/')).toBe(true);
    expect(isActive(home, '/roles')).toBe(false);
    expect(isActive(roles, '/roles/5')).toBe(true);
  });
});
