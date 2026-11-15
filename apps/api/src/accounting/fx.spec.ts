import { describe, expect, it } from 'vitest';
import { monthOfDate, RateBook, UsdTotal } from './fx.js';

const book = new RateBook([
  { currency: 'GBP', month: '2026-10', rateToUsd: '1.25' },
  { currency: 'GBP', month: '2026-11', rateToUsd: '1.30' },
  { currency: 'EGP', month: '2026-11', rateToUsd: '0.0205' },
]);

describe('UsdTotal (D144)', () => {
  it('converts each amount at the rate of its own month, USD at 1', () => {
    const money = new UsdTotal()
      .add('GBP', '2026-10', '100.00')
      .add('GBP', '2026-11', '100.00')
      .add('USD', '2026-11', '50.00')
      .toMoney(book);
    expect(money).toEqual({
      usd: '305.00',
      missingRate: false,
      byCurrency: [
        { currency: 'GBP', amount: '200.00', usd: '255.00', missingMonths: [] },
        { currency: 'USD', amount: '50.00', usd: '50.00', missingMonths: [] },
      ],
    });
  });

  it('a missing rate makes the total null and names the month, never 0', () => {
    const money = new UsdTotal()
      .add('GBP', '2026-09', '10.00')
      .add('GBP', '2026-11', '10.00')
      .add('USD', '2026-11', '5.00')
      .toMoney(book);
    expect(money.usd).toBeNull();
    expect(money.missingRate).toBe(true);
    expect(money.byCurrency).toEqual([
      { currency: 'GBP', amount: '20.00', usd: null, missingMonths: ['2026-09'] },
      { currency: 'USD', amount: '5.00', usd: '5.00', missingMonths: [] },
    ]);
  });

  it('rounds each month to cents and keeps signs (profit = revenue − expenses)', () => {
    const revenue = new UsdTotal().add('EGP', '2026-11', '1000.00');
    const expenses = new UsdTotal().add('EGP', '2026-11', '333.33');
    const profit = new UsdTotal().merge(revenue).merge(expenses, -1).toMoney(book);
    expect(profit.usd).toBe('13.67');
    expect(profit.byCurrency[0]!.amount).toBe('666.67');
  });

  it('an empty total is 0 USD, not missing; a zero part needs no rate', () => {
    expect(new UsdTotal().toMoney(book)).toEqual({
      usd: '0.00',
      missingRate: false,
      byCurrency: [],
    });
    expect(new UsdTotal().add('AED', '2026-11', 0).toMoney(book).missingRate).toBe(false);
  });

  it('lists the rate keys it needs, without USD', () => {
    const t = new UsdTotal().add('USD', '2026-11', 1).add('GBP', '2026-11', 1);
    expect(t.keys()).toEqual([{ currency: 'GBP', month: '2026-11' }]);
  });
});

describe('monthOfDate', () => {
  it('reads the calendar month of a @db.Date value', () => {
    expect(monthOfDate(new Date('2026-11-30T00:00:00Z'))).toBe('2026-11');
  });
});
