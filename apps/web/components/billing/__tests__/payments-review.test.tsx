import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { InvoiceDetailView } from '@/components/billing/invoice-detail-view';
import { PaymentsReviewView } from '@/components/billing/payments-review-view';
import { recordPayment } from '@/lib/api/billing';
import { bdb } from '@/mocks/billing-db';
import { mockSignIn } from '@/mocks/handlers';
import { server } from '@/mocks/node';
import { renderPage } from '@/test/people';

const held = () => bdb.payments.find((p) => p.status === 'needs_review')!;

describe('P1-3 payments to review (held mismatch, overpayment)', () => {
  it('lists the held capture with what was captured, and the overpayment', async () => {
    renderPage(<PaymentsReviewView />, { path: '/billing/payments-review' });
    const table = await screen.findByRole('table', { name: 'مدفوعات تحتاج مراجعة' });
    // The seeded card capture in the wrong currency, and the late bank transfer (kept as credit).
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3));
    expect(table).toHaveTextContent('حُصّلت الدفعة بعملة مختلفة؛ لم يُطبَّق شيء على الفاتورة.');
    expect(table).toHaveTextContent(held().capturedCurrency === 'USD' ? '$' : '€');
    expect(table).toHaveTextContent('حُفظت رصيدًا للأسرة');
    expect(table).toHaveTextContent('قيد المراجعة');
  });

  it('«تمت المراجعة» needs what was done; the payment leaves the queue', async () => {
    const user = userEvent.setup();
    const p = held();
    renderPage(<PaymentsReviewView />, { path: '/billing/payments-review' });
    const table = await screen.findByRole('table', { name: 'مدفوعات تحتاج مراجعة' });
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3));
    const row = within(table)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes('قيد المراجعة'))!;
    await user.click(within(row).getByRole('button', { name: /^تمت المراجعة/ }));
    const dialog = await screen.findByRole('dialog', { name: /^مراجعة دفعة الفاتورة/ });
    // The note is required.
    await user.click(within(dialog).getByRole('button', { name: 'تمت المراجعة' }));
    expect(p.needsReview).toBe(true);
    await user.type(within(dialog).getByRole('textbox'), 'Refunded at Stripe; asked for EUR.');
    await user.click(within(dialog).getByRole('button', { name: 'تمت المراجعة' }));
    await waitFor(() => expect(p.needsReview).toBe(false));
    expect(p.note).toContain('Reviewed: Refunded at Stripe');
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
  });

  it('a teacher cannot open it', async () => {
    renderPage(<PaymentsReviewView />, {
      as: 'teacher@qarabic.test',
      path: '/billing/payments-review',
    });
    expect((await screen.findAllByText(/صلاحية/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('P1-5 Idempotency-Key on a manual payment', () => {
  it('the same key twice records one payment and returns it again', async () => {
    mockSignIn('admin@qarabic.test');
    const inv = bdb.invoices.find((i) => i.status === 'issued' && i.number)!;
    const before = bdb.payments.length;
    const body = {
      method: 'cash' as const,
      amount: '1.00',
      receivedOn: new Date().toISOString().slice(0, 10),
    };
    const a = await recordPayment(inv.id, body, 'pay_test_same_key_1');
    const b = await recordPayment(inv.id, body, 'pay_test_same_key_1');
    expect(b.id).toBe(a.id);
    expect(bdb.payments.length).toBe(before + 1);
  });

  it('the payment dialog sends a key, and a new one for the next payment', async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && /\/invoices\/\d+\/payments$/.test(request.url)) {
        keys.push(request.headers.get('idempotency-key') ?? '');
      }
    });
    const inv = bdb.invoices.find((i) => i.status === 'issued' && i.number)!;
    renderPage(<InvoiceDetailView id={inv.id} />, { path: `/invoices/${inv.id}` });
    for (const amount of ['1.00', '2.00']) {
      await user.click(await screen.findByRole('button', { name: 'تسجيل دفعة' }));
      const dialog = await screen.findByRole('dialog', { name: /تسجيل دفعة|دفعة/ });
      const field = within(dialog).getByLabelText(/المبلغ/);
      await user.clear(field);
      await user.type(field, amount);
      await user.click(within(dialog).getByRole('button', { name: 'سجّل الدفعة' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    server.events.removeAllListeners('request:start');
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
