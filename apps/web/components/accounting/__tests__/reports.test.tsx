import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PeriodsView } from '@/components/accounting/periods-view';
import { ReportsView } from '@/components/accounting/reports-view';
import { adb } from '@/mocks/accounting-db';
import { renderPage } from '@/test/people';

const ACCOUNTS = 'accounts@qarabic.test';
const WIDE = 'from=2000-01-01&to=2100-12-31';
const monthBack = (n: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1)).toISOString().slice(0, 7);
};

describe('Financial reports', () => {
  it('trial balance: balanced, debits equal credits in the totals', async () => {
    renderPage(<ReportsView />, { as: ACCOUNTS, path: `/accounting/reports?currency=USD&${WIDE}` });
    const table = await screen.findByRole('table', { name: 'ميزان المراجعة' });
    expect(screen.getByText('متوازن')).toBeInTheDocument();
    const totals = within(table).getAllByRole('row').at(-1)!;
    const cells = within(totals)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cells[4]).toBe(cells[5]);
    expect(within(table).getByRole('link', { name: '1120 · البنك' })).toHaveAttribute(
      'href',
      expect.stringContaining('currency=USD'),
    );
  });

  it('profit and loss shows income, expenses and the net result', async () => {
    renderPage(<ReportsView />, {
      as: ACCOUNTS,
      path: `/accounting/reports?report=profit-and-loss&currency=USD&${WIDE}`,
    });
    expect(await screen.findByRole('table', { name: 'الإيرادات' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'المصروفات' })).toBeInTheDocument();
    expect(screen.getByText(/صافي (الربح|الخسارة)/)).toBeInTheDocument();
  });

  it('balance sheet balances (earnings to date in equity)', async () => {
    renderPage(<ReportsView />, {
      as: ACCOUNTS,
      path: '/accounting/reports?report=balance-sheet&currency=EGP',
    });
    expect(await screen.findByText('أرباح الفترات حتى التاريخ')).toBeInTheDocument();
    expect(screen.getByText('متوازن')).toBeInTheDocument();
  });

  it('cash: every currency by default', async () => {
    renderPage(<ReportsView />, { as: ACCOUNTS, path: `/accounting/reports?report=cash&${WIDE}` });
    expect(await screen.findByRole('table', { name: 'النقدية بعملة EGP' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'النقدية بعملة USD' })).toBeInTheDocument();
  });

  it('a start date after the end date is flagged, not sent', async () => {
    renderPage(<ReportsView />, {
      as: ACCOUNTS,
      path: '/accounting/reports?from=2026-05-01&to=2026-04-01',
    });
    expect(await screen.findByText(/تاريخ البداية بعد تاريخ النهاية/)).toBeInTheDocument();
  });
});

describe('Accounting periods', () => {
  it('posts the waiting automatic entries; the failed one stays listed', async () => {
    const user = userEvent.setup();
    renderPage(<PeriodsView />, { as: ACCOUNTS, path: '/accounting/periods' });
    expect(await screen.findByText('قيود تعذّر ترحيلها')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'رحّل الآن' }));
    expect(await screen.findByText('رُحِّل قيد واحد، وتعذّر قيد واحد.')).toBeInTheDocument();
    expect(adb.outbox).toHaveLength(1);
  });

  it('closes an ended month, then reopens it with a reason', async () => {
    const user = userEvent.setup();
    const period = monthBack(2);
    // Two months back can be last year (January, February): open that year.
    renderPage(<PeriodsView />, {
      as: ACCOUNTS,
      path: `/accounting/periods?year=${period.slice(0, 4)}`,
    });
    const table = await screen.findByRole('table', { name: /شهور سنة/ });
    const close = await within(table).findAllByRole('button', { name: /إقفال الفترة/ });
    const before = close.length;
    const row = adb.periods.find((p) => p.period === period);
    expect(row?.closed ?? false).toBe(false);
    const target = close.find((b) =>
      b
        .closest('tr')
        ?.textContent?.includes(
          new Intl.DateTimeFormat('ar-EG', { month: 'long', timeZone: 'UTC' }).format(
            new Date(`${period}-01T00:00:00Z`),
          ),
        ),
    )!;
    await user.click(target);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'إقفال الفترة' }));
    await waitFor(() => expect(adb.periods.find((p) => p.period === period)?.closed).toBe(true));
    await waitFor(() =>
      expect(within(table).getAllByRole('button', { name: /إقفال الفترة/ })).toHaveLength(
        before - 1,
      ),
    );
    const reopen = within(table)
      .getAllByRole('button', { name: /إعادة فتح/ })
      .at(-1)!;
    await user.click(reopen);
    const reason = await screen.findByRole('dialog');
    await user.type(within(reason).getByRole('textbox'), 'Late supplier invoice');
    await user.click(within(reason).getByRole('button', { name: 'إعادة فتح' }));
    await waitFor(() => expect(adb.periods.find((p) => p.period === period)?.closed).toBe(false));
  });

  it('closing offers «تراجع», which reopens the month at once', async () => {
    const user = userEvent.setup();
    const period = monthBack(2);
    renderPage(<PeriodsView />, {
      as: ACCOUNTS,
      path: `/accounting/periods?year=${period.slice(0, 4)}`,
    });
    const table = await screen.findByRole('table', { name: /شهور سنة/ });
    const month = new Intl.DateTimeFormat('ar-EG', { month: 'long', timeZone: 'UTC' }).format(
      new Date(`${period}-01T00:00:00Z`),
    );
    await within(table).findAllByText(new RegExp(month));
    const row = within(table)
      .getAllByRole('row')
      .find((r) => (r as HTMLTableRowElement).cells[0]?.textContent?.startsWith(month))!;
    await user.click(within(row).getByRole('button', { name: /إقفال الفترة/ }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'إقفال الفترة' }),
    );
    await user.click((await screen.findAllByRole('button', { name: 'تراجع' }))[0]!);
    await waitFor(() => expect(adb.periods.find((p) => p.period === period)?.closed).toBe(false));
    expect(adb.periods.find((p) => p.period === period)?.reopenReason).toBe(
      'تراجع فوري عن الإقفال',
    );
  });

  it('report tables name their rows and column groups for screen readers', async () => {
    renderPage(<ReportsView />, { as: ACCOUNTS, path: `/accounting/reports?currency=USD&${WIDE}` });
    const table = await screen.findByRole('table', { name: 'ميزان المراجعة' });
    expect(
      within(table).getAllByRole('columnheader', { name: 'الرصيد الافتتاحي' })[0],
    ).toHaveAttribute('scope', 'colgroup');
    expect(within(table).getByRole('rowheader', { name: '1120 · البنك' })).toBeInTheDocument();
  });
});
