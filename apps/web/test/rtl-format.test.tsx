import { formatChartNumber } from '@qarabic/ui/components/chart';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TeacherProfile } from '@/app/(app)/teachers/[id]/teacher-profile';
import { UserMenu } from '@/components/shell/user-menu';
import { formatMoney } from '@/lib/billing/money';
import { db as people } from '@/mocks/people-db';
import { renderPage } from '@/test/people';
import { renderWithProviders } from '@/test/render';

/** Audit 39 P2-5 (RTL-5, RTL-6): mirrored direction icons, locale numbers, the shared money helper. */
describe('RTL details', () => {
  it('the teacher profile writes the hourly rate with the shared money helper (Arabic)', async () => {
    const t = people.teachers.find((x) => x.id === 1)!;
    renderPage(<TeacherProfile id={1} />, { path: '/teachers/1' });
    const expected = formatMoney(t.hourlyRate!, t.hourlyRateCurrency!, 'ar');
    const cells = await screen.findAllByText(
      (_, el) => !!el && el.children.length === 0 && (el.textContent ?? '').includes('95.00'),
    );
    expect(cells.map((c) => c.textContent)).toContain(expected);
  });

  it('chart tooltips use the page language with Latin digits', () => {
    document.documentElement.lang = 'ar';
    const ar = String(formatChartNumber(1234567.5));
    expect(ar).toMatch(/^[\d.,٫٬  ]+$/);
    expect(ar).not.toMatch(/[٠-٩]/);
    document.documentElement.lang = 'en';
    expect(formatChartNumber(1234567.5)).toBe('1,234,567.5');
    expect(formatChartNumber('n/a')).toBe('n/a');
  });

  it('the log-out arrow is mirrored in RTL', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserMenu user={{ name: 'مدير النظام', email: 'a@b.test' }} dir="rtl" />);
    await user.click(screen.getByRole('button'));
    const item = await screen.findByRole('menuitem', { name: /تسجيل الخروج/ });
    expect(item.querySelector('svg')).toHaveClass('rtl:-scale-x-100');
  });
});
