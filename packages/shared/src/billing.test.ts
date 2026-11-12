import { describe, expect, it } from 'vitest';
import {
  addInvoiceLineSchema,
  amountSchema,
  BILLING_ERROR_MESSAGES,
  BILLING_WARNING_LABELS,
  BILLING_WARNINGS,
  createFeePackageSchema,
  CURRENCIES,
  CURRENCY_LABELS,
  fromMinor,
  INVOICE_KIND_LABELS,
  INVOICE_KINDS,
  INVOICE_LINE_TYPE_LABELS,
  INVOICE_LINE_TYPES,
  INVOICE_STATUS_LABELS,
  INVOICE_STATUSES,
  invoiceRunSchema,
  manualPaymentSchema,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUSES,
  percentOf,
  prorate,
  signedAmountSchema,
  toMinor,
  updateFamilyBillingSchema,
  warningCode,
} from './index.js';

describe('money (integer minor units, D83)', () => {
  it('formats, parses and prorates without floats (Laravel MoneyAndPackagesTest)', () => {
    expect(fromMinor(6000)).toBe('60.00');
    expect(fromMinor(-5)).toBe('-0.05');
    expect(fromMinor(0)).toBe('0.00');
    expect(toMinor('60.00')).toBe(6000);
    expect(toMinor('0.1')).toBe(10);
    expect(toMinor('12')).toBe(1200);
    expect(toMinor('-0.05')).toBe(-5);
    expect(toMinor('-0')).toBe(0);
    // half up: 6000 × 16 / 31 = 3096.77… → 3097
    expect(prorate(6000, 16, 31)).toBe(3097);
    expect(prorate(6000, 31, 31)).toBe(6000);
    expect(prorate(6000, 0, 31)).toBe(0);
    expect(prorate(1, 1, 2)).toBe(1);
    expect(() => toMinor('1,00')).toThrow(RangeError);
    expect(() => toMinor('1.005')).toThrow(RangeError);
    expect(() => fromMinor(0.5)).toThrow(RangeError);
  });

  it('takes a percent of an amount half up, exactly (no 0.1 + 0.2 drift)', () => {
    expect(percentOf(7000, '10')).toBe(700);
    expect(percentOf(3333, '33.33')).toBe(1111); // 1110.8889 → 1111
    expect(percentOf(5, '10')).toBe(1); // 0.5 → 1 (half up)
    expect(percentOf(999_999_999_999, '100')).toBe(999_999_999_999);
    expect(percentOf(-1000, '12.5')).toBe(-125);
  });

  it('validates and normalises amounts', () => {
    expect(amountSchema.parse('60')).toBe('60.00');
    expect(amountSchema.parse(12.5)).toBe('12.50');
    expect(amountSchema.parse('0.01')).toBe('0.01');
    expect(amountSchema.safeParse('0').success).toBe(false);
    expect(amountSchema.safeParse('-1').success).toBe(false);
    expect(amountSchema.safeParse('1.234').success).toBe(false);
    expect(amountSchema.safeParse('1000000.01').success).toBe(false);
    expect(amountSchema.parse('1000000')).toBe('1000000.00');
    expect(amountSchema.safeParse('1e3').success).toBe(false);
    expect(signedAmountSchema.parse('-5')).toBe('-5.00');
    expect(signedAmountSchema.safeParse('0.00').success).toBe(false);
  });
});

describe('billing contract', () => {
  it('has Arabic and English labels for every code', () => {
    const sets: Array<[readonly string[], Record<string, { ar: string; en: string }>]> = [
      [CURRENCIES, CURRENCY_LABELS],
      [INVOICE_STATUSES, INVOICE_STATUS_LABELS],
      [INVOICE_KINDS, INVOICE_KIND_LABELS],
      [INVOICE_LINE_TYPES, INVOICE_LINE_TYPE_LABELS],
      [PAYMENT_METHODS, PAYMENT_METHOD_LABELS],
      [PAYMENT_STATUSES, PAYMENT_STATUS_LABELS],
      [BILLING_WARNINGS, BILLING_WARNING_LABELS],
    ];
    for (const [codes, labels] of sets) {
      expect(Object.keys(labels).sort()).toEqual([...codes].sort());
      for (const c of codes) expect(labels[c]!.ar && labels[c]!.en).toBeTruthy();
    }
    for (const m of Object.values(BILLING_ERROR_MESSAGES)) expect(m.ar && m.en).toBeTruthy();
    expect(warningCode('missing_price:12')).toBe('missing_price');
  });

  it('validates packages: currency, duplicates and positive prices', () => {
    const bad = createFeePackageSchema.safeParse({
      name: 'X',
      classesPerWeek: 0,
      prices: [
        { currency: 'XYZ', monthlyAmount: 0 },
        { currency: 'usd', monthlyAmount: 5 },
        { currency: 'USD', monthlyAmount: 5 },
      ],
    });
    expect(bad.success).toBe(false);
    const paths = bad.error!.issues.map((i) => i.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining(['classesPerWeek', 'prices.0.currency', 'prices.0.monthlyAmount']),
    );
    const dup = createFeePackageSchema.safeParse({
      name: 'X',
      classesPerWeek: 2,
      prices: [
        { currency: 'usd', monthlyAmount: 5 },
        { currency: 'USD', monthlyAmount: 6 },
      ],
    });
    expect(dup.error!.issues.map((i) => i.path.join('.'))).toEqual(['prices.1.currency']);
    expect(
      createFeePackageSchema.parse({
        name: 'Two a week',
        classesPerWeek: 2,
        prices: [{ currency: 'gbp', monthlyAmount: '50' }],
      }),
    ).toMatchObject({
      sessionMinutes: 30,
      isActive: true,
      prices: [{ currency: 'GBP', monthlyAmount: '50.00' }],
    });
  });

  it('keeps the line, payment, profile and run rules of the Laravel requests', () => {
    expect(addInvoiceLineSchema.safeParse({ type: 'discount', amount: '5' }).success).toBe(false); // reason
    expect(
      addInvoiceLineSchema.safeParse({ type: 'adjustment', percent: 5, reason: 'Nope' }).success,
    ).toBe(false);
    expect(
      addInvoiceLineSchema.parse({ type: 'discount', percent: 10, reason: 'Sibling' }),
    ).toMatchObject({
      percent: '10.00',
    });
    expect(
      manualPaymentSchema.safeParse({ method: 'stripe', amount: 1, receivedOn: '2026-12-02' })
        .success,
    ).toBe(false);
    expect(
      updateFamilyBillingSchema
        .safeParse({ billingCurrency: 'XYZ', billingDay: 3, billingEnabled: true })
        .error!.issues.map((i) => i.path[0]),
    ).toEqual(['billingCurrency', 'billingDay']);
    expect(
      updateFamilyBillingSchema.parse({
        billingCurrency: 'gbp',
        billingDay: 15,
        billingEnabled: true,
        customFee: '88',
      }),
    ).toMatchObject({ billingCurrency: 'GBP', customFee: '88.00' });
    expect(
      invoiceRunSchema
        .safeParse({ period: '2026-13' })
        .error!.issues.map((i) => i.path[0])
        .sort(),
    ).toEqual(['dueDate', 'period']);
  });
});
