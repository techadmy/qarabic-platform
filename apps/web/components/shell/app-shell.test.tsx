import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RolesView } from '@/app/(app)/roles/roles-view';
import { mockSignIn } from '@/mocks/handlers';
import { renderWithProviders } from '@/test/render';
import { routerMock } from '@/test/router-mock';
import { AppShell } from './app-shell';

/** The sidebar's menu (the breadcrumb also has role="link"). */
async function sidebarMenu() {
  await screen.findByText('القائمة الرئيسية');
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
    // Account menu in the top bar (current app layout): the avatar shows the name's first letter.
    expect(screen.getByRole('button', { name: 'حسابي' })).toHaveTextContent('م');
    expect(screen.getByRole('button', { name: 'Switch to English' })).toBeInTheDocument();
  });

  it('hides «الأدوار والصلاحيات» without roles.view (teacher, parent)', async () => {
    for (const email of ['teacher@qarabic.test', 'parent@qarabic.test']) {
      mockSignIn(email);
      const { unmount } = renderShell();
      const menu = await sidebarMenu();
      expect(menu.getByRole('link', { name: 'الرئيسية' })).toBeInTheDocument();
      expect(menu.queryByRole('link', { name: 'الأدوار والصلاحيات' })).not.toBeInTheDocument();
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
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(10); // header + 9 system roles
    expect(within(table).getByText('مشرف متابعة')).toBeInTheDocument();
    expect(within(table).getByText('معدَّل')).toBeInTheDocument();
    expect(screen.getByText('9 أدوار')).toBeInTheDocument();
  });

  it('shows no-access instead of the table without roles.view', async () => {
    mockSignIn('teacher@qarabic.test');
    routerMock.pathname = '/roles';
    renderShell(<RolesView />);
    expect(await screen.findByText('ليست لديك صلاحية')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
