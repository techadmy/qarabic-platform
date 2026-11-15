import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { StaffHomeView } from '@/components/operations/staff-home';
import { server } from '@/mocks/node';
import { lastReplacedUrl, renderPage } from '@/test/people';

const kpis = () => screen.findByRole('region', { name: 'الفترة الزمنية' });

describe('D2 management dashboard (docs/40, D144)', () => {
  it('the owner sees every KPI and chart for this month, money in USD', async () => {
    renderPage(<StaffHomeView />, { path: '/' });
    await kpis();
    for (const label of [
      'الطلاب النشطون',
      'طلاب جدد',
      'المعلمون العاملون',
      'الحصص التجريبية',
      'المُحصّل',
      'المستحق',
      'إجمالي الربح',
      'نسبة الحضور',
    ]) {
      const dash = screen.getByRole('region', { name: 'لوحة المؤشرات' });
      expect(
        await within(dash).findByRole('link', { name: new RegExp(`^${label}`) }),
      ).toBeInTheDocument();
    }
    for (const title of [
      'الإيرادات والمصروفات والربح',
      'التحصيل والفواتير الجديدة',
      'الطلاب الجدد والحصص التجريبية',
      'نتائج الحصص',
    ]) {
      expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
    }
    const collected = screen.getByRole('link', { name: /^المُحصّل/ });
    await waitFor(() => expect(collected).toHaveTextContent('$'));
    // Every number opens the list behind it (docs/40 §2.5).
    expect(screen.getByRole('link', { name: /^المستحق/ })).toHaveAttribute(
      'href',
      '/invoices?status=overdue',
    );
  });

  it('compare shows the change against the previous period, in words too', async () => {
    renderPage(<StaffHomeView />, { path: '/?compare=1' });
    await kpis();
    const card = await screen.findByRole('link', { name: /^الطلاب النشطون/ });
    await waitFor(() => expect(within(card).getByText(/الفترة السابقة/)).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('مقارنةً بـ');
  });

  it('the range bar writes the period and compare to the URL', async () => {
    const user = userEvent.setup();
    renderPage(<StaffHomeView />, { path: '/' });
    const bar = await kpis();
    await user.click(within(bar).getByRole('combobox', { name: 'الفترة' }));
    await user.click(await screen.findByRole('option', { name: 'آخر 12 شهرًا' }));
    expect(lastReplacedUrl().searchParams.get('range')).toBe('last_12_months');
    await user.click(within(bar).getByRole('switch', { name: 'قارن بالفترة السابقة' }));
    expect(lastReplacedUrl().searchParams.get('compare')).toBe('1');
  });

  it('a month with no exchange rate is said, never shown as 0 (D144)', async () => {
    renderPage(<StaffHomeView />, { path: '/?range=last_12_months' });
    await kpis();
    // A banner on top, the chart note, and the card shows the original currencies instead of
    // a USD total.
    expect(await screen.findByText('أسعار صرف ناقصة')).toBeInTheDocument();
    expect(screen.getAllByText(/لا يوجد سعر صرف إلى الدولار لـ/).length).toBeGreaterThan(1);
    const collected = screen.getByRole('link', { name: /^المُحصّل/ });
    expect(collected).toHaveTextContent('—');
    expect(collected).toHaveTextContent(/£/);
    expect(collected).not.toHaveTextContent(/\$0\b/);
  });

  it('billing staff see the money widgets only; a monitor the classes only', async () => {
    const { unmount } = renderPage(<StaffHomeView />, { as: 'accounts@qarabic.test', path: '/' });
    await kpis();
    expect(await screen.findByRole('link', { name: /^المُحصّل/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^الطلاب النشطون/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'نتائج الحصص' })).toBeNull();
    unmount();
    renderPage(<StaffHomeView />, { as: 'monitor@qarabic.test', path: '/' });
    await kpis();
    expect(await screen.findByRole('link', { name: /^نسبة الحضور/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^المُحصّل/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'الإيرادات والمصروفات والربح' })).toBeNull();
  });

  it('a failed load is said in each widget, with a retry', async () => {
    server.use(
      http.get('*/api/v1/dashboard/metrics', () => HttpResponse.json({}, { status: 500 })),
    );
    renderPage(<StaffHomeView />, { path: '/' });
    await kpis();
    expect((await screen.findAllByText('تعذّر تحميل الرسم.')).length).toBe(4);
    expect(screen.getAllByRole('button', { name: 'أعد المحاولة' }).length).toBeGreaterThan(0);
  });
});
