import { fromMinor, toMinor } from '@qarabic/shared';
import { intlLocale, type UiLocale } from '@/lib/time';

/**
 * Money on screen (D83, the current app's `money.ts`): the API sends exact decimal strings
 * (`"60.00"`) + an ISO currency, never floats. Formatting hands the decimal string to Intl as is
 * (Intl.NumberFormat formats numeric strings exactly), so no amount ever passes through a float.
 * Input is parsed to integer minor units and sent back as a decimal string.
 */

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(currency: string, locale: UiLocale): Intl.NumberFormat | null {
  const key = `${locale}:${currency}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  try {
    const f = new Intl.NumberFormat(intlLocale(locale), {
      style: 'currency',
      currency,
      // Every billing currency has 2 decimals (PKR would round to 0 by default).
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    formatters.set(key, f);
    return f;
  } catch {
    return null;
  }
}

export type MoneyChunk = { kind: 'num' | 'cur' | 'lit'; text: string };

const NUMBER_PARTS = new Set(['minusSign', 'plusSign', 'integer', 'group', 'decimal', 'fraction']);
// Intl's own direction marks (LRM, RLM, ALM) are dropped: the chunks are isolated instead.
const MARKS = /[\u200e\u200f\u061c]/g;

/**
 * An amount as display chunks in reading order: the number (always left-to-right digits), the
 * currency symbol and the spaces between, from `Intl.NumberFormat` in the UI locale ("US$60.00" in
 * English, "60.00 US$" in Arabic). Each chunk is isolated when shown, so "US$" or "د.إ." never gets
 * reordered inside right-to-left text (docs/15 §5.13). Null when the amount or currency is bad.
 */
export function moneyChunks(
  amount: string,
  currency: string | null | undefined,
  locale: UiLocale,
): MoneyChunk[] | null {
  let normalized: string;
  try {
    normalized = fromMinor(toMinor(amount));
  } catch {
    return null;
  }
  const f = currency ? formatter(currency, locale) : null;
  if (!f) {
    return [
      { kind: 'num', text: normalized },
      ...(currency
        ? [
            { kind: 'lit' as const, text: ' ' },
            { kind: 'cur' as const, text: currency },
          ]
        : []),
    ];
  }
  const chunks: MoneyChunk[] = [];
  for (const part of f.formatToParts(normalized as Intl.StringNumericLiteral)) {
    const kind = NUMBER_PARTS.has(part.type) ? 'num' : part.type === 'currency' ? 'cur' : 'lit';
    const text = part.value.replace(MARKS, '');
    if (!text) continue;
    const last = chunks[chunks.length - 1];
    if (last && last.kind === kind && kind !== 'cur') last.text += text;
    else chunks.push({ kind, text });
  }
  return chunks;
}

const LRI = '\u2066';
const RLI = '\u2067';
const FSI = '\u2068';
const PDI = '\u2069';

/**
 * `"60.00"` + `"USD"` → "US$60.00" (English) / "60.00 US$" (Arabic) as plain text for sentences
 * and toasts, with Unicode isolates around the number and the symbol so the order holds in either
 * direction. A bad amount comes back as it was.
 */
export function formatMoney(
  amount: string,
  currency: string | null | undefined,
  locale: UiLocale,
): string {
  const chunks = moneyChunks(amount, currency, locale);
  if (!chunks) return amount;
  const body = chunks
    .map((c) =>
      c.kind === 'num'
        ? `${LRI}${c.text}${PDI}`
        : c.kind === 'cur'
          ? `${FSI}${c.text}${PDI}`
          : c.text,
    )
    .join('');
  return `${locale === 'ar' ? RLI : LRI}${body}${PDI}`;
}

/** Same as {@link formatMoney} from integer minor units (`6050` → "60.50"). */
export function formatMinor(minor: number, currency: string | null | undefined, locale: UiLocale) {
  return formatMoney(fromMinor(minor), currency, locale);
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';

/**
 * What a person typed → integer minor units, or null when it is not a valid amount: at most 2
 * decimals, Arabic-Indic digits and the Arabic decimal mark accepted, thousands commas ignored.
 * Zero is never an amount; a minus sign only with `allowNegative` (adjustments).
 */
export function parseAmount(
  input: string,
  { allowNegative = false }: { allowNegative?: boolean } = {},
): number | null {
  const normalized = input
    .trim()
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(EXTENDED_ARABIC_INDIC.indexOf(d)))
    .replace('٫', '.')
    .replace(/[,٬\s]/g, '')
    .replace(/^−/, '-');
  const m = /^(-?)(\d{1,9})(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!m) return null;
  if (m[1] && !allowNegative) return null;
  const minor = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  if (minor === 0) return null;
  return m[1] ? -minor : minor;
}

/** Minor units → the decimal string the API takes (`6050` → `"60.50"`). */
export const toAmount = (minor: number) => fromMinor(minor);

/** An API amount as integer minor units (`"60.50"` → 6050); 0 for anything unreadable. */
export function minorOf(amount: string | null | undefined): number {
  if (!amount) return 0;
  try {
    return toMinor(amount);
  } catch {
    return 0;
  }
}

/** For editing an amount in an input: `"60.50"` → "60.50", null → "". */
export function amountInput(amount: string | null | undefined): string {
  if (amount === null || amount === undefined) return '';
  try {
    return fromMinor(toMinor(amount));
  } catch {
    return '';
  }
}

/** Splits `totalMinor` into `parts` near-equal parts; the remainder goes to the first ones. */
export function evenParts(totalMinor: number, parts: number): number[] {
  if (parts <= 0) return [];
  const base = Math.floor(totalMinor / parts);
  const rest = totalMinor - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rest ? 1 : 0));
}
