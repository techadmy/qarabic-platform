import { z } from 'zod';

/**
 * Countries and time zones are static reference data, not tables (N1 decision):
 * - Countries: ISO 3166-1 alpha-2 codes. Families and teachers store the code; names come from
 *   `Intl.DisplayNames` in Arabic or English, so web and API show the same names with no table to
 *   seed or translate. (Laravel kept a `country` table whose ids the old system used; the N8 data
 *   move maps those ids to codes through its `isoCode` column.)
 * - Time zones: IANA names (`Europe/London`), stored as text and validated by the runtime's
 *   time zone database, like Laravel's `timezone:all` rule.
 */
// prettier-ignore
export const COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'XK', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const;
export type CountryCode = (typeof COUNTRY_CODES)[number];

const countrySet = new Set<string>(COUNTRY_CODES);

export function isCountryCode(value: string): value is CountryCode {
  return countrySet.has(value);
}

/** The country's name in Arabic or English (falls back to the code). */
export function countryName(code: string, locale: 'ar' | 'en'): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** `eg` → `EG`; anything else than a known ISO code is refused. */
export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isCountryCode, { message: 'Unknown country code.' });

export function isTimeZone(value: string): boolean {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z
  .string()
  .trim()
  .refine(isTimeZone, { message: 'Unknown time zone.' });

export const countrySchema = z.object({ code: z.string(), nameAr: z.string(), nameEn: z.string() });
export type CountryDto = z.infer<typeof countrySchema>;

/** Every country with both names, sorted by English name (the API's lookups use this). */
export function countryList(): CountryDto[] {
  return COUNTRY_CODES.map((code) => ({
    code,
    nameAr: countryName(code, 'ar'),
    nameEn: countryName(code, 'en'),
  })).sort((a, b) => a.nameEn.localeCompare(b.nameEn));
}
