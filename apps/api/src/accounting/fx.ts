import type { UsdMoney } from '@qarabic/shared';
import { Prisma } from '../generated/prisma/client.js';

/*
| D144 (B124): reporting in USD. Every amount converts at the rate of the month it happened
| (`YYYY-MM` in the academy's zone), from `exchange_rates`. The original currency stays in the
| breakdown; a part with no rate makes the total `null` with `missingRate`, never a silent 0.
*/

const Decimal = Prisma.Decimal;
type Dec = Prisma.Decimal;

export const REPORTING_CURRENCY = 'USD';

/** The rates a report needs, by `CUR:YYYY-MM`. USD is always 1. */
export class RateBook {
  private readonly rates = new Map<string, Dec>();

  constructor(rows: Iterable<{ currency: string; month: string; rateToUsd: Dec | string }>) {
    for (const r of rows) this.rates.set(`${r.currency}:${r.month}`, new Decimal(r.rateToUsd));
  }

  rate(currency: string, month: string): Dec | null {
    if (currency === REPORTING_CURRENCY) return new Decimal(1);
    return this.rates.get(`${currency}:${month}`) ?? null;
  }
}

/**
 * Collects amounts by currency and month, then reports them in USD. Amounts are decimals in the
 * original currency (all billing currencies have 2 decimals).
 */
export class UsdTotal {
  /** currency → month → amount */
  private readonly parts = new Map<string, Map<string, Dec>>();

  add(currency: string, month: string, amount: Dec | string | number): this {
    const byMonth = this.parts.get(currency) ?? new Map<string, Dec>();
    byMonth.set(month, (byMonth.get(month) ?? new Decimal(0)).plus(new Decimal(amount)));
    this.parts.set(currency, byMonth);
    return this;
  }

  /** Adds another total (e.g. revenue − expenses with `sign = -1`). */
  merge(other: UsdTotal, sign: 1 | -1 = 1): this {
    for (const [currency, byMonth] of other.parts)
      for (const [month, amount] of byMonth) this.add(currency, month, amount.times(sign));
    return this;
  }

  /** Every `CUR:YYYY-MM` this total needs a rate for (USD excluded). */
  keys(): Array<{ currency: string; month: string }> {
    const out: Array<{ currency: string; month: string }> = [];
    for (const [currency, byMonth] of this.parts)
      if (currency !== REPORTING_CURRENCY)
        for (const month of byMonth.keys()) out.push({ currency, month });
    return out;
  }

  toMoney(book: RateBook): UsdMoney {
    let usd = new Decimal(0);
    let missingRate = false;
    const byCurrency = [...this.parts.keys()].sort().map((currency) => {
      const byMonth = this.parts.get(currency)!;
      let amount = new Decimal(0);
      let converted = new Decimal(0);
      const missingMonths: string[] = [];
      for (const month of [...byMonth.keys()].sort()) {
        const value = byMonth.get(month)!;
        amount = amount.plus(value);
        if (value.isZero()) continue;
        const rate = book.rate(currency, month);
        if (rate === null) missingMonths.push(month);
        else converted = converted.plus(value.times(rate).toDecimalPlaces(2));
      }
      if (missingMonths.length) missingRate = true;
      else usd = usd.plus(converted);
      return {
        currency,
        amount: amount.toFixed(2),
        usd: missingMonths.length ? null : converted.toFixed(2),
        missingMonths,
      };
    });
    return { usd: missingRate ? null : usd.toFixed(2), missingRate, byCurrency };
  }
}

/** `YYYY-MM` of a `@db.Date` value (stored as UTC midnight of that calendar day). */
export const monthOfDate = (d: Date): string => d.toISOString().slice(0, 7);
