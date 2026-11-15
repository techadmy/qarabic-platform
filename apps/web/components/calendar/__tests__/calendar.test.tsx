import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CalendarView } from '@/components/calendar/calendar-view';
import { lastReplacedUrl, renderPage } from '@/test/people';

describe('calendar (C2, docs/42 §3)', () => {
  it('shows the classes of the range in the list view, with the filters and the zone', async () => {
    renderPage(<CalendarView />, { path: '/schedule?view=list' });
    expect(await screen.findByRole('heading', { level: 1, name: 'الجدول' })).toBeInTheDocument();
    const filters = screen.getByRole('group', { name: 'تصفية التقويم' });
    expect(within(filters).getByRole('combobox', { name: 'توقيت العرض' })).toHaveTextContent(
      'توقيت الأكاديمية (القاهرة)',
    );
    // The mock's classes this week, each labelled with its student.
    await waitFor(() => expect(screen.getAllByText(/ · /).length).toBeGreaterThan(0));
    expect(screen.getByRole('link', { name: /الاشتراكات/ })).toHaveAttribute(
      'href',
      '/schedule/enrollments',
    );
  });

  it('filters write the URL; the teacher’s zone needs one teacher', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarView />, { path: '/schedule' });
    const filters = await screen.findByRole('group', { name: 'تصفية التقويم' });
    await user.click(within(filters).getByRole('combobox', { name: 'النوع' }));
    await user.click(await screen.findByRole('option', { name: 'تجريبية' }));
    expect(lastReplacedUrl().searchParams.get('kind')).toBe('trial');
    await user.click(within(filters).getByRole('combobox', { name: 'توقيت العرض' }));
    expect(
      await screen.findByRole('option', { name: 'توقيت المعلم (اختر معلمًا واحدًا)' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('a parent cannot open the staff calendar', async () => {
    renderPage(<CalendarView />, { as: 'parent@qarabic.test', path: '/schedule' });
    expect((await screen.findAllByText(/ليست لديك صلاحية/)).length).toBeGreaterThan(0);
  });
});
