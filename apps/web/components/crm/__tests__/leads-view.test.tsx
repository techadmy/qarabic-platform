import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LeadsView } from '@/components/crm/leads-view';
import { crmdb } from '@/mocks/crm-db';
import { lastReplacedUrl, renderPage } from '@/test/people';
import { routerMock } from '@/test/router-mock';

async function table() {
  const t = await screen.findByRole('table', { name: 'العملاء المحتملون' });
  await waitFor(() => expect(t).not.toHaveAttribute('aria-busy'));
  return t;
}

function tiles() {
  return screen.getByRole('navigation', { name: 'ملخص اليوم' });
}

describe('Leads list', () => {
  it('shows today’s tiles with the summary counts and the open tab with its count', async () => {
    renderPage(<LeadsView />, { path: '/leads' });
    const t = await table();
    const nav = tiles();
    // Four open leads are «جديد» and none of them was contacted; three passed the 30-minute limit.
    const fresh = within(nav).getByRole('button', { name: /طلبات جديدة/ });
    await waitFor(() => expect(fresh).toHaveTextContent(/^4/));
    const uncontacted = within(nav).getByRole('button', { name: /لم يُتواصل معها/ });
    expect(uncontacted).toHaveTextContent('4');
    expect(uncontacted).toHaveTextContent('متأخرة: 3');
    // (Not «تحوّلت هذا الشهر»: the seed converted 3 days ago, last month on the 1st–3rd.)
    expect(within(nav).getByRole('button', { name: /تحوّلت هذا الشهر/ })).toBeInTheDocument();
    const tabs = screen.getByRole('radiogroup', { name: 'حالة الطلب' });
    expect(within(tabs).getByRole('radio', { name: /^المفتوحة\s*\(8\)$/ })).toBeChecked();
    expect(within(tabs).getByRole('radio', { name: /^جديد\s*\(4\)$/ })).toBeInTheDocument();
    // 8 open leads + the header row.
    expect(within(t).getAllByRole('row')).toHaveLength(9);
    expect(within(t).getByRole('link', { name: 'Amina Rahman' })).toHaveAttribute(
      'href',
      '/leads/1',
    );
    expect(within(t).queryByRole('link', { name: 'Nadia Karim' })).not.toBeInTheDocument();
  });

  it('a tile puts its filter in the URL', async () => {
    const user = userEvent.setup();
    renderPage(<LeadsView />, { path: '/leads' });
    await table();
    await user.click(within(tiles()).getByRole('button', { name: /طلبات جديدة/ }));
    expect(lastReplacedUrl().searchParams.get('status')).toBe('new');
    await user.click(within(tiles()).getByRole('button', { name: /متابعات اليوم/ }));
    expect(lastReplacedUrl().searchParams.get('followUp')).toBe('due');
  });

  it('puts the status tab in the URL and lists only that status', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage(<LeadsView />, { path: '/leads' });
    await table();
    await user.click(screen.getByRole('radio', { name: /^تحوّل إلى منتظم\s*\(1\)$/ }));
    expect(lastReplacedUrl().searchParams.get('status')).toBe('converted');
    unmount();

    renderPage(<LeadsView />, { path: '/leads?status=converted' });
    const t = await table();
    await waitFor(() => expect(within(t).getAllByRole('row')).toHaveLength(2));
    expect(within(t).getByRole('link', { name: 'Nadia Karim' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^تحوّل إلى منتظم\s*\(1\)$/ })).toBeChecked();
  });

  it('reflects search and filters in the URL, and reads them back from it', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage(<LeadsView />, { path: '/leads' });
    await table();
    await user.type(screen.getByRole('searchbox', { name: 'البحث' }), 'Amina');
    await waitFor(() => expect(lastReplacedUrl().searchParams.get('q')).toBe('Amina'));
    await user.click(screen.getByRole('switch', { name: 'المتابعات المستحقة' }));
    expect(lastReplacedUrl().searchParams.get('followUp')).toBe('due');
    unmount();

    renderPage(<LeadsView />, { path: '/leads?q=Amina' });
    const t = await table();
    await waitFor(() => expect(within(t).getAllByRole('row')).toHaveLength(2));
    expect(within(t).getByRole('link', { name: 'Amina Rahman' })).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'مسح الكل' })[0]!);
    expect(lastReplacedUrl().searchParams.get('q')).toBeNull();
  });

  it('says so when the filters match nothing', async () => {
    renderPage(<LeadsView />, { path: '/leads?q=zzzz' });
    expect(
      (await screen.findAllByText('لا نتائج مع عوامل التصفية الحالية.'))[0],
    ).toBeInTheDocument();
  });

  it('shows the bulk bar with the count of selected rows, and clears it', async () => {
    const user = userEvent.setup();
    renderPage(<LeadsView />, { path: '/leads' });
    const t = await table();
    expect(screen.queryByRole('region', { name: /^المحدد:/ })).not.toBeInTheDocument();
    await user.click(within(t).getByRole('checkbox', { name: 'تحديد طلب Amina Rahman' }));
    await user.click(within(t).getByRole('checkbox', { name: 'تحديد طلب Omar Haddad' }));
    const bar = screen.getByRole('region', { name: 'المحدد: 2' });
    expect(within(bar).getByRole('button', { name: 'إسناد' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'غير مهتم' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'رسائل مزعجة' })).toBeInTheDocument();
    await user.click(within(t).getByRole('checkbox', { name: 'تحديد كل طلبات الصفحة' }));
    expect(screen.getByRole('region', { name: 'المحدد: 8' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'إلغاء التحديد' }));
    expect(screen.queryByRole('region', { name: /^المحدد:/ })).not.toBeInTheDocument();
  });

  it('bulk «غير مهتم» asks for the reason with the count, then updates the leads', async () => {
    const user = userEvent.setup();
    renderPage(<LeadsView />, { path: '/leads' });
    const t = await table();
    await user.click(within(t).getByRole('checkbox', { name: 'تحديد طلب Amina Rahman' }));
    await user.click(
      within(screen.getByRole('region', { name: 'المحدد: 1' })).getByRole('button', {
        name: 'غير مهتم',
      }),
    );
    const dialog = await screen.findByRole('alertdialog', {
      name: 'تعليم 1 من الطلبات بأنها غير مهتمة؟',
    });
    // The reason is required.
    await user.click(within(dialog).getByRole('button', { name: 'غير مهتم' }));
    expect(await within(dialog).findByText('اختر السبب')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('combobox', { name: /السبب/ }));
    await user.click(await screen.findByRole('option', { name: 'السعر' }));
    await user.click(within(dialog).getByRole('button', { name: 'غير مهتم' }));
    expect((await screen.findAllByText('عُدّل 1 من الطلبات.'))[0]).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(crmdb.leads.find((l) => l.id === 1)).toMatchObject({
      status: 'lost',
      lostReason: 'price',
    });
    await waitFor(() =>
      expect(within(t).queryByRole('link', { name: 'Amina Rahman' })).not.toBeInTheDocument(),
    );
  });

  it('shows the forbidden state without leads.view', async () => {
    renderPage(<LeadsView />, { as: 'teacher@qarabic.test', path: '/leads' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'العملاء المحتملون' }),
    ).toBeVisible();
    expect(screen.queryByRole('table', { name: 'العملاء المحتملون' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'ملخص اليوم' })).not.toBeInTheDocument();
  });

  it('«طلب جديد» needs a name and a contact, then adds the lead and opens it', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(<LeadsView />, { path: '/leads' });
    await table();
    await user.click(screen.getByRole('button', { name: 'طلب جديد' }));
    const dialog = await screen.findByRole('dialog', { name: 'طلب جديد' });
    await user.click(within(dialog).getByRole('button', { name: 'أضف الطلب' }));
    const name = within(dialog).getByLabelText(/^اسم ولي الأمر/);
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
    expect(within(dialog).getByLabelText(/^رقم الهاتف/)).toHaveAttribute('aria-invalid', 'true');
    await user.type(name, 'Walk In Parent');
    await user.type(within(dialog).getByLabelText(/^البريد الإلكتروني/), 'walk.in@example.com');
    const id = crmdb.nextId.lead;
    await user.click(within(dialog).getByRole('button', { name: 'أضف الطلب' }));
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith(`/leads/${id}`));
    expect(crmdb.leads.find((l) => l.id === id)).toMatchObject({
      parentName: 'Walk In Parent',
      email: 'walk.in@example.com',
      source: 'phone',
    });
  });
});
