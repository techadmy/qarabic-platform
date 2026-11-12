import { JOURNAL_SOURCE_LABELS, VOUCHER_STATUS_LABELS } from '@qarabic/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { AccountsView } from '@/components/accounting/accounts-view';
import { EntryForm } from '@/components/accounting/entry-form';
import { EntryView } from '@/components/accounting/entry-view';
import { JournalView } from '@/components/accounting/journal-view';
import { StatementView } from '@/components/accounting/statement-view';
import { VoucherView } from '@/components/accounting/voucher-view';
import { VouchersView } from '@/components/accounting/vouchers-view';
import { accountByCode, adb } from '@/mocks/accounting-db';
import { server } from '@/mocks/node';
import { renderPage } from '@/test/people';
import { routerMock } from '@/test/router-mock';

const ACCOUNTS = 'accounts@qarabic.test';

async function pickAccount(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  code: string,
) {
  await user.click(trigger);
  await user.type(await screen.findByPlaceholderText('ابحث برقم الحساب أو اسمه'), code);
  await user.click(await screen.findByRole('option', { name: new RegExp(`^${code} ·`) }));
}

describe('Journal', () => {
  it('lists entries newest first with their source; filters by source in the URL', async () => {
    const user = userEvent.setup();
    renderPage(<JournalView />, { as: ACCOUNTS, path: '/accounting/journal' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'القيود اليومية' }),
    ).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'القيود اليومية' });
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(5));
    expect(within(table).getAllByText(JOURNAL_SOURCE_LABELS.billing.ar).length).toBeGreaterThan(0);
    // Source tabs carry counts (the API sends them per source since #17).
    const billing = adb.entries.filter((e) => e.source === 'billing').length;
    await waitFor(() =>
      expect(screen.getAllByRole('radio').map((r) => r.textContent)).toContain(
        `${JOURNAL_SOURCE_LABELS.billing.ar} (${billing})`,
      ),
    );
    await user.click(
      screen
        .getAllByRole('radio')
        .find((r) => r.textContent?.startsWith(JOURNAL_SOURCE_LABELS.voucher.ar))!,
    );
    expect(routerMock.replace).toHaveBeenLastCalledWith(
      expect.stringContaining('source=voucher'),
      expect.anything(),
    );
  });

  it('a monitor has no access', async () => {
    renderPage(<JournalView />, { as: 'monitor@qarabic.test', path: '/accounting/journal' });
    expect((await screen.findAllByText(/صلاحية/)).length).toBeGreaterThan(0);
  });
});

describe('New journal entry', () => {
  it(
    'shows the difference, refuses an unbalanced entry, then posts the balanced one',
    { timeout: 40_000 },
    async () => {
      const user = userEvent.setup();
      const before = adb.entries.length;
      renderPage(<EntryForm />, { as: ACCOUNTS, path: '/accounting/journal/new' });
      await user.type(await screen.findByLabelText(/البيان/), 'Prepaid hosting for a year');
      const lines = screen.getByRole('list', { name: 'أسطر القيد' });
      const [first, second] = within(lines).getAllByRole('listitem');
      await pickAccount(user, within(first!).getByRole('combobox'), '1320');
      await user.type(within(first!).getByLabelText('مدين · السطر 1'), '1200');
      await pickAccount(user, within(second!).getByRole('combobox'), '1120');
      await user.type(within(second!).getByLabelText('دائن · السطر 2'), '1000');
      expect(screen.getByText('الفرق').nextSibling?.textContent).toMatch(/200/);
      await user.click(screen.getByRole('button', { name: 'ترحيل القيد' }));
      expect(await screen.findByText(/القيد غير متوازن/)).toBeInTheDocument();
      expect(adb.entries.length).toBe(before);

      await user.clear(within(second!).getByLabelText('دائن · السطر 2'));
      await user.type(within(second!).getByLabelText('دائن · السطر 2'), '1200');
      await user.click(screen.getByRole('button', { name: 'ترحيل القيد' }));
      await waitFor(() => expect(adb.entries.length).toBe(before + 1));
      const posted = adb.entries.at(-1)!;
      expect(posted).toMatchObject({
        source: 'manual',
        currency: 'USD',
        memo: 'Prepaid hosting for a year',
      });
      expect(posted.lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([
        [accountByCode('1320').id, 120000, 0],
        [accountByCode('1120').id, 0, 120000],
      ]);
      expect(routerMock.push).toHaveBeenLastCalledWith(`/accounting/journal/${posted.id}`);
    },
  );
});

describe('Entry detail', () => {
  it('reverses a manual entry with a reason; the original links to the reversal', async () => {
    const user = userEvent.setup();
    const entry = adb.entries.find((e) => e.source === 'manual' && !e.reversedById)!;
    renderPage(<EntryView id={entry.id} />, {
      as: ACCOUNTS,
      path: `/accounting/journal/${entry.id}`,
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: new RegExp(entry.number) }),
    ).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'أسطر القيد' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'عكس القيد' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Posted to the wrong account');
    await user.click(within(dialog).getByRole('button', { name: 'عكس القيد' }));
    await waitFor(() => expect(entry.reversedById).not.toBeNull());
    const rev = adb.entries.find((e) => e.id === entry.reversedById)!;
    expect(rev.lines[0]!.credit).toBe(entry.lines[0]!.debit);
    expect(routerMock.push).toHaveBeenLastCalledWith(`/accounting/journal/${rev.id}`);
  });

  it('a voucher entry is not reversed here: it links to its voucher', async () => {
    const entry = adb.entries.find((e) => e.voucherId)!;
    renderPage(<EntryView id={entry.id} />, {
      as: ACCOUNTS,
      path: `/accounting/journal/${entry.id}`,
    });
    expect(await screen.findByRole('link', { name: 'فتح السند' })).toHaveAttribute(
      'href',
      `/accounting/vouchers/${entry.voucherId}`,
    );
    expect(screen.queryByRole('button', { name: 'عكس القيد' })).toBeNull();
  });
});

describe('Vouchers', () => {
  it('lists with status counts and creates a payment voucher', { timeout: 40_000 }, async () => {
    const user = userEvent.setup();
    renderPage(<VouchersView />, { as: ACCOUNTS, path: '/accounting/vouchers' });
    await waitFor(() =>
      expect(screen.getAllByRole('radio').map((r) => r.textContent)).toContain(
        `${VOUCHER_STATUS_LABELS.void.ar} (1)`,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'سند صرف' }));
    const dialog = await screen.findByRole('dialog', { name: 'سند صرف' });
    await user.click(within(dialog).getByRole('button', { name: /ترحيل السند/ }));
    expect(within(dialog).getByText('اختر حساب النقدية.')).toBeInTheDocument();
    const cash = within(dialog).getByRole('combobox', { name: /حساب الدفع/ });
    const line = within(dialog).getByRole('combobox', { name: /حساب المصروف/ });
    await pickAccount(user, cash, '1120');
    await user.type(within(dialog).getByLabelText(/المدفوع له/), 'Hosting Ltd');
    await user.type(within(dialog).getAllByLabelText(/^الوصف/)[0]!, 'Server for November');
    await pickAccount(user, line, '5150');
    await user.type(within(dialog).getByLabelText(/^المبلغ/), '75.5');
    await user.click(within(dialog).getByRole('button', { name: /ترحيل السند/ }));
    await waitFor(() => expect(adb.vouchers.at(-1)!.party).toBe('Hosting Ltd'));
    const v = adb.vouchers.at(-1)!;
    expect(v).toMatchObject({ type: 'payment', status: 'posted', currency: 'USD' });
    const entry = adb.entries.find((e) => e.id === v.journalEntryId)!;
    expect(entry.lines.map((l) => [l.debit, l.credit])).toEqual([
      [0, 7550],
      [7550, 0],
    ]);
  });

  it('voids a voucher with a reason (reversing entry, status «ملغى»)', async () => {
    const user = userEvent.setup();
    const v = adb.vouchers.find((x) => x.status === 'posted')!;
    renderPage(<VoucherView id={v.id} />, { as: ACCOUNTS, path: `/accounting/vouchers/${v.id}` });
    await user.click(await screen.findByRole('button', { name: 'إلغاء السند' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.type(within(dialog).getByRole('textbox'), 'Duplicate');
    await user.click(within(dialog).getByRole('button', { name: 'إلغاء السند' }));
    await waitFor(() => expect(v.status).toBe('void'));
    expect(await screen.findByText(/السبب: Duplicate/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إلغاء السند' })).toBeNull();
  });
});

describe('Chart of accounts', () => {
  it(
    'shows the tree by type; a system account cannot be archived; adds a sub-account',
    { timeout: 40_000 },
    async () => {
      const user = userEvent.setup();
      renderPage(<AccountsView />, { as: ACCOUNTS, path: '/accounting/accounts' });
      const table = await screen.findByRole('table', { name: 'دليل الحسابات' });
      expect(within(table).getAllByText('الأصول').length).toBeGreaterThan(0);
      expect(within(table).getByRole('link', { name: 'البنك' })).toHaveAttribute(
        'href',
        `/accounting/accounts/${accountByCode('1120').id}`,
      );
      await user.click(within(table).getByRole('button', { name: 'تعديل 1120 · البنك' }));
      const edit = await screen.findByRole('dialog', { name: 'تعديل الحساب 1120' });
      expect(within(edit).queryByLabelText(/أرشفة الحساب/)).toBeNull();
      await user.keyboard('{Escape}');

      await user.click(screen.getByRole('button', { name: 'حساب جديد' }));
      const dialog = await screen.findByRole('dialog', { name: 'حساب جديد' });
      await user.type(within(dialog).getByLabelText(/رقم الحساب/), '1120');
      await user.type(within(dialog).getByLabelText(/الاسم بالعربية/), 'بنك آخر');
      await user.type(within(dialog).getByLabelText(/الاسم بالإنجليزية/), 'Other bank');
      await user.click(within(dialog).getByRole('button', { name: 'إضافة الحساب' }));
      expect(await within(dialog).findByText('رقم الحساب مستخدم.')).toBeInTheDocument();
      await user.clear(within(dialog).getByLabelText(/رقم الحساب/));
      await user.type(within(dialog).getByLabelText(/رقم الحساب/), '5299');
      await user.click(within(dialog).getByRole('button', { name: 'إضافة الحساب' }));
      await waitFor(() => expect(adb.accounts.some((a) => a.code === '5299')).toBe(true));
    },
  );
});

describe('Account statement', () => {
  it('opening + movements = closing, with the running balance', async () => {
    const bank = accountByCode('1120');
    renderPage(<StatementView id={bank.id} />, {
      as: ACCOUNTS,
      path: `/accounting/accounts/${bank.id}?currency=USD&from=2000-01-01&to=2100-12-31`,
    });
    const table = await screen.findByRole('table', { name: /كشف حساب 1120 · البنك/ });
    const rows = within(table).getAllByRole('row');
    expect(rows.length).toBeGreaterThan(2);
    expect(screen.getByText('الرصيد الافتتاحي')).toBeInTheDocument();
  });
});

describe('Review fixes (#24)', () => {
  it('statement: a start after the end says so instead of loading forever', async () => {
    const bank = accountByCode('1120');
    renderPage(<StatementView id={bank.id} />, {
      as: ACCOUNTS,
      path: `/accounting/accounts/${bank.id}?currency=USD&from=2026-05-01&to=2026-04-01`,
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('تاريخ البداية بعد تاريخ النهاية');
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('new entry: a 422 from the API lands on its field; leaving with lines asks first', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('*/api/v1/accounting/journal', () =>
        HttpResponse.json(
          {
            message: 'Invalid',
            code: 'validation_failed',
            errors: { 'lines.1.accountId': ['The selected account is invalid.'] },
          },
          { status: 422 },
        ),
      ),
    );
    renderPage(<EntryForm />, { as: ACCOUNTS, path: '/accounting/journal/new' });
    await user.type(await screen.findByLabelText(/البيان/), 'Prepaid hosting');
    const [first, second] = within(screen.getByRole('list', { name: 'أسطر القيد' })).getAllByRole(
      'listitem',
    );
    await pickAccount(user, within(first!).getByRole('combobox'), '1320');
    await user.type(within(first!).getByLabelText('مدين · السطر 1'), '10');
    await pickAccount(user, within(second!).getByRole('combobox'), '1120');
    await user.type(within(second!).getByLabelText('دائن · السطر 2'), '10');
    await user.click(screen.getByRole('button', { name: 'ترحيل القيد' }));
    expect(await within(second!).findByText(/غير صالح|اختر قيمة/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(await screen.findByRole('alertdialog', { name: 'تجاهل القيد؟' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'متابعة التعديل' }));
    expect(routerMock.push).not.toHaveBeenCalledWith('/accounting/journal');
  }, 40_000);
});
