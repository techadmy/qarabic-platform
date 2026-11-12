import { describe, expect, it } from 'vitest';
import { checkoutTarget, readCheckoutReturn } from './checkout';
import {
  validateFamilyBilling,
  validateLine,
  validateManualInvoice,
  validatePackage,
  validatePayment,
  validateSplit,
} from './forms';
import {
  lineLabel,
  monthLabel,
  nextMonth,
  parseDayList,
  periodLabel,
  periodMonth,
  prorationOf,
  runDueDate,
  warningLabel,
  warningStudent,
} from './labels';
import {
  amountInput,
  evenParts,
  formatMinor,
  formatMoney,
  minorOf,
  moneyChunks,
  parseAmount,
} from './money';

/** Strips the bidi marks Intl adds around Arabic currency text, so the digits can be compared. */
const plain = (s: string) =>
  s
    .replace(/[\u2066-\u2069\u200e\u200f\u061c]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('money', () => {
  it('formats the API decimal string per currency and locale, always with 2 decimals', () => {
    expect(plain(formatMoney('60.00', 'USD', 'en'))).toBe('US$60.00');
    expect(plain(formatMoney('1234.5', 'GBP', 'en'))).toBe('£1,234.50');
    expect(plain(formatMoney('60.00', 'USD', 'ar'))).toBe('60.00 US$');
    expect(plain(formatMoney('150', 'EGP', 'ar'))).toMatch(/^150\.00 ج\.م\.?$/);
    // PKR would round to whole rupees by default; billing keeps the paisa.
    expect(plain(formatMoney('9000.50', 'PKR', 'en'))).toBe('PKR 9,000.50');
    expect(plain(formatMoney('-5.00', 'USD', 'en'))).toBe('-US$5.00');
  });

  it('never loses a cent on large amounts (no float on the way)', () => {
    expect(plain(formatMoney('9999999999999.99', 'USD', 'en'))).toBe('US$9,999,999,999,999.99');
    expect(plain(formatMinor(1, 'USD', 'en'))).toBe('US$0.01');
  });

  it('shows a bad amount as it came and an unknown currency as a plain code', () => {
    expect(formatMoney('abc', 'USD', 'en')).toBe('abc');
    expect(plain(formatMoney('12.5', 'XX', 'en'))).toBe('12.50 XX');
    expect(plain(formatMoney('12.5', null, 'en'))).toBe('12.50');
  });

  it('keeps the number and the symbol as isolated chunks, without Intl direction marks', () => {
    expect(moneyChunks('-404', 'USD', 'ar')).toEqual([
      { kind: 'num', text: '-404.00' },
      { kind: 'lit', text: '\u00a0' },
      { kind: 'cur', text: 'US$' },
    ]);
    expect(moneyChunks('-404', 'USD', 'en')).toEqual([
      { kind: 'num', text: '-' },
      { kind: 'cur', text: 'US$' },
      { kind: 'num', text: '404.00' },
    ]);
    expect(moneyChunks('210', 'AED', 'ar')?.map((c) => c.text)).toEqual([
      '210.00',
      '\u00a0',
      'د.إ.',
    ]);
    expect(formatMoney('60', 'USD', 'ar')).toBe(
      '\u2067\u206660.00\u2069\u00a0\u2068US$\u2069\u2069',
    );
  });

  it('parses what people type into minor units, Arabic digits included', () => {
    expect(parseAmount('60')).toBe(6000);
    expect(parseAmount('60.5')).toBe(6050);
    expect(parseAmount(' 1,234.56 ')).toBe(123456);
    expect(parseAmount('٦٠٫٥٠')).toBe(6050);
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('1.234')).toBeNull();
    expect(parseAmount('-5')).toBeNull();
    expect(parseAmount('-5', { allowNegative: true })).toBe(-500);
    expect(parseAmount('−5', { allowNegative: true })).toBe(-500);
    expect(parseAmount('ten')).toBeNull();
  });

  it('reads API amounts and splits totals without losing a cent', () => {
    expect(minorOf('60.50')).toBe(6050);
    expect(minorOf(null)).toBe(0);
    expect(minorOf('x')).toBe(0);
    expect(amountInput('60.5')).toBe('60.50');
    expect(amountInput(null)).toBe('');
    expect(evenParts(10001, 3)).toEqual([3334, 3334, 3333]);
    expect(evenParts(14500, 2).reduce((a, b) => a + b)).toBe(14500);
  });
});

describe('labels', () => {
  it('names the period, the month and the custom-fee line in the UI language', () => {
    expect(periodLabel({ periodStart: '2026-11-01', periodEnd: '2026-11-30' }, 'en')).toBe(
      '1 November 2026 – 30 November 2026',
    );
    expect(periodLabel({ periodStart: null, periodEnd: null }, 'en')).toBeNull();
    expect(periodMonth('2026-12-15', 'ar')).toBe('ديسمبر 2026');
    expect(monthLabel('2027-01', 'en')).toBe('January 2027');
    expect(
      lineLabel({ description: 'Monthly fee', meta: { source: 'custom_fee' } }, 'الرسوم الشهرية'),
    ).toBe('الرسوم الشهرية');
    expect(lineLabel({ description: 'Ali — باقة يومين', meta: null }, 'x')).toBe(
      'Ali — باقة يومين',
    );
  });

  it('reads proration and warnings', () => {
    expect(prorationOf({ prorated: true, days: 21, periodDays: 31 })).toEqual({
      days: 21,
      periodDays: 31,
    });
    expect(prorationOf({ source: 'package' })).toBeNull();
    expect(warningLabel('missing_price:12', 'ar')).toBe('باقة بلا سعر بعملة الأسرة');
    expect(warningLabel('something_new', 'en')).toBe('something_new');
    expect(warningStudent('no_package:7')).toBe(7);
    expect(warningStudent('no_fee')).toBeNull();
  });

  it('computes the next month, the default due date and the reminder days', () => {
    expect(nextMonth('2026-11-12')).toBe('2026-12');
    expect(nextMonth('2026-12-31')).toBe('2027-01');
    expect(runDueDate('2026-12', '2026-11-12')).toBe('2026-12-07');
    expect(runDueDate('2026-11', '2026-11-12')).toBe('2026-11-19');
    expect(parseDayList('-3, 0, 3, 7')).toEqual([-3, 0, 3, 7]);
    expect(parseDayList('7 ٣ 3 −3')).toEqual([-3, 3, 7]);
    expect(parseDayList('')).toEqual([]);
    expect(parseDayList('a, 3')).toBeNull();
  });
});

describe('form rules', () => {
  const today = '2026-11-12';

  it('a manual payment: amount ≤ balance, date not in the future, decimal string out', () => {
    const base = { method: 'cash' as const, reference: ' ', note: '' };
    expect(
      validatePayment({ ...base, amount: '50', receivedOn: today }, { balanceMinor: 14500, today })
        .body,
    ).toEqual({ method: 'cash', amount: '50.00', receivedOn: today, reference: null, note: null });
    const over = validatePayment(
      { ...base, amount: '145.01', receivedOn: today },
      { balanceMinor: 14500, today },
    );
    expect(over.errors.amount).toBe('overBalance');
    expect(over.overBalance).toBe(true);
    expect(
      validatePayment(
        { ...base, amount: '10', receivedOn: '2026-11-13' },
        { balanceMinor: 14500, today },
      ).errors,
    ).toEqual({ receivedOn: 'dateNotFuture' });
    expect(
      validatePayment({ ...base, amount: '', receivedOn: today }, { balanceMinor: 1, today }).errors
        .amount,
    ).toBe('amountInvalid');
  });

  it('an adjustment is signed; a discount is an amount or a percent; both need a reason', () => {
    expect(
      validateLine('adjustment', { mode: 'amount', sign: 'subtract', value: '10', reason: 'حصة' })
        .body,
    ).toEqual({ type: 'adjustment', amount: '-10.00', reason: 'حصة' });
    expect(
      validateLine('discount', { mode: 'percent', sign: 'add', value: '12.5', reason: 'إخوة' })
        .body,
    ).toEqual({ type: 'discount', percent: '12.50', reason: 'إخوة' });
    expect(
      validateLine('discount', { mode: 'percent', sign: 'add', value: '101', reason: 'xx' }).errors,
    ).toEqual({ value: 'percentInvalid', reason: 'reasonRequired' });
  });

  it('a split adds up to the total exactly, 2–6 parts, each due from today', () => {
    const ok = validateSplit(
      [
        { amount: '72.50', dueDate: today },
        { amount: '72.50', dueDate: '2026-12-12' },
      ],
      'طلب ولي الأمر',
      { totalMinor: 14500, today },
    );
    expect(ok.body?.parts).toEqual([
      { amount: '72.50', dueDate: today },
      { amount: '72.50', dueDate: '2026-12-12' },
    ]);
    const off = validateSplit(
      [
        { amount: '70', dueDate: today },
        { amount: '70', dueDate: today },
      ],
      'طلب ولي الأمر',
      { totalMinor: 14500, today },
    );
    expect(off.errors.parts).toBe('splitSum');
    expect(off.sumMinor).toBe(14000);
    const past = validateSplit(
      [
        { amount: '145', dueDate: '2026-11-01' },
        { amount: '', dueDate: today },
      ],
      '',
      { totalMinor: 14500, today },
    );
    expect(past.partErrors).toEqual([{ dueDate: 'dateFromToday' }, { amount: 'amountInvalid' }]);
    expect(past.errors).toEqual({ parts: 'splitParts', reason: 'reasonRequired' });
  });

  it('a manual invoice, a package and a family billing profile', () => {
    expect(
      validateManualInvoice(
        4,
        { description: ' كتاب ', amount: '25', dueDate: today },
        { today, issue: false },
      ).body,
    ).toEqual({
      familyId: 4,
      dueDate: today,
      issue: false,
      lines: [{ description: 'كتاب', amount: '25.00' }],
    });
    const pkg = validatePackage({
      name: 'باقة',
      classesPerWeek: '15',
      sessionMinutes: 30,
      description: '',
      isActive: true,
      prices: [
        { currency: 'USD', amount: '60' },
        { currency: 'USD', amount: '50' },
      ],
    });
    expect(pkg.errors).toEqual({ classesPerWeek: 'perWeekInvalid', prices: 'duplicateCurrency' });
    expect(
      validateFamilyBilling({
        currency: 'GBP',
        billingDay: 15,
        enabled: true,
        customFee: '0',
        startsOn: '',
        students: [{ id: 3, feePackageId: null }],
      }).body,
    ).toEqual({
      billingCurrency: 'GBP',
      billingDay: 15,
      billingEnabled: true,
      customFee: '0.00',
      billingStartsOn: null,
      students: [{ id: 3, feePackageId: null }],
    });
    expect(
      validateFamilyBilling({
        currency: '',
        billingDay: 1,
        enabled: true,
        customFee: 'x',
        startsOn: '',
        students: [],
      }).errors,
    ).toEqual({ currency: 'required', customFee: 'amountInvalid' });
  });
});

describe('checkout return', () => {
  it('reads the API return address and only trusts a well-formed PayPal order id', () => {
    const q = (s: string) => readCheckoutReturn(new URLSearchParams(s));
    expect(q('checkout=return&provider=stripe')).toEqual({
      kind: 'return',
      provider: 'stripe',
      paypalOrder: null,
    });
    expect(q('checkout=success').kind).toBe('return');
    expect(q('checkout=cancel').kind).toBe('cancelled');
    expect(q('checkout=cancelled').kind).toBe('cancelled');
    expect(q('').kind).toBe('none');
    expect(q('checkout=return&provider=paypal&token=5O190127TN364715T').paypalOrder).toBe(
      '5O190127TN364715T',
    );
    expect(q('checkout=return&provider=paypal&token=<script>').paypalOrder).toBeNull();
    expect(q('checkout=cancelled&provider=paypal&token=ABC').paypalOrder).toBeNull();
  });

  it('sends the browser to an https provider page or, in mock mode, inside the app only', () => {
    const origin = 'http://localhost:3230';
    expect(checkoutTarget('https://checkout.stripe.com/c/pay/cs_test_1', origin)).toEqual({
      kind: 'external',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });
    expect(checkoutTarget('/invoices/1?checkout=return', origin)).toEqual({
      kind: 'internal',
      path: '/invoices/1?checkout=return',
    });
    expect(checkoutTarget('http://evil.example/pay', origin)).toEqual({ kind: 'invalid' });
    expect(checkoutTarget('javascript:alert(1)', origin)).toEqual({ kind: 'invalid' });
  });
});
