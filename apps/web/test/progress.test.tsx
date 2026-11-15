import { Progress } from '@qarabic/ui/components/progress';
import { render, screen } from '@testing-library/react';

/** The shared Progress: an accessible value, and a bar that grows from the inline-start. */
describe('Progress', () => {
  it('exposes its value to assistive tech', () => {
    render(<Progress value={40} aria-label="الإشغال" />);
    const bar = screen.getByRole('progressbar', { name: 'الإشغال' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('fills by width from the inline-start (RTL-safe), clamped to 0–100', () => {
    const { container, rerender } = render(<Progress value={40} />);
    const fill = container.querySelector('[data-slot="progress-indicator"]') as HTMLElement;
    expect(fill.style.width).toBe('40%');
    expect(fill.style.transform).toBe('');
    rerender(<Progress value={140} />);
    expect(fill.style.width).toBe('100%');
    rerender(<Progress value={null} />);
    expect(fill.style.width).toBe('0%');
  });
});
