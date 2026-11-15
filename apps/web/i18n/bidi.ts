/**
 * Bidi isolation for interpolated values (docs/39 P1-10). A Latin name inside an Arabic sentence
 * (or an Arabic name inside an English one) must not reorder the words around it. The messages
 * wrap such placeholders in FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE, written as JSON
 * escapes («\u2068{name}\u2069») so reviews can see them. Unlike `<bdi>`, this works in every
 * context a message ends up in: page text, aria-label, toasts and the document title.
 */
export const FSI = '\u2068';
export const PDI = '\u2069';

/**
 * Placeholders that carry people's or records' own text: names, titles, numbers, codes, amounts,
 * search terms, free-text reasons. Dates, times, cities and counts are formatted by Intl in the UI
 * language and need no isolation.
 */
export const ISOLATED_PLACEHOLDERS = [
  'name',
  'by',
  'title',
  'student',
  'teacher',
  'course',
  'number',
  'id',
  'code',
  'key',
  'label',
  'value',
  'amount',
  'balance',
  'paid',
  'sum',
  'q',
  'query',
  'reason',
] as const;

/**
 * Messages that must NOT carry isolates, by key prefix: text that leaves the app (WhatsApp/wa.me
 * prefill, mailto subject/body, CSV/export headers, clipboard text) — invisible marks would leak
 * into other apps and break searches and copy-paste. None exist today; add their keys here.
 * Placeholders inside a URL in the message, and ICU plural/select arguments, are skipped by rule.
 */
export const NOT_ISOLATED_KEYS: readonly string[] = [];

/** Text without the isolate marks (for tests that match a whole sentence). */
export function stripIsolates(text: string): string {
  return text.replace(/[\u2066-\u2069]/g, '');
}
