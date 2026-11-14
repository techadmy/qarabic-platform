import { readFileSync } from 'node:fs';
import { SYSTEM_ACCOUNT_KEYS } from '@qarabic/shared';
import { describe, expect, it } from 'vitest';
import { CHART, chartStatements } from './chart.js';
import {
  billingEntry,
  type DraftEntry,
  payrollEntry,
  PostingRuleError,
  type BillingEventInput,
} from './rules.js';

const sum = (e: DraftEntry, side: 'debit' | 'credit') => e.lines.reduce((a, l) => a + l[side], 0);

const billing = (over: Partial<BillingEventInput>): BillingEventInput => ({
  id: 1,
  type: 'invoice.issued',
  subjectType: 'invoice',
  subjectId: 10,
  familyId: 7,
  amount: 12_000,
  currency: 'USD',
  payload: { number: 'INV-2026-0001' },
  date: '2026-11-01',
  ...over,
});

describe('chart of accounts', () => {
  it('has unique codes, parents before children, groups as parents and every system account', () => {
    const codes = new Set<string>();
    for (const r of CHART) {
      expect(codes.has(r.code)).toBe(false);
      if (r.parent) {
        expect(codes.has(r.parent)).toBe(true);
        const parent = CHART.find((p) => p.code === r.parent)!;
        expect(parent.group).toBe(true);
        expect(parent.type).toBe(r.type);
      }
      codes.add(r.code);
    }
    const keys = CHART.flatMap((r) => (r.key ? [r.key] : []));
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...SYSTEM_ACCOUNT_KEYS].sort());
    expect(CHART.filter((r) => r.key && r.group)).toEqual([]);
  });

  it('is exactly what the migration seeds', () => {
    const sql = readFileSync(
      new URL(
        '../../prisma/migrations/20261118000000_m7_accounting/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    // The M7 seed is the chart without the accounts added later by their own migrations.
    const later = ['2140'];
    for (const stmt of chartStatements(CHART.filter((r) => !later.includes(r.code)))) {
      expect(sql).toContain(stmt);
    }
    const p11 = readFileSync(
      new URL(
        '../../prisma/migrations/20261128000000_p1_1_family_credit/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(p11).toContain("'2140'");
    expect(p11).toContain("'customer_credits'");
  });
});

describe('billing posting rules (D86)', () => {
  it('issues: Dr receivable (family) / Cr tuition revenue', () => {
    const e = billingEntry(billing({}))!;
    expect(e.lines).toEqual([
      { key: 'receivable', debit: 12_000, credit: 0, partyType: 'family', partyId: 7 },
      { key: 'tuition_revenue', debit: 0, credit: 12_000 },
    ]);
    expect(e.memo).toContain('INV-2026-0001');
  });

  it('a discount goes to discounts allowed; a negative adjustment reduces revenue', () => {
    const d = billingEntry(
      billing({ type: 'invoice.adjusted', amount: -1_000, payload: { lineType: 'discount' } }),
    )!;
    expect(d.lines.map((l) => [l.key, l.debit, l.credit])).toEqual([
      ['discounts', 1_000, 0],
      ['receivable', 0, 1_000],
    ]);
    const a = billingEntry(
      billing({ type: 'invoice.adjusted', amount: -500, payload: { lineType: 'adjustment' } }),
    )!;
    expect(a.lines[0]!.key).toBe('tuition_revenue');
    const up = billingEntry(billing({ type: 'invoice.adjusted', amount: 700 }))!;
    expect(up.lines.map((l) => l.key)).toEqual(['receivable', 'tuition_revenue']);
  });

  it('void reverses the issue; payments land in the clearing account of their method', () => {
    const v = billingEntry(billing({ type: 'invoice.voided', amount: -12_000 }))!;
    expect(v.lines.map((l) => [l.key, l.debit, l.credit])).toEqual([
      ['tuition_revenue', 12_000, 0],
      ['receivable', 0, 12_000],
    ]);
    for (const [method, key] of [
      ['stripe', 'stripe_clearing'],
      ['paypal', 'paypal_clearing'],
      ['bank_transfer', 'bank'],
      ['cheque', 'bank'],
      ['cash', 'cash'],
      ['other', 'cash'],
    ] as const) {
      const p = billingEntry(
        billing({ type: 'payment.succeeded', subjectType: 'payment', payload: { method } }),
      )!;
      expect(p.lines[0]).toMatchObject({ key, debit: 12_000 });
      expect(p.lines[1]).toMatchObject({ key: 'receivable', credit: 12_000, partyId: 7 });
      const r = billingEntry(
        billing({ type: 'payment.refunded', amount: -12_000, payload: { method } }),
      )!;
      expect(r.lines[1]).toMatchObject({ key, credit: 12_000 });
    }
  });

  it('zero amounts post nothing; unknown events are refused', () => {
    expect(billingEntry(billing({ amount: 0 }))).toBeNull();
    expect(() => billingEntry(billing({ type: 'invoice.teleported' }))).toThrow(PostingRuleError);
  });
});

describe('payroll posting rules (D95)', () => {
  const slip = {
    period: '2026-10',
    userId: 5,
    currency: 'EGP',
    earnings: '3150.00',
    deductions: '450.00',
    net: '2700.00',
    lines: [
      { code: 'hour_earning', sign: 1, amount: '3000.00' },
      { code: 'bonus', sign: 1, amount: '150.00' },
      { code: 'fine', sign: -1, amount: '100.00' },
      { code: 'advance', sign: -1, amount: '200.00' },
      { code: 'leave_deduction', sign: -1, amount: '50.00' },
      { code: 'tax', sign: -1, amount: '100.00' },
    ],
  };

  it('approval: Dr salaries (net of leave deduction), Cr fines, advances, tax and the wallet', () => {
    const e = payrollEntry({
      id: 1,
      type: 'payslip.approved',
      aggregateId: 9,
      payload: slip,
      date: '2026-11-03',
    })!;
    expect(e.currency).toBe('EGP');
    expect(e.lines.map((l) => [l.key, l.debit, l.credit])).toEqual([
      ['salaries_expense', 310_000, 0],
      ['fines_income', 0, 10_000],
      ['staff_advances', 0, 20_000],
      ['tax_payable', 0, 10_000],
      ['salaries_payable', 0, 270_000],
    ]);
    expect(sum(e, 'debit')).toBe(sum(e, 'credit'));
    expect(e.lines.at(-1)).toMatchObject({ partyType: 'user', partyId: 5 });
  });

  it('reopen swaps the approval; payment clears the wallet against the payout account', () => {
    const r = payrollEntry({
      id: 2,
      type: 'payslip.reversed',
      aggregateId: 9,
      payload: slip,
      date: '2026-11-04',
    })!;
    expect(r.lines.at(-1)).toMatchObject({ key: 'salaries_payable', debit: 270_000, credit: 0 });
    const p = payrollEntry({
      id: 3,
      type: 'payslip.paid',
      aggregateId: 9,
      payload: {
        userId: 5,
        currency: 'EGP',
        net: '2700.00',
        method: 'vodafone_cash',
        paidOn: '2026-11-05',
        period: '2026-10',
      },
      date: '2026-11-06',
    })!;
    expect(p.date).toBe('2026-11-05');
    expect(p.lines.map((l) => [l.key, l.debit, l.credit])).toEqual([
      ['salaries_payable', 270_000, 0],
      ['vodafone_cash', 0, 270_000],
    ]);
  });

  it('a fine reduction is a debit of fines income; run summaries post nothing', () => {
    const e = payrollEntry({
      id: 4,
      type: 'payslip.approved',
      aggregateId: 1,
      payload: {
        userId: 1,
        currency: 'PKR',
        net: '1050.00',
        lines: [
          { code: 'hour_earning', sign: 1, amount: '1000.00' },
          { code: 'fine_reduction', sign: 1, amount: '50.00' },
        ],
      },
      date: '2026-11-01',
    })!;
    expect(e.lines.find((l) => l.key === 'fines_income')).toMatchObject({ debit: 5_000 });
    expect(
      payrollEntry({
        id: 5,
        type: 'payroll_run.approved',
        aggregateId: 1,
        payload: {},
        date: '2026-11-01',
      }),
    ).toBeNull();
  });

  it('refuses a payslip whose lines do not add up to the net', () => {
    expect(() =>
      payrollEntry({
        id: 6,
        type: 'payslip.approved',
        aggregateId: 2,
        payload: { ...slip, net: '2699.99' },
        date: '2026-11-01',
      }),
    ).toThrow(PostingRuleError);
  });
});
