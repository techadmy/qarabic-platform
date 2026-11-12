import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvoicesView } from '@/components/billing/invoices-view';
import { RunsView } from '@/components/payroll/runs-view';
import { renderPage } from '@/test/people';

/** D141 rollout 3: the split view on invoices and payroll runs from 1024 px. */
const original = window.matchMedia;
beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    ...original(query),
    matches: query.includes('min-width: 1024px'),
  })) as typeof window.matchMedia;
});
afterEach(() => {
  window.matchMedia = original;
});

describe('split view on the money lists', () => {
  it('invoices: an invoice opens beside the list', async () => {
    renderPage(<InvoicesView />, { path: '/invoices?id=5' });
    expect(await screen.findByRole('link', { name: 'فتح في صفحة كاملة' })).toHaveAttribute(
      'href',
      '/invoices/5',
    );
    const list = await screen.findByRole('list', { name: 'الفواتير' });
    expect(await within(list).findByRole('link', { current: true })).toBeInTheDocument();
  });

  it('payroll runs: the full-page link is the run page (/payroll/runs/:id)', async () => {
    renderPage(<RunsView />, { path: '/payroll?id=1' });
    expect(await screen.findByRole('link', { name: 'فتح في صفحة كاملة' })).toHaveAttribute(
      'href',
      '/payroll/runs/1',
    );
  });
});
