import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { TodayView } from '@/app/(app)/today/today-view';
import { addDays, dateKeyIn } from '@/lib/schedule-time';
import { server } from '@/mocks/node';
import { lastReplacedUrl, renderPage } from '@/test/people';

const tomorrow = () => addDays(dateKeyIn('Africa/Cairo'), 1);
const yesterday = () => addDays(dateKeyIn('Africa/Cairo'), -1);

async function board() {
  const table = await screen.findByRole('table', { name: 'حصص اليوم' });
  await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(1));
  return table;
}

/** Class rows of the table (the header and the «الآن» divider left out). */
const rows = (table: HTMLElement) =>
  Array.from(table.querySelectorAll<HTMLElement>('tr[data-session-id]'));

describe('Today board', () => {
  it('shows the old counters as tiles, header counters and both parties’ times', async () => {
    renderPage(<TodayView />, { path: '/today' });
    const table = await board();
    const tiles = screen.getByRole('navigation', { name: 'عدادات اليوم' });
    // The five main tiles, in the old dashboard's order, with numbers from `counters`.
    const main = within(tiles)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(main.slice(0, 5)).toEqual([
      expect.stringMatching(/^\d+الإجمالي$/),
      expect.stringMatching(/^\d+جارية الآن$/),
      expect.stringMatching(/^\d+المتبقية$/),
      expect.stringMatching(/^\d+منعقدة$/),
      expect.stringMatching(/^\d+تحتاج إجراء$/),
    ]);
    // The header counts the rows; every row labels the student's and teacher's cities.
    expect(screen.getByText(/\d+ حصة|حصة واحدة|حصتان|\d+ حصص/)).toBeInTheDocument();
    expect(
      within(table).getAllByText(/\((نيويورك|لندن|دبي|برلين|سيدني|تورونتو|كراتشي)\)/).length,
    ).toBeGreaterThan(0);
    expect(within(table).getAllByText(/\(القاهرة\)/).length).toBeGreaterThan(0);
    // The running anchor class and the late one are on today's board.
    expect(within(table).getAllByText('متأخرة').length).toBeGreaterThan(0);
  });

  it('filters by tile through the URL; «كل الحالات» reveals the other statuses', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage(<TodayView />, { path: '/today' });
    await board();
    await user.click(screen.getByRole('button', { name: /منعقدة$/ }));
    expect(lastReplacedUrl().searchParams.get('tile')).toBe('taken');
    await user.click(screen.getByRole('button', { name: 'كل الحالات' }));
    expect(lastReplacedUrl().searchParams.get('statuses')).toBe('1');
    unmount();

    // Yesterday always has taken classes (just after midnight today has none yet).
    renderPage(<TodayView />, { path: `/today?date=${yesterday()}&tile=taken&statuses=1` });
    const table = await board();
    expect(screen.getByRole('button', { name: /منعقدة$/ })).toHaveAttribute('aria-pressed', 'true');
    for (const row of rows(table)) expect(within(row).getByText('منعقدة')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'كل الحالات' })).toBeInTheDocument();
  });

  it('searches students and teachers on the board and offers «مسح الكل» when nothing matches', async () => {
    renderPage(<TodayView />, { path: '/today?q=zzzz' });
    expect(await screen.findByText('لا نتائج مطابقة')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'مسح الكل' })).toBeInTheDocument();
  });

  it('records a leave with its reason, then Undo puts the class back', async () => {
    const user = userEvent.setup();
    renderPage(<TodayView />, { path: `/today?date=${tomorrow()}` });
    const table = await board();
    const row = rows(table)[0]!;
    const name = within(row).getAllByRole('button')[0]!.textContent!;
    await user.click(within(row).getByRole('button', { name: `إجراءات أخرى: ${name}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'تسجيل إجازة' }));
    const dialog = await screen.findByRole('dialog', { name: `تسجيل إجازة ${name}` });
    // Staff choose who took the leave.
    await user.click(within(dialog).getByRole('radio', { name: 'من المعلم' }));
    await user.type(within(dialog).getByLabelText(/ملاحظة/), 'Teacher travelling');
    await user.click(within(dialog).getByRole('button', { name: 'تسجيل إجازة' }));
    expect(await screen.findByText(`سُجّلت إجازة ${name}`)).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByText('إجازة')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'تراجع' }));
    expect(await screen.findByText('أُعيدت الحالة السابقة')).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByText('مجدولة')).toBeInTheDocument());
  });

  it('cancels only with a reason from the list (confirm dialog)', async () => {
    const user = userEvent.setup();
    let sent: Record<string, unknown> | null = null;
    server.events.on('request:start', async ({ request }) => {
      if (request.url.endsWith('/transitions')) sent = await request.clone().json();
    });
    renderPage(<TodayView />, { path: `/today?date=${tomorrow()}` });
    const table = await board();
    const row = rows(table)[1]!;
    const name = within(row).getAllByRole('button')[0]!.textContent!;
    await user.click(within(row).getByRole('button', { name: `إجراءات أخرى: ${name}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'إلغاء الحصة' }));
    const dialog = await screen.findByRole('alertdialog', { name: `إلغاء حصة ${name}` });
    await user.click(within(dialog).getByRole('button', { name: 'إلغاء الحصة' }));
    expect(await within(dialog).findByText('اختر السبب')).toBeInTheDocument();
    expect(sent).toBeNull();
    await user.click(within(dialog).getByRole('combobox', { name: /السبب/ }));
    await user.click(await screen.findByRole('option', { name: 'المعلم غير متاح' }));
    await user.click(within(dialog).getByRole('button', { name: 'إلغاء الحصة' }));
    expect(await screen.findByText(`أُلغيت حصة ${name}`)).toBeInTheDocument();
    expect(sent).toMatchObject({
      action: 'cancel',
      expectedStage: 'scheduled',
      stageReason: 'teacher_unavailable',
    });
    server.events.removeAllListeners();
  });

  it('shows a stale-screen refusal inside the dialog', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('*/api/v1/sessions/:id/transitions', () =>
        HttpResponse.json(
          { message: 'The class changed.', code: 'stale_session' },
          { status: 409 },
        ),
      ),
    );
    renderPage(<TodayView />, { path: `/today?date=${tomorrow()}` });
    const table = await board();
    const row = rows(table)[0]!;
    const name = within(row).getAllByRole('button')[0]!.textContent!;
    await user.click(within(row).getByRole('button', { name: `إجراءات أخرى: ${name}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'إلغاء الحصة' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('combobox', { name: /السبب/ }));
    await user.click(await screen.findByRole('option', { name: 'قرار إداري' }));
    await user.click(within(dialog).getByRole('button', { name: 'إلغاء الحصة' }));
    expect(await within(dialog).findByText(/تغيّرت الحصة على الشاشة الأخرى/)).toBeInTheDocument();
  });
});
