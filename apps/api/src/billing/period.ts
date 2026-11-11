import { addDays, addMonths, dateMs, DAY } from '../schedule/time.js';

/** A monthly billing period starting on the family's billing day (1st or 15th). */
export class BillingPeriod {
  private constructor(
    readonly start: string,
    readonly end: string,
  ) {}

  /** `"2026-12"` + day 15 → 2026-12-15 … 2027-01-14. */
  static of(month: string, day: 1 | 15 = 1): BillingPeriod {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || (day !== 1 && day !== 15)) {
      throw new RangeError('Bad billing period');
    }
    const start = `${month}-${String(day).padStart(2, '0')}`;
    return new BillingPeriod(start, addDays(addMonths(start, 1), -1));
  }

  days(): number {
    return Math.round((dateMs(this.end) - dateMs(this.start)) / DAY) + 1;
  }

  contains(date: string): boolean {
    return date >= this.start && date <= this.end;
  }

  /** One monthly invoice per family and period (unique `period_key`). */
  key(familyId: number): string {
    return `family:${familyId}:${this.start}`;
  }
}
