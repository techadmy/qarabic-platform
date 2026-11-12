import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RolesView } from '@/app/(app)/roles/roles-view';
import { mockSignIn } from '@/mocks/handlers';
import { renderWithProviders } from '@/test/render';
import { routerMock } from '@/test/router-mock';
import { AppShell } from './app-shell';

/** The sidebar's menu (the breadcrumb also has role="link"). */
async function sidebarMenu() {
  await waitFor(() => expect(document.querySelector('[data-sidebar="content"]')).not.toBeNull());
  return within(document.querySelector('[data-sidebar="content"]') as HTMLElement);
}

function renderShell(children = <p>محتوى</p>) {
  return renderWithProviders(<AppShell defaultOpen>{children}</AppShell>);
}

describe('AppShell', () => {
  it('redirects to /login with the page to come back to when there is no session (401)', async () => {
    routerMock.pathname = '/roles';
    routerMock.search = 'tab=all';
    renderShell();
    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith('/login?next=%2Froles%3Ftab%3Dall'),
    );
  });

  it('shows «الأدوار والصلاحيات» to a user with roles.view', async () => {
    mockSignIn('admin@qarabic.test');
    renderShell();
    const menu = await sidebarMenu();
    expect(menu.getByRole('link', { name: 'الرئيسية' })).toBeInTheDocument();
    expect(menu.getByRole('link', { name: 'الأدوار والصلاحيات' })).toBeInTheDocument();
    // Grouped like the current app: «المستخدمون» and «الإعدادات».
    expect(menu.getByRole('button', { name: 'المستخدمون' })).toBeInTheDocument();
    expect(menu.getByRole('button', { name: 'الإعدادات' })).toBeInTheDocument();
    // Link names only (the requests item carries a pending-count badge beside it).
    expect(menu.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'الرئيسية',
      'حصص اليوم',
      'الجدول',
      'طلبات الحصص',
      'العملاء المحتملون',
      'تقارير الحصص',
      'الاختبارات والنتائج',
      'صندوق الطلبات',
      'فرز البلاغات',
      'طلباتي',
      'المهام',
      'الإعلانات',
      'العائلات',
      'الطلاب',
      'المعلمون',
      'الموظفون',
      'الفواتير',
      'الباقات',
      'الحضور والإجازات',
      'الغرامات والبنود',
      'مسيّرات الرواتب',
      'ملفات الرواتب',
      'المحافظ',
      'العطلات الرسمية',
      'إعدادات الحصص',
      'إعدادات الدعم',
      'إعدادات العملاء المحتملين',
      'إعدادات الفوترة',
      'قواعد الأجر',
      'الأدوار والصلاحيات',
    ]);
    // «طلبات الحصص» shows the pending count (K3).
    expect(await menu.findByText('طلبات قيد المراجعة')).toBeInTheDocument();
    // Account menu in the top bar (current app layout): the avatar shows the name's first letter.
    expect(screen.getByRole('button', { name: 'حسابي' })).toHaveTextContent('م');
    expect(screen.getByRole('button', { name: 'Switch to English' })).toBeInTheDocument();
  });

  it('gives a teacher and a parent their own classes, requests and people, nothing company-wide', async () => {
    for (const [email, items] of [
      [
        'teacher@qarabic.test',
        ['حصصي', 'طلابي', 'جدولي', 'الاختبارات', 'حضوري وإجازاتي', 'راتبي', 'طلباتي', 'الإعلانات'],
      ],
      ['parent@qarabic.test', ['حصص أبنائي', 'فواتيري', 'طلباتي', 'عائلتي', 'الإعلانات']],
    ] as const) {
      mockSignIn(email);
      const { unmount } = renderShell();
      const menu = await sidebarMenu();
      await waitFor(() =>
        expect(menu.getAllByRole('link').map((l) => l.textContent)).toEqual(['الرئيسية', ...items]),
      );
      unmount();
    }
  });

  it('marks the current page in the sidebar', async () => {
    mockSignIn('admin@qarabic.test');
    routerMock.pathname = '/roles';
    renderShell();
    const menu = await sidebarMenu();
    expect(menu.getByRole('link', { name: 'الأدوار والصلاحيات' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('Roles page', () => {
  it('renders the roles table for an admin', async () => {
    mockSignIn('admin@qarabic.test');
    routerMock.pathname = '/roles';
    renderShell(<RolesView />);
    const table = await screen.findByRole('table', { name: 'الأدوار' });
    expect(await within(table).findByText('مشرف متابعة')).toBeInTheDocument();
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(11); // header + 9 system roles + the mock custom role
    expect(within(table).getAllByText('معدَّل')).toHaveLength(2);
    expect(screen.getByText('10 أدوار')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'دور جديد' })).toBeInTheDocument();
  });

  it('shows no-access instead of the table without roles.view', async () => {
    mockSignIn('teacher@qarabic.test');
    routerMock.pathname = '/roles';
    renderShell(<RolesView />);
    expect(await screen.findByText('ليست لديك صلاحية')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
