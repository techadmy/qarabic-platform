import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { StaffHomeView } from '@/components/operations/staff-home';
import { server } from '@/mocks/node';
import { renderPage } from '@/test/people';

const panel = (name: string) => screen.findByRole('heading', { level: 3, name });
const cardOf = (heading: HTMLElement) => heading.closest('[data-slot="card"]') as HTMLElement;

describe('D3 dashboard: waiting for action, recent events, drill-down (docs/40 §3)', () => {
  it('waiting for action lists the open queues, each a link to its list; a queue at 0 is not listed', async () => {
    renderPage(<StaffHomeView />, { path: '/' });
    const card = cardOf(await panel('بانتظار إجراء'));
    const leads = await within(card).findByRole('link', { name: /عملاء محتملون لم يُتواصل معهم/ });
    expect(leads).toHaveAttribute('href', '/leads?uncontacted=1');
    expect(leads).toHaveTextContent('4');
    expect(within(card).getByRole('link', { name: /طلبات إجازة معلّقة/ })).toHaveAttribute(
      'href',
      '/requests?type=leave',
    );
    // The mock's fifth item (tickets past SLA) is 0: not a row.
    expect(within(card).queryByText('تذاكر تجاوزت مهلة الاستجابة')).toBeNull();
    expect(within(card).getAllByRole('listitem')).toHaveLength(4);
  });

  it('accounts see only the money queues and the money events', async () => {
    renderPage(<StaffHomeView />, { as: 'accounts@qarabic.test', path: '/' });
    const waiting = cardOf(await panel('بانتظار إجراء'));
    await within(waiting).findByRole('link', { name: /مدفوعات بانتظار المراجعة/ });
    expect(within(waiting).queryByText(/عملاء محتملون/)).toBeNull();
    expect(within(waiting).queryByText(/طلبات إجازة/)).toBeNull();
    const events = cardOf(await panel('آخر الأحداث'));
    await within(events).findAllByText('تحصيل دفعة');
    expect(within(events).queryByText('تحويل عميل محتمل إلى طالب')).toBeNull();
    expect(within(events).queryByText('إلغاء حصة')).toBeNull();
  });

  it('recent events: label, facts, who (or the system), when; each opens its record; more pages back', async () => {
    const user = userEvent.setup();
    renderPage(<StaffHomeView />, { path: '/' });
    const card = cardOf(await panel('آخر الأحداث'));
    const first = (await within(card).findAllByRole('listitem'))[0]!;
    expect(first).toHaveTextContent('تحصيل دفعة');
    expect(first).toHaveTextContent('النظام');
    expect(first).toHaveTextContent('120');
    expect(within(first).getByRole('link')).toHaveAttribute('href', '/invoices/1');
    expect(within(first).getByRole('link').querySelector('time')).toHaveAttribute('datetime');
    const converted = within(card).getByRole('link', { name: /تحويل عميل محتمل إلى طالب/ });
    expect(converted).toHaveAttribute('href', '/leads/1');
    expect(converted).toHaveTextContent('Sara Ali');
    // A voided invoice opens the invoice; a cancelled class opens its sheet on the board.
    expect(within(card).getByRole('link', { name: /إلغاء حصة/ })).toHaveAttribute(
      'href',
      '/today?session=1',
    );
    expect(within(card).getAllByRole('listitem')).toHaveLength(8);
    await user.click(within(card).getByRole('button', { name: 'عرض المزيد' }));
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(12));
    expect(within(card).queryByRole('button', { name: 'عرض المزيد' })).toBeNull();
  });

  it('empty: nothing waiting and no events are said, not blank', async () => {
    server.use(
      http.get('*/api/v1/dashboard/events', () =>
        HttpResponse.json({ data: { events: [], nextBefore: null } }),
      ),
    );
    metricsWithZeroQueues();
    renderPage(<StaffHomeView />, { path: '/' });
    expect(await screen.findByText('لا يوجد ما ينتظر إجراءً الآن.')).toBeInTheDocument();
    expect(await screen.findByText('لا توجد أحداث بعد.')).toBeInTheDocument();
  });

  it('a failed load is said in each panel, with a retry that asks again', async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.get('*/api/v1/dashboard/events', () => {
        calls += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    renderPage(<StaffHomeView />, { path: '/' });
    const card = cardOf(await panel('آخر الأحداث'));
    expect(await within(card).findByRole('alert')).toHaveTextContent('تعذّر تحميل البيانات.');
    const before = calls;
    await user.click(within(card).getByRole('button', { name: 'أعد المحاولة' }));
    await waitFor(() => expect(calls).toBeGreaterThan(before));
  });

  it('the waiting panel says a failed metrics load too', async () => {
    server.use(
      http.get('*/api/v1/dashboard/metrics', () => HttpResponse.json({}, { status: 500 })),
    );
    renderPage(<StaffHomeView />, { path: '/' });
    const card = cardOf(await panel('بانتظار إجراء'));
    expect(await within(card).findByRole('alert')).toHaveTextContent('تعذّر تحميل البيانات.');
  });

  it('every chart opens the list or report behind it, narrowed to the range', async () => {
    renderPage(<StaffHomeView />, { path: '/?from=2026-10-01&to=2026-10-31&range=custom' });
    await panel('نتائج الحصص');
    const details = (title: string) =>
      screen.getByRole('link', { name: new RegExp(`^التفاصيل: \\u2068?${title}`) });
    await waitFor(() =>
      expect(details('الإيرادات والمصروفات والربح')).toHaveAttribute(
        'href',
        '/accounting/reports?report=profit-and-loss&from=2026-10-01&to=2026-10-31',
      ),
    );
    expect(details('التحصيل والفواتير الجديدة')).toHaveAttribute(
      'href',
      '/invoices?period=2026-10',
    );
    expect(details('أعمار الديون المتأخرة')).toHaveAttribute('href', '/invoices?status=overdue');
    expect(details('العملاء المحتملون حسب المصدر')).toHaveAttribute(
      'href',
      '/leads/kpis?from=2026-10-01&to=2026-10-31',
    );
    expect(details('أسباب فقد العملاء')).toHaveAttribute('href', '/leads?status=lost');
    expect(details('نتائج الحصص')).toHaveAttribute('href', '/today');
    expect(details('ساعات التدريس')).toHaveAttribute('href', '/payroll');
  });
});

/** A metrics answer with every queue at 0 (no widget data needed for the panel). */
function metricsWithZeroQueues() {
  server.use(
    http.get('*/api/v1/dashboard/metrics', ({ request }) => {
      const q = new URL(request.url).searchParams;
      const keys = ['leads_uncontacted', 'payments_to_review', 'leave_requests'] as const;
      return HttpResponse.json({
        data: {
          range: {
            from: q.get('from'),
            to: q.get('to'),
            bucket: q.get('bucket'),
            previous: null,
            timezone: 'Africa/Cairo',
          },
          currency: 'USD',
          widgets: [],
          kpis: {},
          series: {},
          missingRates: [],
          waiting: keys.map((key) => ({ key, count: 0, href: '/' })),
          generatedAt: new Date().toISOString(),
        },
      });
    }),
  );
}
