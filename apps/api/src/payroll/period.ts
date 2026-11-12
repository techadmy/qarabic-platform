import { addDays, addMonths, localDate, startOfLocalDay } from '../schedule/time.js';

/**
 * A payroll month: a calendar month in the academy zone (D89; Laravel `Support\Payroll\Period`).
 * `YYYY-MM`; string order = time order.
 */
export class Period {
  private constructor(
    readonly year: number,
    readonly month: number,
  ) {}

  static parse(period: string): Period {
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
    if (!m) throw new Error(`Invalid period ${period}`);
    return new Period(Number(m[1]), Number(m[2]));
  }

  /** The period a local date (`YYYY-MM-DD`) belongs to. */
  static ofDate(date: string): Period {
    return Period.parse(date.slice(0, 7));
  }

  /** The current period in the academy zone. */
  static current(nowMs: number, academyZone: string): Period {
    return Period.ofDate(localDate(nowMs, academyZone));
  }

  toString(): string {
    return `${String(this.year).padStart(4, '0')}-${String(this.month).padStart(2, '0')}`;
  }

  startsOn(): string {
    return `${this.toString()}-01`;
  }

  endsOn(): string {
    const last = new Date(Date.UTC(this.year, this.month, 0)).getUTCDate();
    return `${this.toString()}-${String(last).padStart(2, '0')}`;
  }

  /** UTC instant where the month starts in the zone. */
  fromUtc(zone: string): Date {
    return new Date(startOfLocalDay(this.startsOn(), zone));
  }

  /** UTC instant where the next month starts in the zone (exclusive end). */
  toUtc(zone: string): Date {
    return new Date(startOfLocalDay(addMonths(this.startsOn(), 1), zone));
  }

  next(): Period {
    return this.month === 12 ? new Period(this.year + 1, 1) : new Period(this.year, this.month + 1);
  }

  previous(): Period {
    return this.month === 1 ? new Period(this.year - 1, 12) : new Period(this.year, this.month - 1);
  }

  isAfter(other: Period): boolean {
    return this.toString() > other.toString();
  }

  contains(date: string): boolean {
    return date >= this.startsOn() && date <= this.endsOn();
  }
}

/** Every date from `from` to `to` (inclusive), `YYYY-MM-DD`. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
