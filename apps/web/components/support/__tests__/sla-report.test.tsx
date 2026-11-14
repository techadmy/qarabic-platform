import { act, screen, waitFor, within } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { InboxView } from '@/components/support/inbox-view';
import { SupportReportView } from '@/components/support/support-report-view';
import { server } from '@/mocks/node';
import { isClosed, supdb } from '@/mocks/support-db';
import { lastReplacedUrl, renderPage } from '@/test/people';

describe('S4 «الآن» tiles on the inbox', () => {
  it('counts open, overdue and unassigned; a tile filters the list', async () => {
    const user = userEvent.setup();
    renderPage(<InboxView />, { path: '/support' });
    const tiles = await screen.findByRole('navigation', { name: 'الآن' });
    const overdue = await within(tiles).findByRole('button', { name: /تجاوزت الموعد/ });
    expect(overdue).toHaveTextContent(/^\d+/);
    await user.click(overdue);
    expect(lastReplacedUrl().searchParams.get('breached')).toBe('1');
    await user.click(within(tiles).getByRole('button', { name: /دون مسؤول/ }));
    expect(lastReplacedUrl().searchParams.get('assignee')).toBe('none');
    expect(lastReplacedUrl().searchParams.get('breached')).toBeNull();
  });

  it('with a queue tab open, the numbers are that queue’s; a tile clears the other filters', async () => {
    const user = userEvent.setup();
    const billing = supdb.tickets.filter((t) => t.queue === 'billing' && !isClosed(t.status));
    renderPage(<InboxView />, { path: '/support?queue=billing&kind=ticket&q=invoice' });
    const tiles = await screen.findByRole('navigation', { name: 'الآن' });
    const open = within(tiles).getByRole('button', { name: /مفتوحة/ });
    await waitFor(() => expect(open).toHaveTextContent(String(billing.length)));
    // Other filters narrow the list: no tile claims to be what is shown.
    expect(open).toHaveAttribute('aria-pressed', 'false');
    await user.click(within(tiles).getByRole('button', { name: /تجاوزت الموعد/ }));
    const url = lastReplacedUrl().searchParams;
    expect(url.get('breached')).toBe('1');
    expect(url.get('queue')).toBe('billing');
    expect(url.get('kind')).toBeNull();
    expect(url.get('q')).toBeNull();
  });

  it('keeps the rows when a refresh fails, and says so quietly', async () => {
    renderPage(<InboxView />, { path: '/support' });
    const list = await screen.findByRole('list', { name: 'صندوق الطلبات' });
    server.use(http.get('*/api/v1/support/inbox', () => HttpResponse.json({}, { status: 500 })));
    // Back to the tab: the list refetches, and the refetch fails.
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(
      await screen.findByText('تعذّر تحديث البيانات؛ المعروض هو آخر ما حُمِّل.'),
    ).toBeInTheDocument();
    expect(list).toBeInTheDocument();
    expect(screen.queryByText(/تعذّر تحميل/)).toBeNull();
    focusManager.setFocused(undefined);
  });
});

describe('S4 «تقرير تواصل معنا»', () => {
  it('shows the totals, the queues with a footer total, and the weeks', async () => {
    const from = supdb.tickets.map((t) => t.createdAt.slice(0, 10)).sort()[0]!;
    renderPage(<SupportReportView />, { path: `/support/reports?from=${from}` });
    const queues = await screen.findByRole('table', { name: 'حسب القسم' });
    const total = within(queues).getByRole('rowheader', { name: 'الإجمالي' });
    expect(total.closest('tfoot')).not.toBeNull();
    expect(within(queues).getByRole('columnheader', { name: 'القسم' })).toHaveAttribute(
      'scope',
      'col',
    );
    expect(screen.getByRole('table', { name: 'أسبوعًا بأسبوع' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'ملخص الفترة' })).toHaveTextContent(
      String(supdb.tickets.filter((t) => t.createdAt.slice(0, 10) >= from).length),
    );
  });

  it('a period longer than a year says so and asks nothing', async () => {
    renderPage(<SupportReportView />, { path: '/support/reports?from=2024-01-01&to=2026-11-01' });
    expect(await screen.findByRole('alert')).toHaveTextContent('اختر فترة لا تزيد على سنة واحدة.');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('a period without requests is an empty state', async () => {
    renderPage(<SupportReportView />, { path: '/support/reports?from=2001-01-01&to=2001-01-31' });
    expect(await screen.findByText('لا طلبات في هذه الفترة')).toBeInTheDocument();
  });
});
