import { describe, expect, it } from 'vitest';
import { bucketFor, changePct, changePoints, paramsOf, presetSpan, rangeFromParams } from './range';

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
    expect(r).toMatchObject({
      preset: 'this_month',
      from: '2026-11-01',
      compare: false,
      invalid: null,
    });
    expect(paramsOf(r)).toEqual({ range: null, from: null, to: null, compare: null });
  });

  it('reads a custom range from the URL', () => {
    const ok = rangeFromParams(
      params({ range: 'custom', from: '2026-09-01', to: '2026-09-30', compare: '1' }),
      TODAY,
    );
    expect(ok).toMatchObject({
      preset: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
      compare: true,
      invalid: null,
    });
  });

  it('keeps a custom range it cannot use and says why (never another range quietly)', () => {
    const bad = (from: string, to: string) =>
      rangeFromParams(params({ range: 'custom', from, to }), TODAY);
    expect(bad('2026-09-30', '2026-09-01')).toMatchObject({ preset: 'custom', invalid: 'order' });
    expect(bad('2026-12-01', '2026-12-31').invalid).toBe('future');
    expect(bad('2024-01-01', '2026-11-01').invalid).toBe('too_long');
    // Not dates at all, or an unknown preset: the default month.
    expect(rangeFromParams(params({ range: 'custom', from: 'x', to: 'y' }), TODAY).preset).toBe(
      'this_month',
    );
    expect(rangeFromParams(params({ range: 'nonsense' }), TODAY).preset).toBe('this_month');
  });

  it('picks the bars: per day up to a month, per week up to ~4 months, else per month', () => {
    expect(bucketFor('2026-11-01', '2026-11-30')).toBe('day');
    expect(bucketFor('2026-09-01', '2026-11-30')).toBe('week');
    expect(bucketFor('2025-12-01', '2026-11-30')).toBe('month');
  });

  it('a ratio changes in percentage points', () => {
    expect(changePoints(0.9, 0.8)).toBe(10);
    expect(changePoints(0.75, 0.8)).toBe(-5);
    expect(changePoints(0.8, null)).toBeNull();
  });

  it('change in % (none against zero or nothing)', () => {
    expect(changePct(120, 100)).toBe(20);
    expect(changePct(90, 120)).toBe(-25);
    expect(changePct(5, 0)).toBeNull();
    expect(changePct(5, null)).toBeNull();
  });
});
