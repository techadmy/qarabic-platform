import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MyScheduleView } from '@/app/(app)/my-schedule/my-schedule-view';
import { UtilizationView } from '@/components/reports/utilization-view';
import { lastReplacedUrl, renderPage } from '@/test/people';

const table = () => screen.findByRole('table', { name: 'إشغال المعلمين في الفترة' });
const rows = (t: HTMLElement) => within(t).getAllByRole('row').slice(1);

describe('R1 teacher utilization (docs/42 §5)', () => {
  it('lists teachers most loaded first, each opening their week on the calendar', async () => {
    renderPage(<UtilizationView />, { path: '/reports/utilization' });
    const t = await table();
    await waitFor(() => expect(rows(t).length).toBeGreaterThan(2));
    const pcts = rows(t).map((r) => Number(r.textContent!.match(/(\d+)%/)?.[1] ?? -1));
    expect(pcts).toEqual([...pcts].sort((a, b) => b - a));
    expect(within(rows(t)[0]!).getAllByRole('link')[0]).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/schedule\?view=week&teachers=\d+&date=/),
    );
    expect(screen.getByText('الساعات المتاحة')).toBeInTheDocument();
  });

  it('sorting and filters write the URL', async () => {
    const user = userEvent.setup();
    renderPage(<UtilizationView />, { path: '/reports/utilization' });
    const t = await table();
    await user.click(within(t).getByRole('button', { name: /فارغة/ }));
    expect(lastReplacedUrl().searchParams.get('sort')).toBe('free');
    const filters = screen.getByRole('group', { name: 'تصفية التقرير' });
    await user.click(within(filters).getByRole('combobox', { name: 'جنس المعلم' }));
    await user.click(await screen.findByRole('option', { name: 'معلمات' }));
    expect(lastReplacedUrl().searchParams.get('gender')).toBe('female');
  });

  it('shows the week’s free capacity as a weekday × hour table', async () => {
    renderPage(<UtilizationView />, { path: '/reports/utilization' });
    const cap = await screen.findByRole('table', { name: /المعلمون المتاحون لكل ساعة/ });
    expect(within(cap).getAllByRole('row')).toHaveLength(8);
    expect(within(cap).getAllByRole('columnheader')).toHaveLength(25);
  });

  it('a teacher sees only their own utilization card in «جدولي»', async () => {
    renderPage(<MyScheduleView />, { as: 'teacher@qarabic.test', path: '/my-schedule' });
    const card = await screen.findByRole('heading', { name: 'إشغالي هذا الشهر' });
    expect(card).toBeInTheDocument();
    expect(await screen.findAllByText('نسبة الإشغال')).toHaveLength(1);
  });

  it('without reports.view the page is forbidden', async () => {
    renderPage(<UtilizationView />, { as: 'parent@qarabic.test', path: '/reports/utilization' });
    expect((await screen.findAllByText(/ليست لديك صلاحية/)).length).toBeGreaterThan(0);
  });
});
