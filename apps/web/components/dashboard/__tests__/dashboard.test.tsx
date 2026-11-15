import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { StaffHomeView } from '@/components/operations/staff-home';
import { MOCK_USERS } from '@/mocks/data';
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
      'نسبة التحصيل',
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
      'أعمار الديون المتأخرة',
      'العملاء المحتملون حسب المصدر',
      'أسباب فقد العملاء',
      'ساعات التدريس',
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
    // Who keeps the rates goes straight to the form for the missing month.
    expect(screen.getByRole('link', { name: 'أضف السعر الناقص' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/accounting\/rates\?new=1&currency=GBP&month=\d{4}-\d{2}/),
    );
  });

  it('billing staff see the money widgets only; a monitor the classes only', async () => {
    const { unmount } = renderPage(<StaffHomeView />, { as: 'accounts@qarabic.test', path: '/' });
    await kpis();
    expect(await screen.findByRole('link', { name: /^المُحصّل/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^الطلاب النشطون/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'نتائج الحصص' })).toBeNull();
    // D146: accounts get the collection rate and the ageing, never teacher pay.
    expect(screen.getByRole('link', { name: /^نسبة التحصيل/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'أعمار الديون المتأخرة' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'ساعات التدريس' })).toBeNull();
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
    expect((await screen.findAllByText('تعذّر تحميل الرسم.')).length).toBe(8);
    expect(screen.getAllByRole('button', { name: 'أعد المحاولة' }).length).toBeGreaterThan(0);
  });

  it('the «compared with» dates are the API’s own previous period (one rule)', async () => {
    let previous: { from: string; to: string } | null = null;
    server.events.on('response:mocked', async ({ request, response }) => {
      if (new URL(request.url).pathname.endsWith('/dashboard/metrics')) {
        previous = (await response.clone().json()).data.range.previous;
      }
    });
    renderPage(<StaffHomeView />, { path: '/?compare=1' });
    const bar = await kpis();
    await waitFor(() => expect(previous).not.toBeNull());
    const status = within(bar).getByRole('status');
    // The mock (as the API) compares with the same number of days just before.
    const day = (key: string) =>
      new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
        day: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${key}T00:00:00Z`));
    await waitFor(() => expect(status).toHaveTextContent('مقارنةً بـ'));
    expect(status).toHaveTextContent(day(previous!.from));
    server.events.removeAllListeners('response:mocked');
  });

  it('attendance changes in percentage points; a trial rate with nobody attending is «—»', async () => {
    server.use(
      http.get('*/api/v1/dashboard/metrics', () =>
        HttpResponse.json({
          data: {
            range: {
              from: '2026-11-01',
              to: '2026-11-15',
              bucket: 'day',
              previous: { from: '2026-10-17', to: '2026-10-31' },
              timezone: 'Africa/Cairo',
            },
            currency: 'USD',
            widgets: ['trials', 'attendance_rate'],
            kpis: {
              trials: {
                value: { booked: 3, attended: 0, converted: 0, conversionRate: null },
                previous: null,
              },
              attendance_rate: { value: 0.9, previous: 0.8 },
            },
            series: {},
            missingRates: [],
            generatedAt: '2026-11-15T10:00:00Z',
          },
        }),
      ),
    );
    renderPage(<StaffHomeView />, { path: '/?compare=1' });
    await kpis();
    const attendance = await screen.findByRole('link', { name: /^نسبة الحضور/ });
    await waitFor(() => expect(attendance).toHaveTextContent('+10 نقطة'));
    const trials = within(screen.getByRole('region', { name: 'لوحة المؤشرات' })).getByRole('link', {
      name: /^الحصص التجريبية/,
    });
    expect(trials).toHaveTextContent('(—)');
    expect(trials).not.toHaveTextContent('0%');
  });

  it('without reports.view (the endpoint’s permission) there is no dashboard and no request', async () => {
    const admin = MOCK_USERS.find((u) => u.email === 'admin@qarabic.test')!;
    const before = admin.permissions;
    admin.permissions = before.filter((p) => p !== 'reports.view');
    let asked = false;
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/dashboard/metrics')) asked = true;
    });
    renderPage(<StaffHomeView />, { path: '/' });
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'الفترة الزمنية' })).toBeNull();
    expect(asked).toBe(false);
    server.events.removeAllListeners('request:start');
    admin.permissions = before;
  });

  it('a custom range the API cannot take is said, and nothing is asked', async () => {
    renderPage(<StaffHomeView />, { path: '/?range=custom&from=2024-01-01&to=2026-11-01' });
    const bar = await kpis();
    expect(within(bar).getByRole('alert')).toHaveTextContent('اختر فترة لا تزيد على');
    expect(within(bar).getByRole('combobox', { name: 'الفترة' })).toHaveTextContent('مخصّصة');
  });

  it('a card opens its list narrowed to the range where the list can be', async () => {
    renderPage(<StaffHomeView />, { path: '/?range=custom&from=2026-09-01&to=2026-09-30' });
    await kpis();
    expect(await screen.findByRole('link', { name: /^صافي الربح/ })).toHaveAttribute(
      'href',
      '/accounting/reports?report=profit-and-loss&from=2026-09-01&to=2026-09-30',
    );
    expect(
      within(screen.getByRole('region', { name: 'لوحة المؤشرات' })).getByRole('link', {
        name: /^الحصص التجريبية/,
      }),
    ).toHaveAttribute('href', '/leads/kpis?from=2026-09-01&to=2026-09-30');
    expect(screen.getByRole('link', { name: /^المُحصّل/ })).toHaveAttribute(
      'href',
      '/invoices?status=paid&period=2026-09',
    );
    expect(screen.getByRole('link', { name: /^نسبة التحصيل/ })).toHaveAttribute(
      'href',
      '/invoices?period=2026-09',
    );
  });

  it('D3: lead sources, lost reasons and the ageing are said in words; teacher pay is totalled', async () => {
    renderPage(<StaffHomeView />, { path: '/?range=custom&from=2026-09-01&to=2026-09-30' });
    await kpis();
    const card = (name: string) =>
      screen.getByRole('heading', { level: 3, name }).closest('[data-slot="card"]') as HTMLElement;
    await waitFor(() =>
      expect(
        within(card('أسباب فقد العملاء')).getByText(/لا يرد: 14 · السعر: 9/),
      ).toBeInTheDocument(),
    );
    // The donut's spoken summary (jsdom draws no chart).
    const sources = within(card('العملاء المحتملون حسب المصدر'));
    expect(sources.getByText(/الموقع: 41/)).toBeInTheDocument();
    expect(
      within(card('أعمار الديون المتأخرة')).getByText(/حتى 30 يومًا: \$1,900/),
    ).toBeInTheDocument();
    expect(within(card('ساعات التدريس')).getByText(/رواتب المعلمين في الفترة:/)).toHaveTextContent(
      '$',
    );
  });

  it('a collection rate the API cannot compute (missing rate) is «—», never 0%', async () => {
    renderPage(<StaffHomeView />, { path: '/?range=last_12_months' });
    await kpis();
    const rate = await screen.findByRole('link', { name: /^نسبة التحصيل/ });
    await waitFor(() => expect(rate).toHaveTextContent('—'));
    expect(rate).not.toHaveTextContent('0%');
  });
});
