import { permissionsFor, SYSTEM_ROLES, type Role } from '@qarabic/shared';
import { describe, expect, it } from 'vitest';
import { currentPage, isActive, isGroup, navFor, navItemsFor } from './navigation';

function as(role: Role) {
  return {
    permissions: permissionsFor(role),
    role: { name: role, labelAr: '', labelEn: null, kind: SYSTEM_ROLES[role].kind },
  };
}

describe('navFor', () => {
  it('groups the staff sidebar like the current app: home, «المستخدمون», «الإعدادات»', () => {
    const nav = navFor(as('admin'));
    expect(nav.map((e) => (isGroup(e) ? e.group : e.key))).toEqual(['home', 'users', 'settings']);
    expect(navItemsFor(as('admin')).map((i) => i.key)).toEqual([
      'home',
      'families',
      'students',
      'teachers',
      'staff',
      'roles',
    ]);
  });

  it('filters by permission and drops empty groups', () => {
    // Monitor: families.view + staff.view, no users.view, no roles.view.
    expect(navItemsFor(as('monitor')).map((i) => i.key)).toEqual([
      'home',
      'families',
      'students',
      'teachers',
    ]);
    expect(navFor(as('accounts')).map((e) => (isGroup(e) ? e.group : e.key))).toEqual(['home']);
  });

  it('gives a teacher «طلابي» and a parent «عائلتي» only', () => {
    expect(navItemsFor(as('teacher')).map((i) => i.key)).toEqual(['home', 'myStudents']);
    expect(navItemsFor(as('parent')).map((i) => i.key)).toEqual(['home', 'myFamily']);
  });
});

describe('isActive / currentPage', () => {
  it('matches home exactly and sections by prefix', () => {
    expect(isActive({ href: '/' }, '/')).toBe(true);
    expect(isActive({ href: '/' }, '/roles')).toBe(false);
    expect(isActive({ href: '/roles' }, '/roles/5')).toBe(true);
    expect(isActive({ href: '/staff' }, '/staffing')).toBe(false);
  });

  it('names the top bar from the sidebar or the account page', () => {
    expect(currentPage(as('admin'), '/families/3')?.key).toBe('families');
    expect(currentPage(as('admin'), '/account')?.key).toBe('account');
    expect(currentPage(as('teacher'), '/students/4')?.key).toBe('myStudents');
  });
});
