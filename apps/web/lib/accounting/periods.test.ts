import { describe, expect, it } from 'vitest';
import { hasEnded, periodOfDay, shownYear } from './periods';

describe('accounting periods', () => {
  it('a month can be closed only after it ends', () => {
    expect(hasEnded('2026-10', '2026-11-12')).toBe(true);
    expect(hasEnded('2026-11', '2026-11-12')).toBe(false);
    expect(hasEnded('2026-12', '2026-11-12')).toBe(false);
    expect(hasEnded('2025-12', '2026-01-01')).toBe(true);
    expect(periodOfDay('2026-02-28')).toBe('2026-02');
  });

  it('the year comes from the URL only when it is sensible', () => {
    expect(shownYear('2025', '2026-11-12')).toBe(2025);
    expect(shownYear('', '2026-11-12')).toBe(2026);
    expect(shownYear('2031', '2026-11-12')).toBe(2026);
    expect(shownYear('1999', '2026-11-12')).toBe(2026);
    expect(shownYear('abc', '2026-11-12')).toBe(2026);
  });
});
