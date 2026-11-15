import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { RatesView } from '@/components/accounting/rates-view';
import { MOCK_USERS } from '@/mocks/data';
import { lastReplacedUrl, renderPage } from '@/test/people';

/** D144/D146: accounts keep the monthly exchange rates without seeing the ledger. */
const ACCOUNTS = 'accounts@qarabic.test';
const table = () => screen.findByRole('table', { name: /أسعار الصرف لسنة/ });

describe('Exchange rates (D144, D146)', () => {
  it('accounts see the year’s rates, newest month first, as «1 GBP = 1.2700 USD»', async () => {
    renderPage(<RatesView />, { as: ACCOUNTS, path: '/accounting/rates?year=2026' });
    await screen.findByText('1 GBP = 1.2700 USD');
    const rows = within(await table())
      .getAllByRole('row')
      .slice(1);
    expect(rows[0]).toHaveTextContent('نوفمبر 2026');
    expect(rows[0]).toHaveTextContent('1 EGP = 0.0205 USD');
    expect(screen.getByRole('button', { name: 'إضافة سعر' })).toBeInTheDocument();
  });

  it('a missing rate opens prefilled from the URL; the rate is checked, then saved', async () => {
    const user = userEvent.setup();
    renderPage(<RatesView />, {
      as: ACCOUNTS,
      path: '/accounting/rates?year=2025&new=1&currency=GBP&month=2025-12',
    });
    const dialog = await screen.findByRole('dialog', { name: 'إضافة سعر صرف' });
    const rate = within(dialog).getByLabelText(/قيمة 1 GBP بالدولار/);
    await user.click(within(dialog).getByRole('button', { name: 'حفظ السعر' }));
    expect(within(dialog).getByText('أدخل السعر.')).toBeInTheDocument();
    await user.type(rate, '-1');
    expect(within(dialog).getByText(/أدخل رقمًا موجبًا/)).toBeInTheDocument();
    await user.clear(rate);
    // Arabic-Indic digits and the Arabic decimal mark are read as a number; a preview says it.
    await user.type(rate, '١٫٢٧٤٥');
    expect(within(dialog).getByText('100 GBP = 127.4500 USD')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'حفظ السعر' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('1 GBP = 1.2745 USD')).toBeInTheDocument();
    expect(lastReplacedUrl().searchParams.get('new')).toBeNull();
  });

  it('editing keeps the currency and month; deleting needs a reason', async () => {
    const user = userEvent.setup();
    renderPage(<RatesView />, { as: ACCOUNTS, path: '/accounting/rates?year=2026&currency=EUR' });
    await table();
    await user.click(await screen.findByRole('button', { name: /تعديل سعر EUR · أكتوبر 2026/ }));
    const dialog = await screen.findByRole('dialog', { name: 'تعديل سعر الصرف' });
    expect(within(dialog).getByRole('combobox', { name: /العملة/ })).toBeDisabled();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /حذف سعر EUR · أكتوبر 2026/ }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'حذف السعر' }));
    expect(screen.queryByText('1 EUR = 1.0800 USD')).toBeInTheDocument();
    await user.type(within(confirm).getByRole('textbox', { name: /سبب الحذف/ }), 'سعر خاطئ');
    await user.click(within(confirm).getByRole('button', { name: 'حذف السعر' }));
    expect(await screen.findByText('لا أسعار صرف مسجّلة لسنة 2026')).toBeInTheDocument();
  });

  it('adding a month that has a rate shows it and needs «استبدال السعر» with a reason (P1)', async () => {
    const user = userEvent.setup();
    renderPage(<RatesView />, {
      as: ACCOUNTS,
      path: '/accounting/rates?year=2026&new=1&currency=GBP&month=2026-11',
    });
    const dialog = await screen.findByRole('dialog', { name: 'إضافة سعر صرف' });
    expect(await within(dialog).findByText('لـGBP سعر مسجّل لشهر نوفمبر 2026')).toBeInTheDocument();
    expect(within(dialog).getByText('1 GBP = 1.2700 USD')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/قيمة 1 GBP بالدولار/), '1.3');
    const replace = within(dialog).getByRole('button', { name: 'استبدال السعر' });
    await user.click(replace);
    expect(within(dialog).getByText(/اكتب سبب الاستبدال/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /سبب الاستبدال/ }), 'تصحيح السعر');
    await user.click(replace);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('1 GBP = 1.3000 USD')).toBeInTheDocument();
  });

  it('who only reads reports sees the rates without changing them', async () => {
    const accounts = MOCK_USERS.find((u) => u.email === ACCOUNTS)!;
    const kept = accounts.permissions;
    accounts.permissions = kept.filter((p) => p !== 'accounting.rates');
    try {
      renderPage(<RatesView />, { as: ACCOUNTS, path: '/accounting/rates?year=2026' });
      await table();
      expect(screen.queryByRole('button', { name: 'إضافة سعر' })).toBeNull();
      expect(screen.queryByRole('button', { name: /تعديل سعر/ })).toBeNull();
    } finally {
      accounts.permissions = kept;
    }
  });

  it('without accounting.view or reports.financial the page is forbidden', async () => {
    renderPage(<RatesView />, { as: 'monitor@qarabic.test', path: '/accounting/rates' });
    expect((await screen.findAllByText(/ليست لديك صلاحية/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table')).toBeNull();
  });
});
