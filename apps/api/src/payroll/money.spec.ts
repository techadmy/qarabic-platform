import { describe, expect, it } from 'vitest';
import { slotTier } from './calculator.js';
import { centi, cents, divRound, fromCents, hours } from './money.js';
import { datesBetween, Period } from './period.js';

/** Port of the integer-maths and period cases of Laravel SalaryTypesTest (D90, D89). */
describe('payroll money (integer maths only)', () => {
  it('parses and prints decimals without floats', () => {
    expect(centi('0.50')).toBe(50);
    expect(centi('12.3')).toBe(1230);
    expect(centi(0.1 + 0.2)).toBe(30);
    expect(cents({ toFixed: () => '99999999.99' })).toBe(9_999_999_999);
    expect(cents(null)).toBe(0);
    expect(cents('-1.25')).toBe(-125);
    expect(hours(-125)).toBe('-1.25');
    expect(fromCents(5)).toBe('0.05');
    expect(fromCents(123456)).toBe('1234.56');
  });

  it('divides and rounds half away from zero', () => {
    expect(divRound(3_000_000 * 1, 30)).toBe(100_000);
    expect(divRound(1001, 2)).toBe(501);
    expect(divRound(-1001, 2)).toBe(-501);
    expect(divRound(50 * 333, 100)).toBe(167); // 3.33/h × 0.5 h
    expect(divRound(1, 0)).toBe(0);
    // Large products stay exact (BigInt).
    expect(divRound(99_999_999_999 * 10_000, 100)).toBe(9_999_999_999_900);
  });

  it('picks the highest slot tier reached', () => {
    const tiers = [
      { minSlots: 0, amount: '100.00' },
      { minSlots: 2, amount: '500.00' },
      { minSlots: 4, amount: '900.00' },
    ];
    expect(slotTier(tiers, 400)).toBe(90000);
    expect(slotTier(tiers, 399)).toBe(50000);
    expect(slotTier([], 400)).toBeNull();
  });
});

describe('payroll period (academy calendar month)', () => {
  it('maps a month to UTC instants in the zone (DST included)', () => {
    const p = Period.parse('2026-10');
    expect(p.toString()).toBe('2026-10');
    expect(p.startsOn()).toBe('2026-10-01');
    expect(p.endsOn()).toBe('2026-10-31');
    expect(p.fromUtc('Africa/Cairo').toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(p.toUtc('Africa/Cairo').toISOString()).toBe('2026-10-31T22:00:00.000Z');
    expect(Period.parse('2028-02').endsOn()).toBe('2028-02-29');
    expect(Period.parse('2026-12').next().toString()).toBe('2027-01');
    expect(Period.parse('2026-01').previous().toString()).toBe('2025-12');
    expect(Period.parse('2026-12').isAfter(Period.parse('2026-11'))).toBe(true);
    expect(p.contains('2026-10-31')).toBe(true);
    expect(p.contains('2026-11-01')).toBe(false);
    expect(() => Period.parse('2026-13')).toThrow();
  });

  it('knows the current month in the academy zone', () => {
    // 23:30 UTC on 31 Oct = 01:30 on 1 Nov in Cairo.
    expect(Period.current(Date.parse('2026-10-31T23:30:00Z'), 'Africa/Cairo').toString()).toBe(
      '2026-11',
    );
    expect(Period.current(Date.parse('2026-10-31T23:30:00Z'), 'UTC').toString()).toBe('2026-10');
  });

  it('lists the dates of a range', () => {
    expect(datesBetween('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });
});
