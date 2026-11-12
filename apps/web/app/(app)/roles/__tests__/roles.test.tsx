import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { allPermissions } from '@qarabic/shared';
import { describe, expect, it } from 'vitest';
import { server } from '@/mocks/node';
import { renderPage } from '@/test/people';
import { routerMock } from '@/test/router-mock';
import { RoleEditor } from '../role-editor';
import { RolesView } from '../roles-view';

async function matrix() {
  return screen.findByRole('group', { name: 'العائلات والطلاب' });
}

describe('Roles list', () => {
  it('shows kind, users, permissions and the customised badge; custom roles can be deleted', async () => {
    renderPage(<RolesView />, { path: '/roles' });
    const table = await screen.findByRole('table', { name: 'الأدوار' });
    const row = (await within(table).findByRole('link', { name: 'مشرف' })).closest('tr')!;
    expect(within(row).getByText('مخصص')).toBeInTheDocument();
    expect(within(row).getByText('مستخدم واحد')).toBeInTheDocument();
    // The total follows the shared catalogue (M8 added `tasks.oversee`).
    expect(within(row).getByText(`7 من ${allPermissions().length}`)).toBeInTheDocument();
    const owner = within(table).getByRole('link', { name: 'المالك (مدير النظام)' }).closest('tr')!;
    expect(within(owner).getByText('كل الصلاحيات')).toBeInTheDocument();
    // A role in use cannot be deleted: the dialog says why and has no delete button.
    await userEvent.setup().click(within(row).getByRole('button', { name: 'حذف الدور «مشرف»' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/مُسند إلى مستخدم واحد/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'احذف الدور' })).not.toBeInTheDocument();
  });
});

describe('Role editor (permission matrix)', () => {
  it('the owner role is read-only with its note', async () => {
    renderPage(<RoleEditor id={1} />, { path: '/roles/1' });
    expect(await screen.findByText(/كل الصلاحيات دائمًا/)).toBeInTheDocument();
    const families = await matrix();
    for (const box of within(families).getAllByRole('checkbox')) {
      expect(box).toBeDisabled();
      expect(box).toBeChecked();
    }
  });

  it('disables the cells the viewer cannot grant and says why (no escalation)', async () => {
    // The supervisor manages roles but holds only some permissions; the monitor preset is editable.
    renderPage(<RoleEditor id={4} />, { as: 'supervisor@qarabic.test', path: '/roles/4' });
    const families = await matrix();
    expect(within(families).getByRole('checkbox', { name: /^إدارة/ })).toBeEnabled();
    const leads = screen.getByRole('group', { name: 'العملاء المحتملون' });
    const leadsView = within(leads).getByRole('checkbox', { name: /^عرض/ });
    expect(leadsView).toBeDisabled();
    expect(leadsView).toHaveAccessibleDescription(/لا تملكها، فلا يمكنك منحها/);
    expect(screen.getByText(/الخانات المقفلة صلاحيات لا تملكها/)).toBeInTheDocument();
  });

  it('counts changes, confirms with the number of users, then saves the new list', async () => {
    let body: { permissions?: string[] } | null = null;
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PATCH' && request.url.endsWith('/roles/4'))
        body = await request.clone().json();
    });
    renderPage(<RoleEditor id={4} />, { path: '/roles/4' });
    const user = userEvent.setup();
    const families = await matrix();
    expect(screen.getByText('لا توجد تغييرات')).toBeInTheDocument();
    await user.click(within(families).getByRole('checkbox', { name: /^إدارة/ }));
    expect(screen.getByText('تغيير واحد لم يُحفظ')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'حفظ صلاحيات الدور؟' });
    expect(within(confirm).getByText(/صلاحية واحدة/)).toHaveTextContent(/مستخدمَين/);
    await user.click(within(confirm).getByRole('button', { name: 'احفظ التغييرات' }));
    expect(await screen.findByText('حُفظت التغييرات')).toBeInTheDocument();
    expect(body!.permissions).toContain('families.manage');
    expect(screen.getByText('لا توجد تغييرات')).toBeInTheDocument();
    server.events.removeAllListeners();
  });

  it('«الكل» ticks every action of a module and «تراجع» puts the saved list back', async () => {
    renderPage(<RoleEditor id={4} />, { path: '/roles/4' });
    const user = userEvent.setup();
    const leads = await screen.findByRole('group', { name: 'العملاء المحتملون' });
    await user.click(within(leads).getByRole('checkbox', { name: 'كل صلاحيات العملاء المحتملون' }));
    for (const box of within(leads).getAllByRole('checkbox')) expect(box).toBeChecked();
    expect(screen.getByText('4 تغييرات لم تُحفظ')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'تراجع' }));
    expect(screen.getByText('لا توجد تغييرات')).toBeInTheDocument();
  });

  it('creates a custom role from a copy, dropping what the viewer cannot grant', async () => {
    routerMock.search = 'copyFrom=4';
    renderPage(<RoleEditor />, { as: 'supervisor@qarabic.test', path: '/roles/new?copyFrom=4' });
    expect(await screen.findByDisplayValue('نسخة من مشرف متابعة')).toBeInTheDocument();
    expect(screen.getByText(/لم تُنسخ \d+ صلاحي/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'أنشئ الدور' }));
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith('/roles/11'));
  });

  it('shows the server refusal on save', async () => {
    server.use(
      http.patch('*/api/v1/roles/4', () =>
        HttpResponse.json({ message: 'no', code: 'permission_not_held' }, { status: 409 }),
      ),
    );
    renderPage(<RoleEditor id={4} />, { path: '/roles/4' });
    const user = userEvent.setup();
    await user.click(within(await matrix()).getByRole('checkbox', { name: /^إدارة/ }));
    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    await user.click(await screen.findByRole('button', { name: 'احفظ التغييرات' }));
    expect(await screen.findByText('لا يمكنك منح صلاحية لا تملكها.')).toBeInTheDocument();
  });
});
