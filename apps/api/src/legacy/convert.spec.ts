import { describe, expect, it } from 'vitest';
import {
  camelizeJson,
  dateOnly,
  decimalToMinor,
  e164,
  familyStatus,
  floatToDecimal,
  gender,
  hhmm,
  localToUtc,
  looseDate,
  minorToDecimal,
  minutesOfTime,
  sessionStage,
  studentLanguage,
  subjectTypeOf,
  utc,
} from './convert.js';

describe('legacy convert: time', () => {
  it('reads Laravel datetimes as UTC (APP_TIMEZONE=UTC), keeping milliseconds', () => {
    expect(utc('2026-11-04 15:30:00')?.toISOString()).toBe('2026-11-04T15:30:00.000Z');
    expect(utc('2026-11-04 15:30:00.123')?.toISOString()).toBe('2026-11-04T15:30:00.123Z');
    expect(utc('0000-00-00 00:00:00')).toBeNull();
    expect(utc(null)).toBeNull();
    expect(utc('not a date')).toBeNull();
  });

  it('honours a non-UTC app zone, across a DST change', () => {
    // Europe/London: BST (+1) until 2026-10-25 01:00 UTC, then GMT.
    expect(utc('2026-10-24 12:00:00', 'Europe/London')?.toISOString()).toBe(
      '2026-10-24T11:00:00.000Z',
    );
    expect(utc('2026-10-26 12:00:00', 'Europe/London')?.toISOString()).toBe(
      '2026-10-26T12:00:00.000Z',
    );
  });

  it('turns legacy academy-local class times into UTC (Cairo DST 2026: until 2026-10-29)', () => {
    // Africa/Cairo is UTC+3 in summer time (last Thursday of October) and UTC+2 after it.
    expect(localToUtc('2026-10-28', '18:00:00', 'Africa/Cairo').toISOString()).toBe(
      '2026-10-28T15:00:00.000Z',
    );
    expect(localToUtc('2026-11-05', '18:00:00', 'Africa/Cairo').toISOString()).toBe(
      '2026-11-05T16:00:00.000Z',
    );
    // New York: EDT until 2026-11-01.
    expect(localToUtc('2026-10-31', '17:00', 'America/New_York').toISOString()).toBe(
      '2026-10-31T21:00:00.000Z',
    );
    expect(localToUtc('2026-11-02', '17:00', 'America/New_York').toISOString()).toBe(
      '2026-11-02T22:00:00.000Z',
    );
  });

  it('parses dates and loose legacy dates (day-first)', () => {
    expect(dateOnly('2026-09-01')?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(dateOnly('2026-02-30')).toBeNull();
    expect(looseDate('15/03/2026')?.toISOString().slice(0, 10)).toBe('2026-03-15');
    expect(looseDate('2026/3/5')?.toISOString().slice(0, 10)).toBe('2026-03-05');
    expect(looseDate('next week')).toBeNull();
    expect(hhmm('09:05:00')).toBe('09:05');
    expect(minutesOfTime('00:45:00')).toBe(45);
    expect(minutesOfTime('01:30:00')).toBe(90);
  });
});

describe('legacy convert: money', () => {
  it('converts minor units to exact decimals and back', () => {
    expect(minorToDecimal(4000)).toBe('40.00');
    expect(minorToDecimal(-715)).toBe('-7.15');
    expect(minorToDecimal(5)).toBe('0.05');
    expect(minorToDecimal('900719925474099312')).toBe('9007199254740993.12');
    expect(minorToDecimal(null)).toBeNull();
    expect(decimalToMinor('12.3')).toBe(1230n);
    expect(decimalToMinor('-0.05')).toBe(-5n);
  });

  it('rounds legacy doubles half-up through their decimal text (no float maths)', () => {
    expect(floatToDecimal(150.5)).toBe('150.50');
    expect(floatToDecimal(0.125)).toBe('0.13');
    expect(floatToDecimal(180)).toBe('180.00');
    expect(floatToDecimal(null)).toBeNull();
  });

  it('camelizes app JSON and turns *_minor into decimals', () => {
    expect(
      camelizeJson({
        full_amount_minor: 1234,
        classes_per_week: 2,
        slot_tiers: [{ min_slots: 2 }],
      }),
    ).toEqual({
      fullAmount: '12.34',
      classesPerWeek: 2,
      slotTiers: [{ minSlots: 2 }],
    });
  });
});

describe('legacy convert: codes', () => {
  it('maps family statuses (legacy spellings included)', () => {
    expect(familyStatus('Trial')).toBe('trial');
    expect(familyStatus('leave')).toBe('on_leave');
    expect(familyStatus('suspend')).toBe('suspended');
    expect(familyStatus('inactive')).toBe('deactivated');
    expect(familyStatus(null)).toBe('regular');
    expect(familyStatus('vip')).toBeNull();
  });

  it('maps class stage, falling back to the legacy status like ClassSession::fillFromLegacy', () => {
    expect(sessionStage('taken', 'ended')).toBe('taken');
    expect(sessionStage(null, 'started')).toBe('in_progress');
    expect(sessionStage('', 'canceled')).toBe('cancelled');
    expect(sessionStage('bogus', 'active')).toBe('scheduled');
  });

  it('maps genders, languages, phones and model classes', () => {
    expect(gender('1')).toBe('male');
    expect(gender('Female')).toBe('female');
    expect(gender('x')).toBeNull();
    expect(studentLanguage('3')).toBe('english_urdu');
    expect(studentLanguage('Pushto')).toBe('pashto');
    expect(e164('+44 7700 900123')).toBe('+447700900123');
    expect(e164('0044 (7700) 900-123')).toBe('+447700900123');
    expect(e164('01000000999')).toBeNull();
    expect(subjectTypeOf('App\\Models\\Feedback\\FeedbackTicket')).toBe('feedback_ticket');
  });
});
