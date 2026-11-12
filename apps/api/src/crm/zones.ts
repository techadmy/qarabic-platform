import { isValidZone } from '../schedule/time.js';

/** Most-populated zone of countries with several (the first listed zone is often a small one). */
const MAIN_ZONE: Record<string, string> = {
  US: 'America/New_York',
  CA: 'America/Toronto',
  AU: 'Australia/Sydney',
  BR: 'America/Sao_Paulo',
  MX: 'America/Mexico_City',
  RU: 'Europe/Moscow',
  ID: 'Asia/Jakarta',
  KZ: 'Asia/Almaty',
  ES: 'Europe/Madrid',
  PT: 'Europe/Lisbon',
  NZ: 'Pacific/Auckland',
  DE: 'Europe/Berlin',
  MY: 'Asia/Kuala_Lumpur',
  UA: 'Europe/Kyiv',
  CN: 'Asia/Shanghai',
  AR: 'America/Argentina/Buenos_Aires',
};

type LocaleWithZones = Intl.Locale & { getTimeZones?: () => string[]; timeZones?: string[] };

/**
 * The country's main IANA zone, else `fallback` (the academy zone; the CSR can change it).
 * Port of Laravel `LeadService::zoneForCountry` (PHP lists a country's zones alphabetically, as
 * `Intl.Locale#getTimeZones` does).
 */
export function zoneForCountry(countryCode: string | null | undefined, fallback: string): string {
  const cc = countryCode?.trim().toUpperCase();
  if (!cc || !/^[A-Z]{2}$/.test(cc)) return fallback;
  const main = MAIN_ZONE[cc];
  if (main) return main;
  try {
    const locale = new Intl.Locale(`und-${cc}`) as LocaleWithZones;
    const zones = locale.getTimeZones?.() ?? locale.timeZones ?? [];
    const first = zones.find((z) => isValidZone(z));
    if (first) return first;
  } catch {
    // unknown region
  }
  return fallback;
}
