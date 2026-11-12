import { describe, expect, it } from 'vitest';
import { dueInstant, endOfDayInstant, listText, routeId, splitInstant, subjectHref } from './time';

describe('due times in the viewer zone (D30)', () => {
  it('a date and a time in Cairo become the matching UTC instant', () => {
    expect(dueInstant('2026-11-12', '09:30', 'Africa/Cairo')).toBe('2026-11-12T07:30:00Z');
  });

  it('no time → 17:00 that day; no date → null', () => {
    expect(dueInstant('2026-11-12', '', 'Africa/Cairo')).toBe('2026-11-12T15:00:00Z');
    expect(dueInstant('', '10:00', 'Africa/Cairo')).toBeNull();
  });

  it('round-trips through splitInstant, across a DST change (New York, 2026-11-01)', () => {
    const iso = dueInstant('2026-11-02', '08:15', 'America/New_York')!;
    expect(iso).toBe('2026-11-02T13:15:00Z');
    expect(splitInstant(iso, 'America/New_York')).toEqual({ date: '2026-11-02', time: '08:15' });
    expect(splitInstant(null, 'Africa/Cairo')).toEqual({ date: '', time: '' });
  });

  it('an end date is the last minute of that day', () => {
    expect(endOfDayInstant('2026-11-30', 'Africa/Cairo')).toBe('2026-11-30T21:59:00Z');
    expect(endOfDayInstant('', 'Africa/Cairo')).toBeNull();
  });
});

it('subject links, lists and route ids', () => {
  expect(subjectHref('family', 4)).toBe('/families/4');
  expect(subjectHref('session', 9)).toBe('/today?session=9');
  expect(listText(['Teachers', 'Parents'], 'en')).toBe('Teachers and Parents');
  expect(listText(['المعلم', 'ولي أمر'], 'ar')).toContain('و');
  expect(routeId('12')).toBe(12);
  expect(routeId('abc')).toBeNull();
  expect(routeId('0')).toBeNull();
});
