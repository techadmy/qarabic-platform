import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ParentInvoicesView, ParentInvoiceView } from '@/components/billing/parent-invoices';
import { ReceiptView } from '@/components/billing/receipt-view';
import { bdb } from '@/mocks/billing-db';
import { renderPage } from '@/test/people';
import { routerMock } from '@/test/router-mock';

const PARENT = 'parent@qarabic.test';

describe('«فواتيري» (parent)', () => {
  it('lists only the family’s invoices: what is due first, then the history', async () => {
    renderPage(<ParentInvoicesView />, { as: PARENT, path: '/invoices' });
    expect(await screen.findByRole('heading', { name: 'المستحق الآن' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'الفواتير السابقة' })).toBeInTheDocument();
    const pay = screen.getAllByRole('link', { name: /^ادفع الآن/ });
    expect(pay).toHaveLength(1);
    expect(pay[0]).toHaveAttribute('href', '/invoices/1?pay=1');
    expect(screen.queryByText('Yusuf Hassan')).not.toBeInTheDocument();
    expect(screen.queryByText('فاتورة مسودة')).not.toBeInTheDocument();
  });

  it('shows the empty state when the family has no invoices', async () => {
    bdb.invoices = bdb.invoices.filter((i) => i.familyId !== 1);
    renderPage(<ParentInvoicesView />, { as: PARENT, path: '/invoices' });
    expect(await screen.findByText('لا توجد فواتير بعد')).toBeInTheDocument();
  });

  it('pays by card: only the enabled providers, then the return shows paid', async () => {
    const user = userEvent.setup();
    bdb.online = ['stripe'];
    renderPage(<ParentInvoiceView id={1} />, { as: PARENT, path: '/invoices/1?pay=1' });
    const dialog = await screen.findByRole('dialog', { name: 'اختر طريقة الدفع' });
    expect(within(dialog).queryByRole('button', { name: 'PayPal' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'بطاقة ائتمان أو خصم مباشر' }));
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith('/invoices/1?checkout=return&provider=stripe'),
    );
    // The server only charges its own balance; a pending attempt is recorded.
    expect(bdb.payments.at(-1)).toMatchObject({ method: 'stripe', amountMinor: 14500 });
  });

  it('coming back from the provider: «جارٍ تأكيد الدفع» until the server says paid', async () => {
    bdb.payments.push({
      ...bdb.payments[0]!,
      id: 99,
      invoiceId: 1,
      status: 'pending',
      amountMinor: 14500,
      receiptNumber: null,
    });
    renderPage(<ParentInvoiceView id={1} />, {
      as: PARENT,
      path: '/invoices/1?checkout=return&provider=stripe',
    });
    expect(await screen.findByText('تم الدفع بنجاح')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ادفع الآن' })).not.toBeInTheDocument();
  });

  it('a cancelled checkout says nothing was charged and keeps «ادفع الآن»', async () => {
    renderPage(<ParentInvoiceView id={1} />, { as: PARENT, path: '/invoices/1?checkout=cancel' });
    expect(await screen.findByText('أُلغيت عملية الدفع')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ادفع الآن' })).toBeInTheDocument();
  });

  it('without an online provider the parent is told how to pay instead', async () => {
    bdb.online = [];
    renderPage(<ParentInvoiceView id={1} />, { as: PARENT, path: '/invoices/1' });
    expect(await screen.findByText(/الدفع الإلكتروني غير متاح حاليًّا/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ادفع الآن' })).not.toBeInTheDocument();
  });

  it('another family’s invoice is «not found»', async () => {
    renderPage(<ParentInvoiceView id={3} />, { as: PARENT, path: '/invoices/3' });
    expect(await screen.findByText('الفاتورة غير موجودة')).toBeInTheDocument();
  });

  it('the receipt of a succeeded payment', async () => {
    renderPage(<ReceiptView invoiceId={2} paymentId={1} />, {
      as: PARENT,
      path: '/invoices/2/receipts/1',
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'إيصال دفع' })).toBeInTheDocument();
    expect(screen.getByText('RC-000001')).toBeInTheDocument();
    expect(screen.getByText('بطاقة (Stripe)')).toBeInTheDocument();
  });

  it('no receipt for a payment that does not exist', async () => {
    renderPage(<ReceiptView invoiceId={2} paymentId={77} />, {
      as: PARENT,
      path: '/invoices/2/receipts/77',
    });
    expect(await screen.findByText('الإيصال غير موجود')).toBeInTheDocument();
  });
});
