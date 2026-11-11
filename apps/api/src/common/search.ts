/**
 * Instant search helpers (docs/15 §5.4.1). Prisma's `contains` does not escape LIKE wildcards,
 * so `%` and `_` typed by a user are escaped here and match literally.
 */
export function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Case-insensitive "contains" filter for a text column. */
export function contains(value: string): { contains: string; mode: 'insensitive' } {
  return { contains: likeEscape(value), mode: 'insensitive' };
}

/** The digits of a search, when there are enough of them to look for a phone number (3+). */
export function phoneDigits(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 3 ? digits : null;
}

/** The search as a record id, when it is one (all digits, int4). */
export function searchId(value: string): number | null {
  if (!/^\d{1,10}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 && id <= 2_147_483_647 ? id : null;
}

/** `YYYY-MM-DD` of a `@db.Date` column. */
export function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/** `YYYY-MM-DD` → the Date Prisma stores in a `@db.Date` column. */
export function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}
