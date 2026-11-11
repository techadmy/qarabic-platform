import { describe, expect, it } from 'vitest';
import {
  Interval,
  isDstAdjusted,
  isoZ,
  OffsetProbe,
  toUtc,
  transitions,
  WeeklyPattern,
} from './time.js';

/* Port of Laravel tests/Feature/M2/TimeTest.php (ZonedTime, Interval, WeeklyPattern, OffsetProbe). */

const at = (iso: string) => new Date(iso).getTime();

describe('time helpers (TimeTest)', () => {
  it('treats intervals as half-open, with an optional buffer', () => {
    const a = Interval.of(at('2026-11-09T15:00:00Z'), 30);
    const b = Interval.of(at('2026-11-09T15:30:00Z'), 30);
    const c = Interval.of(at('2026-11-09T15:29:00Z'), 30);
    expect(a.overlaps(b)).toBe(false);
    expect(a.overlaps(b, 5)).toBe(true);
    expect(a.overlaps(c)).toBe(true);
  });

  it.each([
    ['London winter', '2026-11-09', '17:00', 'Europe/London', '2026-11-09T17:00:00Z'],
    ['London summer', '2027-04-05', '17:00', 'Europe/London', '2027-04-05T16:00:00Z'],
    ['New York winter', '2026-11-09', '13:00', 'America/New_York', '2026-11-09T18:00:00Z'],
    ['New York summer', '2027-03-15', '13:00', 'America/New_York', '2027-03-15T17:00:00Z'],
    ['Sydney summer (southern)', '2026-11-15', '23:30', 'Australia/Sydney', '2026-11-15T12:30:00Z'],
    ['Sydney winter', '2027-06-13', '23:30', 'Australia/Sydney', '2027-06-13T13:30:00Z'],
    ['Cairo winter', '2026-11-09', '17:00', 'Africa/Cairo', '2026-11-09T15:00:00Z'],
    [
      'Cairo summer (DST since 2023)',
      '2027-07-05',
      '17:00',
      'Africa/Cairo',
      '2027-07-05T14:00:00Z',
    ],
    ['Karachi (no DST)', '2027-07-05', '21:00', 'Asia/Karachi', '2027-07-05T16:00:00Z'],
    [
      'London Monday 00:30 is Sunday UTC in summer',
      '2027-04-05',
      '00:30',
      'Europe/London',
      '2027-04-04T23:30:00Z',
    ],
  ])('converts local wall time to UTC: %s', (_name, date, time, zone, utc) => {
    expect(isoZ(toUtc(date, time, zone))).toBe(utc);
  });

  it('moves a non-existent local time forward and takes the first of an ambiguous one', () => {
    // London springs forward 2027-03-28 01:00 → 02:00: 01:30 does not exist.
    expect(isoZ(toUtc('2027-03-28', '01:30', 'Europe/London'))).toBe('2027-03-28T01:30:00Z');
    expect(isDstAdjusted('2027-03-28', '01:30', 'Europe/London')).toBe(true);
    // London falls back 2026-10-25 02:00 → 01:00: 01:30 happens twice; first = BST.
    expect(isoZ(toUtc('2026-10-25', '01:30', 'Europe/London'))).toBe('2026-10-25T00:30:00Z');
    expect(isDstAdjusted('2026-10-25', '01:30', 'Europe/London')).toBe(true);
    expect(isDstAdjusted('2026-11-09', '17:00', 'Europe/London')).toBe(false);
  });

  it('finds the US and UK transitions of 2027 to the minute', () => {
    const list = transitions(
      ['Europe/London', 'America/New_York'],
      at('2027-01-01T00:00:00Z'),
      at('2027-12-31T00:00:00Z'),
    ).map(isoZ);
    expect(list).toEqual([
      '2027-03-14T07:00:00Z', // New York 02:00 EST → EDT
      '2027-03-28T01:00:00Z', // London 01:00 GMT → BST
      '2027-10-31T01:00:00Z', // London back
      '2027-11-07T06:00:00Z', // New York back
    ]);
  });

  it('lists weekly occurrences with their own UTC instant', () => {
    const p = new WeeklyPattern(1, '17:00', 30, 'Europe/London', '2027-03-01');
    const occ = p.occurrencesBetween(at('2027-03-20T00:00:00Z'), at('2027-04-06T00:00:00Z'));
    expect([...occ.keys()]).toEqual(['2027-03-22', '2027-03-29', '2027-04-05']);
    expect(isoZ(occ.get('2027-03-22')!.start)).toBe('2027-03-22T17:00:00Z');
    expect(isoZ(occ.get('2027-03-29')!.start)).toBe('2027-03-29T16:00:00Z');
  });

  it('finds a recurring overlap that only exists in summer (offset probing)', () => {
    // London Mon 17:00 vs Karachi Mon 21:00 (= 16:00 UTC all year): overlap only during BST.
    const london = new WeeklyPattern(1, '17:00', 30, 'Europe/London', '2026-11-01');
    const karachi = new WeeklyPattern(1, '21:00', 30, 'Asia/Karachi', '2026-11-01');
    expect(OffsetProbe.firstOverlap(london, karachi, 0, '2026-11-09')).toBe('2027-03-29');
    // a slot that ends before summer never overlaps
    const short = new WeeklyPattern(1, '17:00', 30, 'Europe/London', '2026-11-01', '2027-03-01');
    expect(OffsetProbe.firstOverlap(short, karachi, 0, '2026-11-09')).toBeNull();
  });

  it('finds the two weeks where the US and the EU are on different DST dates', () => {
    // London Mon 17:00 vs New York Mon 12:45: they overlap only while the US is on summer time
    // and the UK is not (the March and November gaps).
    const london = new WeeklyPattern(1, '17:00', 30, 'Europe/London', '2026-11-01');
    const ny = new WeeklyPattern(1, '12:45', 30, 'America/New_York', '2026-11-01');
    expect(OffsetProbe.firstOverlap(london, ny, 0, '2026-11-09')).toBe('2027-03-15');
    expect(OffsetProbe.firstOverlap(london, ny, 0, '2027-03-29')).toBe('2027-11-01');
  });

  it('handles the southern hemisphere (Sydney) against Cairo', () => {
    const sydney = new WeeklyPattern(2, '01:00', 30, 'Australia/Sydney', '2026-11-01');
    const cairo = new WeeklyPattern(1, '17:00', 30, 'Africa/Cairo', '2026-11-01');
    expect(OffsetProbe.firstOverlap(sydney, cairo, 0, '2026-11-09')).toBe('2027-04-06');
  });

  it('reports the local times a slot has in another zone across the year', () => {
    const london = new WeeklyPattern(1, '17:00', 30, 'Europe/London', '2026-11-01');
    expect(OffsetProbe.localTimesIn(london, 'Africa/Cairo', '2026-11-09').sort()).toEqual([
      '1 18:00',
      '1 19:00',
    ]);
    expect(OffsetProbe.localTimesIn(london, 'Asia/Karachi', '2026-11-09').sort()).toEqual([
      '1 21:00',
      '1 22:00',
    ]);
  });

  it('keeps a US student’s class at the same local time across the March and November switches', () => {
    // A New York family, Mondays 16:00 local, all year: UTC moves by an hour twice.
    const ny = new WeeklyPattern(1, '16:00', 30, 'America/New_York', '2027-03-01');
    const occ = ny.occurrencesBetween(at('2027-03-01T00:00:00Z'), at('2027-11-16T00:00:00Z'));
    expect(isoZ(occ.get('2027-03-08')!.start)).toBe('2027-03-08T21:00:00Z'); // EST
    expect(isoZ(occ.get('2027-03-15')!.start)).toBe('2027-03-15T20:00:00Z'); // EDT
    expect(isoZ(occ.get('2027-11-01')!.start)).toBe('2027-11-01T20:00:00Z'); // still EDT
    expect(isoZ(occ.get('2027-11-08')!.start)).toBe('2027-11-08T21:00:00Z'); // EST again
  });
});
