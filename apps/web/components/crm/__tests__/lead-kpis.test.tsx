import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LeadKpisView } from '@/components/crm/lead-kpis-view';
import { crmdb } from '@/mocks/crm-db';
import { renderPage } from '@/test/people';

describe('T5 «مؤشرات العملاء المحتملين»', () => {
  it('shows the rates by source with their parts, and every lost reason', async () => {
    const from = crmdb.leads.map((l) => l.createdAt.slice(0, 10)).sort()[0]!;
    renderPage(<LeadKpisView />, { path: `/leads/kpis?from=${from}` });
    const sources = await screen.findByRole('table', { name: 'حسب المصدر' });
    // A rate with its parts («62.5٪ (5 من 8)»); the total row closes the table.
    expect(sources).toHaveTextContent(/\d+(\.\d)?٪ \(\d+ من \d+\)/);
    expect(within(sources).getByRole('row', { name: /^الإجمالي/ })).toBeInTheDocument();
    const lost = screen.getByRole('table', { name: /^أسباب الفقد/ });
    // All seven reasons, zeros included (the new «المعلم» among them).
    expect(within(lost).getAllByRole('row')).toHaveLength(8);
    expect(within(lost).getByText('المعلم')).toBeInTheDocument();
  });

  it('a period without leads is an empty state, not zeros', async () => {
    renderPage(<LeadKpisView />, { path: '/leads/kpis?from=2001-01-01&to=2001-01-31' });
    expect(await screen.findByText('لا عملاء محتملين في هذه الفترة')).toBeInTheDocument();
    expect(screen.queryByText(/0٪/)).toBeNull();
  });

  it('a start after the end says so and asks nothing', async () => {
    renderPage(<LeadKpisView />, { path: '/leads/kpis?from=2026-11-20&to=2026-11-01' });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
