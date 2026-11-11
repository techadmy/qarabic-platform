import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { RequestsView } from '@/app/(app)/requests/requests-view';
import { server } from '@/mocks/node';
import { sdb } from '@/mocks/schedule-db';
import { lastReplacedUrl, renderPage } from '@/test/people';

async function cards() {
  const list = await screen.findByRole('list', { name: 'طلبات الحصص' });
  return within(list).getAllByRole('listitem');
}

describe('Requests inbox', () => {
  it('lists pending requests with counts, both times and the reason; tabs and type go to the URL', async () => {
    const user = userEvent.setup();
    renderPage(<RequestsView />, { path: '/requests' });
    const items = await cards();
    expect(items).toHaveLength(4);
    expect(await screen.findByText('قيد المراجعة: 4')).toBeInTheDocument();
    const tabs = screen.getByRole('radiogroup', { name: 'تصفية حسب الحالة' });
    expect(within(tabs).getByRole('radio', { name: /^قيد المراجعة\s*\(4\)$/ })).toBeChecked();
    const reschedule = items.find((i) => within(i).queryByText('طلب تأجيل'))!;
    expect(within(reschedule).getByText('الحالي:')).toBeInTheDocument();
    expect(within(reschedule).getByText('المطلوب:')).toBeInTheDocument();
    expect(within(reschedule).getByText(/Doctor appointment/)).toBeInTheDocument();
    await user.click(within(tabs).getByRole('radio', { name: /^تم البت فيها/ }));
    expect(lastReplacedUrl().searchParams.get('status')).toBe('decided');
  });

  it('rejects only with a note', async () => {
    const user = userEvent.setup();
    renderPage(<RequestsView />, { path: '/requests' });
    const leave = (await cards()).find((i) => within(i).queryByText('طلب إجازة'))!;
    const name = within(leave).getAllByRole('button')[0]!.textContent!;
    await user.click(within(leave).getByRole('button', { name: `رفض: ${name}` }));
    const dialog = await screen.findByRole('alertdialog', { name: `رفض طلب ${name}` });
    await user.click(within(dialog).getByRole('button', { name: 'رفض' }));
    expect(await within(dialog).findByText('هذا الحقل مطلوب')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/سبب الرفض/), 'No make-up slots this week');
    await user.click(within(dialog).getByRole('button', { name: 'رفض' }));
    expect(await screen.findByText('رُفض الطلب')).toBeInTheDocument();
    await waitFor(async () => expect(await cards()).toHaveLength(3));
  });

  it('approves a reschedule after the live conflict check, with an optional note', async () => {
    const user = userEvent.setup();
    let approved: Record<string, unknown> | null = null;
    // A free time for the server's own re-check: no work hours set, an odd minute nobody uses.
    sdb.workHours.clear();
    sdb.holidays.length = 0;
    const r = sdb.requests.find((x) => x.type === 'reschedule' && x.status === 'pending')!;
    r.proposedStartsAt =
      new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 11) + '03:07:00Z';
    server.use(
      http.post('*/api/v1/schedule/check', () =>
        HttpResponse.json({ data: { conflicts: [], warnings: [] } }),
      ),
    );
    server.events.on('request:start', async ({ request }) => {
      if (request.url.endsWith('/approve')) approved = await request.clone().json();
    });
    renderPage(<RequestsView />, { path: '/requests' });
    const reschedule = (await cards()).find((i) => within(i).queryByText('طلب تأجيل'))!;
    const name = within(reschedule).getAllByRole('button')[0]!.textContent!;
    await user.click(within(reschedule).getByRole('button', { name: `موافقة: ${name}` }));
    const dialog = await screen.findByRole('dialog', { name: `موافقة على طلب تأجيل — ${name}` });
    expect(await within(dialog).findByText('لا يوجد تعارض')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/ملاحظة لمقدّم الطلب/), 'Approved, see you then');
    await user.click(within(dialog).getByRole('button', { name: 'وافق على الطلب' }));
    expect(await screen.findByText('اعتُمد الطلب')).toBeInTheDocument();
    expect(approved).toMatchObject({ note: 'Approved, see you then', acknowledgeWarnings: [] });
    await waitFor(async () => expect(await cards()).toHaveLength(3));
    server.events.removeAllListeners();
  });

  it('gives a parent «طلباتي» with only their children’s requests and «سحب الطلب» on their own', async () => {
    renderPage(<RequestsView />, { as: 'parent@qarabic.test', path: '/requests' });
    expect(await screen.findByRole('heading', { level: 1, name: 'طلباتي' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'طلباتي' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(within(items[0]!).getByRole('button', { name: 'سحب الطلب' })).toBeInTheDocument();
    expect(within(items[0]!).queryByRole('button', { name: /^موافقة/ })).not.toBeInTheDocument();
  });
});
