import {
  BILLING_WARNING_LABELS,
  BILLING_WARNINGS,
  warningCode,
  type BillingWarning,
  type InvoiceLineDto,
} from '@qarabic/shared';
import { addDays } from '@/lib/schedule-time';
import { formatDate, intlLocale, type UiLocale } from '@/lib/time';

/** "1 نوفمبر 2026 – 30 نوفمبر 2026", or null for an invoice without a period. */
export function periodLabel(
  inv: { periodStart: string | null; periodEnd: string | null },
  locale: UiLocale,
): string | null {
  if (!inv.periodStart || !inv.periodEnd) return null;
  return `${formatDate(inv.periodStart, locale)} – ${formatDate(inv.periodEnd, locale)}`;
}

/** `2026-11-01` → "نوفمبر 2026" (the month an invoice is for); null without a period. */
export function periodMonth(periodStart: string | null, locale: UiLocale): string | null {
  if (!periodStart) return null;
  const [y, m] = periodStart.split('-').map(Number);
  if (!y || !m) return null;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** `YYYY-MM` → the month name ("ديسمبر 2026"). */
export const monthLabel = (period: string, locale: UiLocale) =>
  periodMonth(`${period}-01`, locale) ?? period;

/**
 * An invoice line in the interface language: the family's fixed monthly fee is stored as
 * "Monthly fee" on the server, so it is named from its source instead (old `lineLabel`).
 */
export function lineLabel(
  line: Pick<InvoiceLineDto, 'description' | 'meta'>,
  monthlyFee: string,
): string {
  return line.meta?.source === 'custom_fee' ? monthlyFee : line.description;
}

/** Proration of a line (`meta.prorated`): days billed of the period, else null. */
export function prorationOf(
  meta: Record<string, unknown> | null,
): { days: number; periodDays: number } | null {
  if (!meta?.prorated) return null;
  const days = Number(meta.days);
  const periodDays = Number(meta.periodDays);
  return Number.isFinite(days) && Number.isFinite(periodDays) ? { days, periodDays } : null;
}

/** `missing_price:12` → «باقة بلا سعر بعملة الأسرة»; unknown codes are shown as they are. */
export function warningLabel(warning: string, locale: UiLocale): string {
  const code = warningCode(warning);
  return (BILLING_WARNINGS as readonly string[]).includes(code)
    ? BILLING_WARNING_LABELS[code as BillingWarning][locale]
    : warning;
}

/** The student id a warning names (`no_package:12` → 12). */
export function warningStudent(warning: string): number | null {
  const id = Number(warning.split(':')[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** `2026-11-12` → `2026-12` (the next invoice month). */
export function nextMonth(dateKey: string): string {
  const [y, m] = dateKey.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Reminder days as typed ("-3, 0, 3, 7") → sorted unique whole numbers, or null when invalid. */
export function parseDayList(input: string): number[] | null {
  const parts = input
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .split(/[,،\s]+/)
    .map((p) => p.trim().replace(/^−/, '-'))
    .filter(Boolean);
  if (parts.some((p) => !/^[-+]?\d{1,2}$/.test(p))) return null;
  return [...new Set(parts.map(Number))].sort((a, b) => a - b);
}

/** The academy's zone (`academy.timezone`): "today" for due dates and dates received (D88). */
export const ACADEMY_TZ = 'Africa/Cairo';

/** Default due date of a monthly run: the 7th of the month, or a week from today when that passed. */
export function runDueDate(period: string, today: string): string {
  const seventh = `${period}-07`;
  return seventh < today ? addDays(today, 7) : seventh;
}
