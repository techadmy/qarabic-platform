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
  it('groups the staff sidebar like the current app: home, «المستخدمون», «الحسابات», «الإعدادات»', () => {
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
      'tasks',
      'announcements',
      'users',
      'billing',
      'payroll',
      'accounting',
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
      'tasks',
      'announcements',
      'families',
      'students',
      'teachers',
      'staff',
      'invoices',
      'packages',
      'attendance',
      'fines',
      'payrollRuns',
      'salaryProfiles',
      'wallets',
      'journal',
      'vouchers',
      'chartOfAccounts',
      'holidays',
      'sessionSettings',
      'supportSettings',
      'crmSettings',
      'billingSettings',
      'payRules',
      'roles',
    ]);
  });

  it('filters by permission and drops empty groups', () => {
    // Monitor: classes, schedule, requests, reports, tests, the support inbox and «طلباتي»,
    // families, teachers, the fee packages (read only) and holidays; no triage board, users,
    // settings or roles.
    expect(navItemsFor(as('monitor')).map((i) => i.key)).toEqual([
      'home',
      'today',
      'schedule',
      'requests',
      'lessonReports',
      'tests',
      'supportInbox',
      'myRequests',
      'tasks',
      'announcements',
      'families',
      'students',
      'teachers',
      'packages',
      'attendance',
      'fines',
      'holidays',
    ]);
    // Accounts (N6, N7): the invoices under «الحسابات»; attendance, pay items, runs, salary
    // profiles and wallets under «الرواتب والحضور»; M7 journal, vouchers and the chart under
    // «المحاسبة»; no packages, users or settings.
    expect(navFor(as('accounts')).map((e) => (isGroup(e) ? e.group : e.key))).toEqual([
      'home',
      'supportInbox',
      'myRequests',
      'tasks',
      'announcements',
      'billing',
      'payroll',
      'accounting',
    ]);
    expect(navItemsFor(as('accounts')).map((i) => i.key)).toEqual([
      'home',
      'supportInbox',
      'myRequests',
      'tasks',
      'announcements',
      'invoices',
      'attendance',
      'fines',
      'payrollRuns',
      'salaryProfiles',
      'wallets',
      'journal',
      'vouchers',
      'chartOfAccounts',
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
      'myAttendance',
      'mySalary',
      'myRequests',
      'announcements',
    ]);
    expect(navItemsFor(as('parent')).map((i) => i.key)).toEqual([
      'home',
      'childrenClasses',
      'myInvoices',
      'myRequests',
      'myFamily',
      'announcements',
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
    // N6: an invoice and its receipt stay under «الفواتير» / «فواتيري».
    expect(currentPage(as('admin'), '/invoices/3')?.key).toBe('invoices');
    expect(currentPage(as('parent'), '/invoices/3/receipts/2')?.key).toBe('myInvoices');
    expect(currentPage(as('admin'), '/settings/billing')?.key).toBe('billingSettings');
    // N7: a run and a payslip stay under «مسيّرات الرواتب»; profiles and wallets have their own
    // items (the runs item is exact, so it is not lit on its siblings); a teacher's payslip
    // stays under «راتبي».
    expect(currentPage(as('admin'), '/payroll/runs/3')?.key).toBe('payrollRuns');
    expect(currentPage(as('admin'), '/payroll/payslips/9')?.key).toBe('payrollRuns');
    expect(currentPage(as('admin'), '/payroll/profiles')?.key).toBe('salaryProfiles');
    expect(currentPage(as('admin'), '/payroll/wallets')?.key).toBe('wallets');
    expect(currentPage(as('admin'), '/settings/pay-rules')?.key).toBe('payRules');
    expect(currentPage(as('teacher'), '/payroll/payslips/9')?.key).toBe('mySalary');
    expect(currentPage(as('teacher'), '/attendance')?.key).toBe('myAttendance');
  });
});

describe('isActive / currentPage', () => {
  it('matches home exactly and sections by prefix', () => {
    expect(isActive({ href: '/' }, '/')).toBe(true);
    expect(isActive({ href: '/' }, '/roles')).toBe(false);
    expect(isActive({ href: '/roles' }, '/roles/5')).toBe(true);
    expect(isActive({ href: '/staff' }, '/staffing')).toBe(false);
    const runs = { href: '/payroll', exact: true, also: ['/payroll/runs'] };
    expect(isActive(runs, '/payroll')).toBe(true);
    expect(isActive(runs, '/payroll/runs/2')).toBe(true);
    expect(isActive(runs, '/payroll/profiles')).toBe(false);
  });

  it('names the top bar from the sidebar or the account page', () => {
    expect(currentPage(as('admin'), '/families/3')?.key).toBe('families');
    expect(currentPage(as('admin'), '/account')?.key).toBe('account');
    expect(currentPage(as('teacher'), '/students/4')?.key).toBe('myStudents');
  });
});
