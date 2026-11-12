import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { formatMonth, MonthPicker } from '@/components/forms/date-time';
import { renderWithProviders } from '@/test/render';

function Picker({ initial, max, min }: { initial: string; max?: string; min?: string }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <label htmlFor="m">الشهر</label>
      <MonthPicker id="m" value={v} onChange={setV} max={max} min={min} />
      <output>{v}</output>
    </>
  );
}

describe('MonthPicker (replaces <input type="month">)', () => {
  it('shows the month in the UI language with Latin digits', () => {
    expect(formatMonth('2026-11', 'ar')).toBe('نوفمبر 2026');
    expect(formatMonth('2026-11', 'en')).toBe('November 2026');
    expect(formatMonth('', 'ar')).toBe('');
  });

  it('picks a month of another year by keyboard and closes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker initial="2026-01" />);
    const trigger = screen.getByLabelText('الشهر');
    expect(trigger).toHaveTextContent('يناير 2026');
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('button', { name: 'يناير 2026' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'السنة السابقة' }));
    await user.click(screen.getByRole('button', { name: 'ديسمبر 2025' }));
    expect(screen.getByRole('status')).toHaveTextContent('2025-12');
    expect(screen.queryByRole('button', { name: 'نوفمبر 2025' })).toBeNull();
    expect(trigger).toHaveTextContent('ديسمبر 2025');
  });

  it('disables months outside min/max and the year arrows past them', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker initial="2026-05" min="2026-03" max="2026-06" />);
    await user.click(screen.getByLabelText('الشهر'));
    expect(await screen.findByRole('button', { name: 'فبراير 2026' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'يوليو 2026' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'مارس 2026' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'السنة السابقة' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'السنة التالية' })).toBeDisabled();
  });

  it('reads in English', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker initial="2026-11" />, { locale: 'en' });
    await user.click(screen.getByLabelText('الشهر'));
    expect(await screen.findByRole('button', { name: 'November 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next year' })).toBeInTheDocument();
  });
});
