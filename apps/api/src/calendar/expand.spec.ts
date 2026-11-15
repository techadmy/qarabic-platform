import { describe, expect, it } from 'vitest';
import {
  expandRecurring,
  expandWorkHours,
  holidaySpan,
  hoursOf,
  merge,
  subtract,
} from './expand.js';

const ms = (iso: string) => Date.parse(iso);
const isoSpans = (spans: Array<{ start: number; end: number }>) =>
  spans.map((s) => [new Date(s.start).toISOString(), new Date(s.end).toISOString()]);

describe('expandWorkHours', () => {
  it('follows the teacher’s clock across the March DST change (London)', () => {
    // 2027-03-28: London moves to summer time. Mondays 09:00–10:00.
    const spans = expandWorkHours(
      [{ weekday: 1, localStartTime: '09:00', localEndTime: '10:00', timezone: 'Europe/London' }],
      ms('2027-03-22T00:00:00Z'),
      ms('2027-03-30T00:00:00Z'),
    );
    expect(isoSpans(spans)).toEqual([
      ['2027-03-22T09:00:00.000Z', '2027-03-22T10:00:00.000Z'],
      ['2027-03-29T08:00:00.000Z', '2027-03-29T09:00:00.000Z'],
    ]);
  });

  it('clips to the range and joins touching rows', () => {
    const spans = expandWorkHours(
      [
        { weekday: 2, localStartTime: '08:00', localEndTime: '12:00', timezone: 'UTC' },
        { weekday: 2, localStartTime: '12:00', localEndTime: '14:00', timezone: 'UTC' },
      ],
      ms('2026-11-03T10:00:00Z'),
      ms('2026-11-03T13:00:00Z'),
    );
    expect(isoSpans(spans)).toEqual([['2026-11-03T10:00:00.000Z', '2026-11-03T13:00:00.000Z']]);
  });
});

describe('expandRecurring', () => {
  it('respects validFrom / validTo (local dates)', () => {
    const spans = expandRecurring(
      {
        weekday: 1,
        localStartTime: '12:00',
        durationMinutes: 30,
        timezone: 'UTC',
        validFrom: '2026-11-09',
        validTo: '2026-11-16',
      },
      ms('2026-11-01T00:00:00Z'),
      ms('2026-12-01T00:00:00Z'),
    );
    expect(isoSpans(spans).map(([s]) => s)).toEqual([
      '2026-11-09T12:00:00.000Z',
      '2026-11-16T12:00:00.000Z',
    ]);
  });
});

describe('holidaySpan and merge', () => {
  it('a multi-day holiday covers whole academy days', () => {
    const span = holidaySpan('2026-11-10', '2026-11-11', 'UTC', 0, ms('2027-01-01T00:00:00Z'));
    expect(isoSpans([span!])).toEqual([['2026-11-10T00:00:00.000Z', '2026-11-12T00:00:00.000Z']]);
    expect(
      holidaySpan(
        '2026-11-10',
        null,
        'UTC',
        ms('2026-12-01T00:00:00Z'),
        ms('2027-01-01T00:00:00Z'),
      ),
    ).toBeNull();
  });

  it('merge sorts and joins overlaps', () => {
    expect(
      merge([
        { start: 5, end: 9 },
        { start: 1, end: 3 },
        { start: 2, end: 6 },
      ]),
    ).toEqual([{ start: 1, end: 9 }]);
  });
});

describe('subtract and hoursOf', () => {
  it('cuts holes, edges and whole spans', () => {
    const h = 3_600_000;
    const day = [{ start: 9 * h, end: 17 * h }];
    expect(subtract(day, [{ start: 12 * h, end: 13 * h }])).toEqual([
      { start: 9 * h, end: 12 * h },
      { start: 13 * h, end: 17 * h },
    ]);
    expect(
      subtract(day, [
        { start: 8 * h, end: 10 * h },
        { start: 16 * h, end: 18 * h },
      ]),
    ).toEqual([{ start: 10 * h, end: 16 * h }]);
    expect(subtract(day, [{ start: 0, end: 24 * h }])).toEqual([]);
    expect(hoursOf(subtract(day, [{ start: 9 * h, end: 9.5 * h }]))).toBe(7.5);
  });
});
