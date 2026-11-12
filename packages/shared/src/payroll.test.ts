import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_TYPE_LABELS,
  ADJUSTMENT_TYPES,
  adjustmentSign,
  createAdjustmentSchema,
  createLeaveSchema,
  createPayRuleSetSchema,
  DEFAULT_PAY_RULES,
  isLockedRun,
  PAYROLL_ERROR_MESSAGES,
  PAYSLIP_LINE_CODES,
  PAYSLIP_LINE_LABELS,
  payMoneyInputSchema,
  payRuleCandidates,
  recordPaymentSchema,
  savePayProfileSchema,
} from './payroll.js';

describe('payroll contract', () => {
  it('signs adjustments like the old teacher_fine types', () => {
    expect(ADJUSTMENT_TYPES.filter((t) => adjustmentSign(t) < 0)).toEqual([
      'fine',
      'advance',
      'other_deduction',
    ]);
  });

  it('labels every type, line and error in Arabic and English', () => {
    for (const t of ADJUSTMENT_TYPES) expect(ADJUSTMENT_TYPE_LABELS[t].ar).toBeTruthy();
    for (const c of PAYSLIP_LINE_CODES) {
      expect(PAYSLIP_LINE_LABELS[c].ar, c).toBeTruthy();
      expect(PAYSLIP_LINE_LABELS[c].en, c).toBeTruthy();
    }
    for (const m of Object.values(PAYROLL_ERROR_MESSAGES)) expect(m.ar && m.en).toBeTruthy();
  });

  it('tries pay rule keys most specific first', () => {
    expect(payRuleCandidates('trial', 'cancelled', 'holiday')).toEqual([
      'trial:cancelled:holiday',
      'trial:cancelled',
      'trial:*',
      'cancelled:holiday',
      'cancelled',
      'default',
    ]);
    expect(payRuleCandidates('regular', 'taken', null)).toEqual([
      'regular:taken',
      'regular:*',
      'taken',
      'default',
    ]);
    expect(DEFAULT_PAY_RULES['trial:*']?.factor).toBe(0);
  });

  it('parses money as 2-decimal strings', () => {
    expect(payMoneyInputSchema.parse(12.5)).toBe('12.50');
    expect(payMoneyInputSchema.parse('30000')).toBe('30000.00');
    expect(payMoneyInputSchema.safeParse('1.234').success).toBe(false);
    expect(payMoneyInputSchema.safeParse(-1).success).toBe(false);
  });

  it('validates adjustments, leave, profiles, payments and rule sets', () => {
    const base = { userId: 1, effectiveOn: '2026-10-07', reason: 'Late twice' };
    expect(createAdjustmentSchema.safeParse({ ...base, type: 'fine' }).success).toBe(false);
    expect(createAdjustmentSchema.safeParse({ ...base, type: 'fine', amount: '0' }).success).toBe(
      false,
    );
    expect(createAdjustmentSchema.safeParse({ ...base, type: 'fine', amount: '5' }).success).toBe(
      true,
    );
    expect(createAdjustmentSchema.safeParse({ ...base, type: 'csr_conversions' }).success).toBe(
      false,
    );
    expect(
      createAdjustmentSchema.safeParse({ ...base, type: 'csr_conversions', quantity: 2 }).success,
    ).toBe(true);

    expect(
      createLeaveSchema.safeParse({
        startsOn: '2026-11-02',
        endsOn: '2026-11-01',
        leaveType: 'paid',
        reason: 'abc',
      }).success,
    ).toBe(false);

    expect(savePayProfileSchema.safeParse({ salaryType: 'hourly', currency: 'egp' }).success).toBe(
      false,
    );
    const ok = savePayProfileSchema.parse({
      salaryType: 'hourly',
      currency: 'egp',
      hourlyRate: 120,
    });
    expect(ok).toMatchObject({ currency: 'EGP', hourlyRate: '120.00' });

    expect(recordPaymentSchema.safeParse({ method: 'cash', paidOn: '2026-11-15' }).success).toBe(
      true,
    );
    expect(
      recordPaymentSchema.safeParse({ method: 'bank_transfer', paidOn: '2026-11-15' }).success,
    ).toBe(false);
    expect(
      recordPaymentSchema.safeParse({ method: 'instapay', reference: 'x', paidOn: '2026-11-15' })
        .success,
    ).toBe(false);

    expect(
      createPayRuleSetSchema.safeParse({
        effectiveFrom: '2026-12-01T00:00:00Z',
        rules: { 'trial:taken': { factor: 1, billable: false } },
      }).success,
    ).toBe(true);
    expect(
      createPayRuleSetSchema.safeParse({
        effectiveFrom: '2026-12-01T00:00:00Z',
        rules: { taken: { factor: 6, billable: true } },
      }).success,
    ).toBe(false);
    expect(isLockedRun('approved') && isLockedRun('paid') && !isLockedRun('reviewed')).toBe(true);
  });
});

describe('payroll leftovers (docs/21)', () => {
  it('approve note: optional, blank = none, otherwise 3+ characters', async () => {
    const { approveDecisionSchema, runTransitionSchema, PAYROLL_ERROR_MESSAGES } =
      await import('./payroll.js');
    expect(approveDecisionSchema.parse({}).note).toBeNull();
    expect(approveDecisionSchema.parse({ note: '  ' }).note).toBeNull();
    expect(approveDecisionSchema.parse({ note: ' Fine ' }).note).toBe('Fine');
    expect(approveDecisionSchema.safeParse({ note: 'ok' }).success).toBe(false);
    expect(runTransitionSchema.safeParse({ expectedUpdatedAt: 'yesterday' }).success).toBe(false);
    expect(runTransitionSchema.parse({})).toEqual({});
    expect(PAYROLL_ERROR_MESSAGES.stale_run.ar).toBeTruthy();
  });
});
