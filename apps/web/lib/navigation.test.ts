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
    expect(nav.map((e) => (isGroup(e) ? e.group : e.key))).toEqual([
      'home',
      'today',
      'schedule',
      'requests',
      'leads',
      'lessonReports',
      'tests',
      'supportInbox',
      'feedbackTriage',
      'myRequests',
      'users',
      'settings',
    ]);
    expect(navItemsFor(as('admin')).map((i) => i.key)).toEqual([
      'home',
      'today',
      'schedule',
      'requests',
      'leads',
      'lessonReports',
      'tests',
      'supportInbox',
      'feedbackTriage',
      'myRequests',
      'families',
      'students',
      'teachers',
      'staff',
      'holidays',
      'sessionSettings',
      'supportSettings',
      'crmSettings',
      'roles',
    ]);
  });

  it('filters by permission and drops empty groups', () => {
    // Monitor: classes, schedule, requests, reports, tests, the support inbox and «طلباتي»,
    // families, teachers and holidays; no triage board, users, settings or roles.
    expect(navItemsFor(as('monitor')).map((i) => i.key)).toEqual([
      'home',
      'today',
      'schedule',
      'requests',
      'lessonReports',
      'tests',
      'supportInbox',
      'myRequests',
      'families',
      'students',
      'teachers',
      'holidays',
    ]);
    expect(navFor(as('accounts')).map((e) => (isGroup(e) ? e.group : e.key))).toEqual([
      'home',
      'supportInbox',
      'myRequests',
    ]);
  });

  it('gives a teacher and a parent their own classes, requests and people only', () => {
    // N3 teacher portal: «حصصي», «طلابي», «جدولي», «الاختبارات», then the requests.
    expect(navItemsFor(as('teacher')).map((i) => i.key)).toEqual([
      'home',
      'myClasses',
      'myStudents',
      'mySchedule',
      'myTests',
      'myRequests',
    ]);
    expect(navItemsFor(as('parent')).map((i) => i.key)).toEqual([
      'home',
      'childrenClasses',
      'myRequests',
      'myFamily',
    ]);
  });

  it('puts the class pages under their sidebar item', () => {
    expect(currentPage(as('admin'), '/schedule/12')?.key).toBe('schedule');
    expect(currentPage(as('admin'), '/teachers/3/timetable')?.key).toBe('teachers');
    expect(currentPage(as('admin'), '/settings/sessions')?.key).toBe('sessionSettings');
    expect(currentPage(as('teacher'), '/my-classes')?.key).toBe('myClasses');
    expect(currentPage(as('teacher'), '/tests/3')?.key).toBe('myTests');
    expect(currentPage(as('admin'), '/lesson-reports')?.key).toBe('lessonReports');
    expect(currentPage(as('parent'), '/requests')?.key).toBe('myRequests');
    // N4: «طلباتي» holds the tickets too; staff open a ticket under its own name.
    expect(currentPage(as('parent'), '/my-requests')?.key).toBe('myRequests');
    expect(currentPage(as('parent'), '/tickets/4')?.key).toBe('myRequests');
    expect(currentPage(as('admin'), '/tickets/4')?.key).toBe('ticket');
    expect(currentPage(as('admin'), '/support')?.key).toBe('supportInbox');
    expect(currentPage(as('admin'), '/settings/support')?.key).toBe('supportSettings');
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
