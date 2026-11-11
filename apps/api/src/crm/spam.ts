/**
 * Content rules that park junk public-form submissions in the spam tab (docs/26 §5.2, D107).
 * Port of Laravel `LeadSpamScorer`: pure, no database access. Score ≥ the threshold (50) = spam.
 */
const SQL =
  /(\bunion\b.{0,20}\bselect\b|'\s*or\s*'?\d|\bor\s+1\s*=\s*1\b|\bsleep\s*\(\s*\d|\bbenchmark\s*\(|\bdrop\s+table\b|;\s*--|\/\*.*\*\/|\bxp_cmdshell\b|\binformation_schema\b|\bwaitfor\s+delay\b)/i;
const HTML =
  /<\s*\/?\s*(script|a|iframe|img|svg|style|object|embed|form|body)\b|javascript:|\bon[a-z]+\s*=\s*["']/i;
const URL_RE = /(https?:\/\/|www\.)\S+/i;
/** PHP `FILTER_VALIDATE_EMAIL`, close enough for scoring. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const SPAM_THRESHOLD = 50;
/** More submissions than this from one IP within an hour add to the score. */
export const IP_BURST_PER_HOUR = 3;

export interface SpamFields {
  parentName?: string | null;
  email?: string | null;
  phone?: string | null;
  message?: string | null;
  courseInterest?: string | null;
  preferredTimes?: string | null;
  city?: string | null;
  children?: unknown;
}

export function scoreSpam(
  fields: SpamFields,
  recentFromSameIp = 0,
): { score: number; flags: string[] } {
  const flags: Record<string, number> = {};
  const text = Object.values(fields)
    .filter((v) => v !== undefined && v !== null)
    .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
    .join('\n');

  if (URL_RE.test(text) || HTML.test(text)) flags.link_or_html = 50;
  if (SQL.test(text)) flags.sql = 60;
  const name = fields.parentName ?? '';
  if (/\d/.test(name) || [...name].length > 80) flags.odd_name = 30;
  const email = fields.email ?? null;
  if (email && !EMAIL.test(email)) flags.bad_email = 20;
  const digits = phoneDigits(fields.phone);
  if (!email && (digits === null || digits.length < 7)) flags.no_contact = 40;
  if (recentFromSameIp > IP_BURST_PER_HOUR) flags.ip_burst = 30;

  const score = Math.min(
    100,
    Object.values(flags).reduce((a, b) => a + b, 0),
  );
  return { score, flags: Object.keys(flags) };
}

/** Digits of a phone for matching: leading zeros dropped, the last 15 kept (Laravel `digits()`). */
export function phoneDigits(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D+/g, '').replace(/^0+/, '');
  return digits === '' ? null : digits.slice(-15);
}
