import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CreditsView } from '@/components/billing/credits-view';
import { FamilyBillingSection } from '@/components/billing/family-billing';
import { InvoiceDetailView } from '@/components/billing/invoice-detail-view';
import { bdb } from '@/mocks/billing-db';
import { renderPage } from '@/test/people';

/** The seeded late bank transfer on an already paid invoice (P1-1, B115). */
const late = () => bdb.payments.find((p) => p.needsReview)!;
const credit = () => bdb.credits.find((c) => c.status === 'open')!;

describe('P1-1 family credits (B115)', () => {
  it('the review list shows the new credit with its source; «تمت المراجعة» records it', async () => {
    const user = userEvent.setup();
    const payment = late();
    renderPage(<CreditsView />, { path: '/billing/credits' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'الأرصدة الدائنة للأسر' }),
    ).toBeInTheDocument();
    // «تحتاج مراجعة» is the default view: only the unreviewed credit.
    const table = await screen.findByRole('table', { name: 'الأرصدة الدائنة للأسر' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(table).toHaveTextContent(
      new RegExp(`الفاتورة #\\W?${payment.invoiceId}\\W? · تحويل بنكي`),
    );
    expect(table).toHaveTextContent('20.00');
    await user.click(within(table).getByRole('button', { name: /^تمت المراجعة/ }));
    const dialog = await screen.findByRole('dialog', { name: /^مراجعة رصيد/ });
    await user.type(within(dialog).getByRole('textbox'), 'دفعة مكررة من البنك');
    await user.click(within(dialog).getByRole('button', { name: 'تمت المراجعة' }));
    await waitFor(() => expect(credit().reviewedAt).not.toBeNull());
    expect(credit().note).toBe('دفعة مكررة من البنك');
    expect(payment.needsReview).toBe(false);
    expect(await screen.findByText('لا أرصدة تحتاج مراجعة.')).toBeInTheDocument();
  });

  it('«الكل» lists used credits too, with who reviewed them', async () => {
    renderPage(<CreditsView />, { path: '/billing/credits?view=all' });
    const table = await screen.findByRole('table', { name: 'الأرصدة الدائنة للأسر' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3));
    expect(table).toHaveTextContent('استُخدم');
    expect(table).toHaveTextContent('مدير النظام');
  });

  it('the invoice shows the late payment flagged, with the part kept as credit', async () => {
    const p = late();
    renderPage(<InvoiceDetailView id={p.invoiceId} />, { path: `/invoices/${p.invoiceId}` });
    const payments = await screen.findByRole('list', { name: 'المدفوعات' });
    expect(await within(payments).findByText('تحتاج مراجعة')).toBeInTheDocument();
    expect(payments).toHaveTextContent('أُضيفت إلى رصيد الأسرة الدائن');
    expect(payments).toHaveTextContent('وصلت الدفعة بعد سداد الفاتورة أو إلغائها.');
  });

  it('the family’s billing shows its open credit and that it needs review', async () => {
    const familyId = credit().familyId;
    renderPage(<FamilyBillingSection familyId={familyId} />, { path: `/families/${familyId}` });
    expect(await screen.findByText('رصيد دائن')).toBeInTheDocument();
    const note = screen.getByText('رصيد دائن').closest('[role="alert"], [data-slot="alert"]')!;
    expect(
      within(note as HTMLElement).getByRole('link', { name: 'الأرصدة الدائنة' }),
    ).toHaveAttribute('href', '/billing/credits');
    expect(screen.getAllByText('يحتاج مراجعة').length).toBeGreaterThan(0);
  });

  it('a teacher cannot open the list', async () => {
    renderPage(<CreditsView />, { as: 'teacher@qarabic.test', path: '/billing/credits' });
    expect((await screen.findAllByText(/صلاحية/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table')).toBeNull();
  });
});
