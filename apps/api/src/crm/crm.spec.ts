import { describe, expect, it } from 'vitest';
import { SETTING_DEFAULTS, type SettingsMap } from '../settings/settings.service.js';
import { countryOfPhone } from './calling-codes.js';
import { signWebLead, verifyWebLead } from './crm.config.js';
import { phoneDigits, scoreSpam } from './spam.js';
import { buildChildren, parseAges, utmOf } from './web-lead-mapper.js';
import { WorkingHours } from './working-hours.js';
import { zoneForCountry } from './zones.js';

const settings = (over: Partial<SettingsMap> = {}): SettingsMap => ({
  ...SETTING_DEFAULTS,
  ...over,
});

describe('spam scoring (Laravel LeadSpamScorer, D107)', () => {
  it.each([
    [
      'normal',
      {
        parentName: 'Fatima Khan',
        email: 'f@example.com',
        message: 'I want to select a course from your list -- evenings',
      },
      false,
    ],
    ['sql injection', { parentName: 'x', email: 'a@b.co', message: "1' or '1'='1" }, true],
    [
      'union select',
      { parentName: 'Ali', phone: '+2010000000', message: 'union all select password' },
      true,
    ],
    [
      'script tag',
      { parentName: 'Ali', email: 'a@b.co', message: '<script>alert(1)</script>' },
      true,
    ],
    [
      'link',
      { parentName: 'Ali', email: 'a@b.co', message: 'cheap seo https://spam.example' },
      true,
    ],
    ['no way to reach', { parentName: 'Ali', message: 'hello' }, false],
    ['no contact + odd name', { parentName: 'Ali123', message: 'hello' }, true],
  ])('%s', (_name, fields, spam) => {
    expect(scoreSpam(fields).score >= 50).toBe(spam);
  });

  it('adds an IP burst and caps the score at 100', () => {
    expect(scoreSpam({ parentName: 'Ali', email: 'a@b.co' }, 4).flags).toEqual(['ip_burst']);
    expect(scoreSpam({ parentName: 'x1', message: "<a href> ' or 1=1 --" }, 9).score).toBe(100);
  });

  it('normalises phone digits for matching', () => {
    expect(phoneDigits('+44 (0) 7700-900123')).toBe('4407700900123');
    expect(phoneDigits('007700')).toBe('7700');
    expect(phoneDigits('')).toBeNull();
    expect(phoneDigits('1234567890123456789')).toBe('567890123456789');
  });
});

describe('country from the calling code (Laravel CallingCodes)', () => {
  it.each([
    ['+44 7700 900123', 'GB'],
    ['+201001234567', 'EG'],
    ['+971501234567', 'AE'],
    ['+12125551234', 'US'],
    ['+14165551234', 'CA'],
    ['00966500000001', 'SA'],
    ['01001234567', null],
    ['+44', null],
    [null, null],
  ])('%s → %s', (phone, country) => {
    expect(countryOfPhone(phone)).toBe(country);
  });
});

describe('zone of a country', () => {
  it('uses the main zone, then the first listed one, then the fallback', () => {
    expect(zoneForCountry('CA', 'Africa/Cairo')).toBe('America/Toronto');
    expect(zoneForCountry('gb', 'Africa/Cairo')).toBe('Europe/London');
    expect(zoneForCountry('SA', 'Africa/Cairo')).toBe('Asia/Riyadh');
    expect(zoneForCountry('EG', 'UTC')).toBe('Africa/Cairo');
    expect(zoneForCountry(null, 'Africa/Cairo')).toBe('Africa/Cairo');
    expect(zoneForCountry('Egypt', 'Africa/Cairo')).toBe('Africa/Cairo');
  });
});

describe('first-response SLA in working hours (B84)', () => {
  const due = (created: string, s = settings()) =>
    new Date(WorkingHours.firstResponseDue(Date.parse(created), s))
      .toISOString()
      .replace('.000Z', 'Z');

  // Cairo is UTC+2 in November.
  it.each([
    ['inside hours: +30 min', '2026-11-16T09:00:00Z', '2026-11-16T09:30:00Z'],
    ['at night: from 10:00 next day', '2026-11-16T21:30:00Z', '2026-11-17T08:30:00Z'],
    ['before opening', '2026-11-16T05:00:00Z', '2026-11-16T08:30:00Z'],
    ['across closing time', '2026-11-16T19:50:00Z', '2026-11-17T08:20:00Z'],
  ])('%s', (_name, created, expected) => {
    expect(due(created)).toBe(expected);
  });

  it('treats an end not after the start as all day, and reads the settings', () => {
    const s = settings({
      'crm.working_hours_start': '00:00',
      'crm.working_hours_end': '00:00',
      'crm.first_response_minutes': 45,
    });
    expect(due('2026-11-16T23:00:00Z', s)).toBe('2026-11-16T23:45:00Z');
  });

  it('knows whether an instant is inside the hours', () => {
    const wh = WorkingHours.fromSettings(settings());
    expect(wh.contains(Date.parse('2026-11-16T09:00:00Z'))).toBe(true); // 11:00 Cairo
    expect(wh.contains(Date.parse('2026-11-16T21:00:00Z'))).toBe(false); // 23:00 Cairo
  });
});

describe('WPForms mapping', () => {
  it('reads every age in the free text', () => {
    expect(parseAges('8 and 11')).toEqual([8, 11]);
    expect(parseAges('1, 7, 100')).toEqual([7, 10]);
    expect(parseAges(null)).toEqual([]);
  });

  it('builds the children from «Course for», the count and the ages', () => {
    expect(buildChildren('Your Kids', '2', [7, 10], 'Umm Adam', 3)).toEqual([
      { age: 7, courseId: 3 },
      { age: 10, courseId: 3 },
    ]);
    expect(buildChildren('You', null, [35], 'Umm Adam', null)).toEqual([
      { name: 'Umm Adam', age: 35 },
    ]);
    expect(buildChildren('Both', 'two kids (2)', [], 'Abu Omar', null)).toEqual([
      { name: 'Abu Omar' },
      {},
      {},
    ]);
    expect(buildChildren(null, 'many', [], 'X', null)).toEqual([{}]);
  });

  it('keeps utm_* of the page, the page without its query and the referer', () => {
    expect(
      utmOf(
        'https://qarabic.com/free-trial/?utm_source=google&utm_medium=cpc&utm_campaign=kids',
        'https://www.google.com/',
      ),
    ).toEqual({
      source: 'google',
      medium: 'cpc',
      campaign: 'kids',
      page: 'https://qarabic.com/free-trial/',
      referer: 'https://www.google.com/',
    });
    expect(utmOf(null, '')).toBeNull();
  });
});

describe('webhook signature (WordPress snippet contract)', () => {
  const body = Buffer.from('{"form_id":4823,"entry_id":1,"fields":{"name":"A\\/B"}}');
  const now = Date.parse('2026-11-16T09:00:00Z');
  const ts = String(now / 1000);

  it('is sha256= + hex HMAC of "{timestamp}.{raw body}" (same as PHP hash_hmac)', () => {
    expect(signWebLead('secret', '1700000000', 'x')).toBe(
      'sha256=33b144d363922749067b2c1366c8938aa1872f72b4ed8f3d06120e2dff006711',
    );
  });

  it('accepts the right signature inside the window and nothing else', () => {
    const good = signWebLead('s3cret-s3cret-s3', ts, body);
    expect(verifyWebLead('s3cret-s3cret-s3', ts, good, body, now)).toBe(true);
    expect(verifyWebLead('other-secret-xxxx', ts, good, body, now)).toBe(false);
    expect(
      verifyWebLead('s3cret-s3cret-s3', ts, good, Buffer.from(`${body.toString()} `), now),
    ).toBe(false);
    expect(verifyWebLead('s3cret-s3cret-s3', ts, good, body, now + 301_000)).toBe(false);
    expect(verifyWebLead('s3cret-s3cret-s3', ts, good, body, now - 301_000)).toBe(false);
    expect(verifyWebLead('s3cret-s3cret-s3', ts, undefined, body, now)).toBe(false);
    expect(verifyWebLead('s3cret-s3cret-s3', 'abc', good, body, now)).toBe(false);
  });
});
