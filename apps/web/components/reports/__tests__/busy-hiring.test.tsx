import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { byWeekday, ranked } from '@/components/reports/busy-days';
import { UtilizationView } from '@/components/reports/utilization-view';
import { renderPage } from '@/test/people';

const day = (date: string, weekday: number, booked: number, available: number) => ({
  date,
  weekday,
  availableHours: available,
  bookedHours: booked,
  freeHours: available - booked,
  outsideHours: 0,
  utilization: available ? booked / available : null,
  classes: 0,
});

describe('R1 follow-up: busiest days and the hiring check', () => {
  it('adds up each weekday over the range and ranks busiest first, «—» last', () => {
    const rows = ranked(
      byWeekday(
        [
          day('2026-11-14', 6, 4, 10),
          day('2026-11-21', 6, 6, 10),
          day('2026-11-15', 7, 9, 10),
          day('2026-11-20', 5, 0, 0),
        ],
        'ar',
      ),
    );
    expect(rows.map((r) => [r.key, r.util])).toEqual([
      ['7', 0.9],
      ['6', 0.5],
      ['5', null],
    ]);
  });

  it('the page shows the busiest days and answers the hiring check from the week’s grid', async () => {
    const user = userEvent.setup();
    renderPage(<UtilizationView />, { path: '/reports/utilization' });
    expect(await screen.findByRole('table', { name: 'حسب يوم الأسبوع' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'أكثر الأيام انشغالًا' })).toBeInTheDocument();
    const card = (await screen.findByRole('heading', { name: 'هل نحتاج معلمًا جديدًا؟' })).closest(
      '[data-slot="card"]',
    ) as HTMLElement;
    const answer = await within(card).findByRole('status');
    expect(answer).toHaveTextContent(/المطلوب 10 ساعة في الأسبوع/);
    // Many students: not enough, with how much is short.
    const students = within(card).getByLabelText('عدد الطلاب الجدد');
    await user.clear(students);
    await user.type(students, '٥٠٠');
    expect(within(card).getByRole('status')).toHaveTextContent(/لا يكفي: ينقص نحو/);
    // A window with nobody free lists its gaps.
    await user.click(within(card).getByRole('combobox', { name: 'من الساعة' }));
    await user.click(await screen.findByRole('option', { name: '2 ص' }));
    expect(within(card).getByRole('status')).toHaveTextContent('ساعات بلا أي معلم متاح:');
  });
});
