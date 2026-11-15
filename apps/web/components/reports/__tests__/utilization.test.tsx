import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MyScheduleView } from '@/app/(app)/my-schedule/my-schedule-view';
import { http, HttpResponse } from 'msw';
import { UtilizationView } from '@/components/reports/utilization-view';
import { fetchUtilization } from '@/lib/api/utilization';
import { mockSignIn } from '@/mocks/handlers';
import { server } from '@/mocks/node';
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
    // Each cell is said in words, not only by its shade.
    expect(
      within(cap).getAllByText(/معلم(ان)? متاح|معلمين متاحين|معلمًا متاحًا|لا يوجد معلم متاح/).length,
    ).toBeGreaterThan(0);
  });

  it('a week with nobody free says 0 in every cell (no shade alone)', async () => {
    server.use(
      http.get('*/api/v1/reports/free-capacity', () =>
        HttpResponse.json({
          data: {
            range: { from: '2026-11-14', to: '2026-11-20', timezone: 'Africa/Cairo' },
            teacherCount: 0,
            days: Array.from({ length: 7 }, (_, i) => ({
              date: `2026-11-${14 + i}`,
              weekday: ((5 + i) % 7) + 1,
              free: Array(24).fill(0),
            })),
          },
        }),
      ),
    );
    renderPage(<UtilizationView />, { path: '/reports/utilization' });
    const cap = await screen.findByRole('table', { name: /المعلمون المتاحون لكل ساعة/ });
    expect(within(cap).getAllByText('لا يوجد معلم متاح')).toHaveLength(7 * 24);
  });

  it('a teacher gets only their own row from the API', async () => {
    mockSignIn('teacher@qarabic.test');
    const r = await fetchUtilization({});
    expect(r.teachers.map((x) => x.teacher.id)).toEqual([1]);
  });

  it('says which period the change compares with', async () => {
    renderPage(<UtilizationView />, { path: '/reports/utilization' });
    expect(await screen.findByText(/التغيّر مقارنةً بـ/)).toBeInTheDocument();
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
