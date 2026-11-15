import { describe, expect, it } from 'vitest';
import { bucketFor, changePct, paramsOf, presetSpan, previousOf, rangeFromParams } from './range';

// A Wednesday in mid-November.
const TODAY = '2026-11-18';
const params = (q: Record<string, string | undefined>) => (k: string) => q[k] ?? '';

describe('dashboard range (docs/40 §2.4)', () => {
  it.each([
    ['today', '2026-11-18', '2026-11-18'],
    // The academy's week starts on Saturday.
    ['this_week', '2026-11-14', '2026-11-18'],
    ['this_month', '2026-11-01', '2026-11-18'],
    ['last_month', '2026-10-01', '2026-10-31'],
    ['this_quarter', '2026-10-01', '2026-11-18'],
    ['this_year', '2026-01-01', '2026-11-18'],
    ['last_12_months', '2025-12-01', '2026-11-18'],
  ] as const)('%s spans %s → %s', (preset, from, to) => {
    expect(presetSpan(preset, TODAY)).toEqual({ from, to });
  });

  it('defaults to this month, without compare (B122)', () => {
    const r = rangeFromParams(params({}), TODAY);
    expect(r).toMatchObject({ preset: 'this_month', from: '2026-11-01', compare: false });
    expect(r.previous).toBeNull();
    expect(paramsOf(r)).toEqual({ range: null, from: null, to: null, compare: null });
  });

  it('compares a month so far with the same days of the month before', () => {
    expect(previousOf('this_month', '2026-11-01', '2026-11-18')).toEqual({
      from: '2026-10-01',
      to: '2026-10-18',
    });
    // March 31 days → February stops at its own end.
    expect(previousOf('last_month', '2026-03-01', '2026-03-31')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('compares any other range with the same number of days just before', () => {
    expect(previousOf('custom', '2026-11-10', '2026-11-16')).toEqual({
      from: '2026-11-03',
      to: '2026-11-09',
    });
  });

  it('reads a custom range from the URL, and refuses a broken one', () => {
    const ok = rangeFromParams(
      params({ range: 'custom', from: '2026-09-01', to: '2026-09-30', compare: '1' }),
      TODAY,
    );
    expect(ok).toMatchObject({ preset: 'custom', from: '2026-09-01', to: '2026-09-30' });
    expect(ok.previous).toEqual({ from: '2026-08-02', to: '2026-08-31' });
    for (const bad of [
      { range: 'custom', from: '2026-09-30', to: '2026-09-01' },
      { range: 'custom', from: '2026-12-01', to: '2026-12-31' },
      { range: 'custom', from: 'x', to: '2026-09-01' },
      { range: 'nonsense' },
    ]) {
      expect(rangeFromParams(params(bad), TODAY).preset).toBe('this_month');
    }
  });

  it('picks the bars: per day up to a month, per week up to ~4 months, else per month', () => {
    expect(bucketFor('2026-11-01', '2026-11-30')).toBe('day');
    expect(bucketFor('2026-09-01', '2026-11-30')).toBe('week');
    expect(bucketFor('2025-12-01', '2026-11-30')).toBe('month');
  });

  it('change in % (none against zero or nothing)', () => {
    expect(changePct(120, 100)).toBe(20);
    expect(changePct(90, 120)).toBe(-25);
    expect(changePct(5, 0)).toBeNull();
    expect(changePct(5, null)).toBeNull();
  });
});
