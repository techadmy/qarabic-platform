/**
 * Integer money maths for payroll (D90; Laravel `App\Support\Payroll\Money`). Amounts are minor
 * units (cents) in a `number` (numeric(12,2) fits well inside 2^53); hours are hundredths. No
 * floating-point arithmetic touches money: decimals are parsed from their string form.
 */

type DecimalLike = { toFixed(dp: number): string } | string | number | null | undefined;

/** "12.5" / 12.5 / Prisma.Decimal → 1250. Exact for at most 2 decimals. */
export function cents(value: DecimalLike): number {
  if (value === null || value === undefined || value === '') return 0;
  const s = typeof value === 'string' ? value : value.toFixed(2);
  const negative = s.trim().startsWith('-');
  const [whole = '0', frac = ''] = s.trim().replace(/^-/, '').split('.');
  const out = Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
  return negative ? -out : out;
}

/** 1250 → "12.50" (negative keeps its sign). */
export function fromCents(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Hours as hundredths ("0.50" → 50). Same parser as {@link cents}. */
export const centi = cents;

/** Hundredths back to a 2-decimal string. */
export const hours = fromCents;

/** round(numerator / denominator) half away from zero, exactly (BigInt). */
export function divRound(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  const n = BigInt(Math.abs(numerator));
  const d = BigInt(denominator);
  const q = (2n * n + d) / (2n * d);
  return (numerator < 0 ? -1 : 1) * Number(q);
}
