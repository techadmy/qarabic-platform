/**
 * Time-zone helpers (D30, docs/15 §5.12): the viewer's zone first, the other party's local time
 * labelled with its city. Display only, through Intl, so Arabic gets ص/م and Latin digits.
 */

export type UiLocale = 'ar' | 'en';

/** Intl locale for display: Arabic with Latin digits (D25), English as is. */
export function intlLocale(locale: UiLocale): string {
  return locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Arabic city names for the zones our families and teachers live in; others fall back to English. */
const CITY_AR: Record<string, string> = {
  'Africa/Cairo': 'القاهرة',
  'Europe/London': 'لندن',
  'Europe/Berlin': 'برلين',
  'Europe/Paris': 'باريس',
  'Europe/Amsterdam': 'أمستردام',
  'Europe/Brussels': 'بروكسل',
  'Europe/Stockholm': 'ستوكهولم',
  'Europe/Dublin': 'دبلن',
  'Europe/Istanbul': 'إسطنبول',
  'America/New_York': 'نيويورك',
  'America/Chicago': 'شيكاغو',
  'America/Denver': 'دنفر',
  'America/Los_Angeles': 'لوس أنجلوس',
  'America/Toronto': 'تورونتو',
  'America/Vancouver': 'فانكوفر',
  'Australia/Sydney': 'سيدني',
  'Australia/Melbourne': 'ملبورن',
  'Australia/Perth': 'بيرث',
  'Asia/Dubai': 'دبي',
  'Asia/Riyadh': 'الرياض',
  'Asia/Qatar': 'الدوحة',
  'Asia/Kuwait': 'الكويت',
  'Asia/Karachi': 'كراتشي',
  'Asia/Kolkata': 'دلهي',
  'Asia/Kuala_Lumpur': 'كوالالمبور',
  'Asia/Singapore': 'سنغافورة',
  'Asia/Jakarta': 'جاكرتا',
  'Africa/Lagos': 'لاغوس',
  'Africa/Johannesburg': 'جوهانسبرغ',
  'Pacific/Auckland': 'أوكلاند',
  UTC: 'UTC',
};

/** "Europe/London" → "لندن" / "London". */
export function cityOf(tz: string | null | undefined, locale: UiLocale): string {
  if (!tz) return '—';
  if (locale === 'ar' && CITY_AR[tz]) return CITY_AR[tz];
  return (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}

/** "GMT+2", "GMT-4:30", "GMT" for the zone at `at`. */
export function utcOffsetLabel(tz: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName');
    return (part?.value ?? 'GMT').replace(/^GMT[+-]0(?::00)?$/, 'GMT');
  } catch {
    return 'GMT';
  }
}

function offsetMinutes(tz: string, at: Date): number {
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(utcOffsetLabel(tz, at));
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

export interface ZoneOption {
  id: string;
  city: string;
  offset: string;
  minutes: number;
}

const COMMON_ZONES = Object.keys(CITY_AR);

function allZoneIds(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    const ids = intl.supportedValuesOf?.('timeZone');
    if (ids?.length) return ids.includes('UTC') ? ids : ['UTC', ...ids];
  } catch {
    /* fall through */
  }
  return COMMON_ZONES;
}

/** Every IANA zone, sorted by current UTC offset then city, labelled in the UI language. */
export function timeZoneOptions(locale: UiLocale, at: Date = new Date()): ZoneOption[] {
  return allZoneIds()
    .map((id) => ({
      id,
      city: cityOf(id, locale),
      offset: utcOffsetLabel(id, at),
      minutes: offsetMinutes(id, at),
    }))
    .sort((a, b) => a.minutes - b.minutes || a.city.localeCompare(b.city));
}

/** Text the zone picker searches: Arabic and English city, IANA id and offset. */
export function zoneSearchText(option: ZoneOption): string {
  return [option.city, cityOf(option.id, 'en'), option.id.replace(/_/g, ' '), option.offset].join(
    ' ',
  );
}

/** "القاهرة (GMT+2)", the offset isolated left-to-right inside Arabic text. */
export function zoneLabel(tz: string, locale: UiLocale): string {
  return `${cityOf(tz, locale)} (⁦${utcOffsetLabel(tz)}⁩)`;
}

/** Now (or `at`) as "5:10 م" in `tz`. */
export function formatTime(tz: string, locale: UiLocale, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: tz,
    }).format(at);
  } catch {
    return '—';
  }
}

/** `YYYY-MM-DD` → "9 نوفمبر 2026" (month names, D32). Date-only: no zone shift. */
export function formatDate(value: string | null | undefined, locale: UiLocale): string | null {
  if (!value) return null;
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return value;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** ISO instant → "9 نوفمبر 2026، 5:10 م" in the viewer's zone. */
export function formatInstant(
  value: string | null | undefined,
  tz: string,
  locale: UiLocale,
): string | null {
  if (!value) return null;
  try {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: tz,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

/** Calendar-day difference of "now" between two zones (+1 when the other party is a day ahead). */
export function dayShift(viewerTz: string, otherTz: string, at: Date = new Date()): number {
  const key = (tz: string) => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at);
    } catch {
      return '';
    }
  };
  const a = key(viewerTz);
  const b = key(otherTz);
  if (!a || !b || a === b) return 0;
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
