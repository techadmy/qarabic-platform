import { permissionsFor } from '@qarabic/shared';
import { describe, expect, it } from 'vitest';
import {
  creatableTypes,
  finesNeedApproval,
  leaveDays,
  validateAdjustment,
  validateLeave,
  validateMark,
  validatePayment,
  validateProfile,
  validateRuleSet,
  type AdjustmentForm,
  type ProfileForm,
} from './forms';
import {
  defaultRunPeriod,
  durationLabel,
  hoursLabel,
  isPeriod,
  previousPeriod,
  runStep,
  splitLines,
  workDayLabel,
  zoneOffset,
} from './labels';

describe('payroll labels', () => {
  it('steps months back across the year', () => {
    expect(previousPeriod('2026-11')).toBe('2026-10');
    expect(previousPeriod('2026-01')).toBe('2025-12');
    expect(isPeriod('2026-13')).toBe(false);
    expect(isPeriod('2026-02')).toBe(true);
  });

  it('defaults a new run to the month that ended, else the current one', () => {
    expect(defaultRunPeriod([], '2026-11')).toBe('2026-10');
    expect(defaultRunPeriod(['2026-10'], '2026-11')).toBe('2026-11');
    expect(defaultRunPeriod(['2026-10', '2026-11'], '2026-11')).toBeNull();
  });

  it('formats durations and hours without floats', () => {
    expect(durationLabel(135)).toBe('2:15');
    expect(durationLabel(0)).toBe('0:00');
    expect(durationLabel(null)).toBe('—');
    expect(hoursLabel('12.50')).toBe('12.5');
    expect(hoursLabel('3.00')).toBe('3');
    expect(hoursLabel('0.25')).toBe('0.25');
    expect(hoursLabel(null)).toBe('0');
  });

  it('names a work day without a zone shift', () => {
    expect(workDayLabel('2026-11-12', 'en')).toBe('Thursday 12 November');
  });

  it('gives the zone offset of a day (Cairo winter and summer time)', () => {
    expect(zoneOffset('Africa/Cairo', '2026-12-01')).toBe('+02:00');
    expect(zoneOffset('Africa/Cairo', '2026-07-01')).toBe('+03:00');
    expect(zoneOffset('UTC', '2026-07-01')).toBe('+00:00');
  });

  it('splits payslip lines into additions and deductions, dropping zero lines', () => {
    const line = (code: string, sign: 1 | -1, amount: string) =>
      ({ code, sign, amount, quantity: null, rate: null, adjustment: null }) as never;
    const { additions, deductions } = splitLines([
      line('hour_earning', 1, '950.00'),
      line('fine', -1, '25.00'),
      line('allowance', 1, '0.00'),
      line('tax', -1, '10.00'),
    ]);
    expect(additions.map((l) => l.code)).toEqual(['hour_earning']);
    expect(deductions.map((l) => l.code)).toEqual(['fine', 'tax']);
  });

  it('orders the run lifecycle', () => {
    expect(runStep('draft')).toBeLessThan(runStep('reviewed'));
    expect(runStep('approved')).toBeLessThan(runStep('paid'));
  });
});

describe('leave form', () => {
  const base = {
    userId: null,
    startsOn: '2026-11-20',
    endsOn: '2026-11-22',
    leaveType: 'paid' as const,
    reason: 'Family wedding',
  };

  it('counts both ends', () => {
    expect(leaveDays('2026-11-20', '2026-11-22')).toBe(3);
    expect(leaveDays('2026-11-30', '2026-12-01')).toBe(2);
  });

  it('builds the request (own leave: no userId)', () => {
    expect(validateLeave(base).body).toEqual({
      startsOn: '2026-11-20',
      endsOn: '2026-11-22',
      leaveType: 'paid',
      reason: 'Family wedding',
    });
    expect(validateLeave({ ...base, userId: 103 }).body?.userId).toBe(103);
  });

  it('refuses an end before the start, a too-long leave and a short reason', () => {
    expect(validateLeave({ ...base, endsOn: '2026-11-19' }).errors.endsOn).toBe('endBeforeStart');
    expect(validateLeave({ ...base, endsOn: '2027-01-30' }).errors.endsOn).toBe('tooManyDays');
    expect(validateLeave({ ...base, reason: ' a ' }).errors.reason).toBe('reasonRequired');
    expect(validateLeave({ ...base, startsOn: 'x' }).errors.startsOn).toBe('dateInvalid');
  });
});

describe('mark a day', () => {
  it('needs a reason; paidLeave only for leave', () => {
    expect(
      validateMark({ status: 'absent', paidLeave: true, note: '', reason: '' }).errors,
    ).toEqual({
      reason: 'reasonRequired',
    });
    expect(
      validateMark({ status: 'leave', paidLeave: false, note: ' ', reason: 'Sick, called in' })
        .body,
    ).toEqual({ status: 'leave', paidLeave: false, note: null, reason: 'Sick, called in' });
    expect(
      validateMark({ status: 'present', paidLeave: false, note: 'Late', reason: 'Fix' }).body,
    ).toEqual({ status: 'present', note: 'Late', reason: 'Fix' });
  });
});

describe('fine / pay item form', () => {
  const v: AdjustmentForm = {
    userId: 2,
    type: 'fine',
    amount: '٢٥٫٥',
    quantity: '',
    effectiveOn: '2026-11-03',
    sessionId: '',
    reason: 'Late to class',
  };

  it('parses Arabic digits into an exact decimal string', () => {
    expect(validateAdjustment(v).body).toEqual({
      userId: 2,
      type: 'fine',
      amount: '25.50',
      effectiveOn: '2026-11-03',
      reason: 'Late to class',
      sessionId: null,
    });
  });

  it('takes a count (not an amount) for CSR conversions', () => {
    const r = validateAdjustment({ ...v, type: 'csr_conversions', amount: '', quantity: '3' });
    expect(r.body).toMatchObject({ type: 'csr_conversions', quantity: 3 });
    expect(r.body).not.toHaveProperty('amount');
    expect(
      validateAdjustment({ ...v, type: 'csr_conversions', quantity: '0' }).errors.quantity,
    ).toBe('quantityInvalid');
  });

  it('refuses a missing person, a bad amount, a bad class and a short reason', () => {
    const r = validateAdjustment({
      ...v,
      userId: null,
      amount: '-5',
      sessionId: 'abc',
      reason: 'no',
    });
    expect(r.errors).toEqual({
      userId: 'personRequired',
      amount: 'amountInvalid',
      sessionId: 'classInvalid',
      reason: 'reasonRequired',
    });
    expect(validateAdjustment({ ...v, amount: '0' }).errors.amount).toBe('amountInvalid');
    expect(validateAdjustment({ ...v, amount: '10.123' }).errors.amount).toBe('amountInvalid');
  });

  it('offers the types the role may add (docs/21 §6)', () => {
    expect(creatableTypes(permissionsFor('monitor'))).toEqual(['fine']);
    expect(creatableTypes(permissionsFor('manager'))).toEqual(['fine', 'fine_reduction']);
    expect(creatableTypes(permissionsFor('accounts'))).toContain('bonus');
    expect(creatableTypes(permissionsFor('accounts'))).toContain('csr_conversions');
    expect(creatableTypes(permissionsFor('teacher'))).toEqual([]);
    expect(finesNeedApproval(permissionsFor('monitor'))).toBe(true);
    expect(finesNeedApproval(permissionsFor('manager'))).toBe(false);
  });
});

describe('record a payment', () => {
  it('needs a reference except for cash, and a date not after today', () => {
    const today = '2026-11-12';
    expect(
      validatePayment({ method: 'vodafone_cash', reference: ' ', paidOn: today }, { today }).errors,
    ).toEqual({ reference: 'referenceRequired' });
    expect(
      validatePayment({ method: 'cash', reference: '', paidOn: today }, { today }).body,
    ).toEqual({ method: 'cash', reference: null, paidOn: today });
    expect(
      validatePayment(
        { method: 'bank_transfer', reference: 'TR-1', paidOn: '2026-11-13' },
        { today },
      ).errors.paidOn,
    ).toBe('dateNotFuture');
  });
});

describe('salary profile form', () => {
  const v: ProfileForm = {
    salaryType: 'hourly',
    currency: 'egp',
    monthlySalary: '',
    classRate: '',
    hourlyRate: '95',
    csrRate: '',
    allowance: '200.5',
    tax: '0',
    slotTiers: [],
    active: true,
    notes: '',
    reason: '',
  };

  it('normalises amounts and the currency; unused rates are 0', () => {
    expect(validateProfile(v).body).toEqual({
      salaryType: 'hourly',
      currency: 'EGP',
      monthlySalary: '0.00',
      classRate: '0.00',
      hourlyRate: '95.00',
      csrRate: '0.00',
      allowance: '200.50',
      tax: '0.00',
      slotTiers: [],
      active: true,
      notes: null,
      reason: null,
    });
  });

  it('requires the rate of the salary type and tiers for slot pay', () => {
    expect(validateProfile({ ...v, hourlyRate: '' }).errors.hourlyRate).toBe('rateRequired');
    expect(validateProfile({ ...v, salaryType: 'slot' }).errors.slotTiers).toBe('tiersRequired');
    const slot = validateProfile({
      ...v,
      salaryType: 'slot',
      slotTiers: [
        { minSlots: '10', amount: '4000' },
        { minSlots: '0', amount: '1500' },
      ],
    });
    expect(slot.body?.slotTiers).toEqual([
      { minSlots: 0, amount: '1500.00' },
      { minSlots: 10, amount: '4000.00' },
    ]);
    expect(validateProfile({ ...v, currency: 'EG' }).errors.currency).toBe('currencyInvalid');
  });
});

describe('pay rule set form', () => {
  const ctx = { today: '2026-11-12', zoneOffset: '+02:00' };
  const rows = [
    { key: 'taken', factor: '1', billable: true, paidHolidayOnly: false },
    { key: 'cancelled:holiday', factor: '1', billable: false, paidHolidayOnly: true },
  ];

  it('builds the version from local midnight of the start day', () => {
    expect(validateRuleSet({ effectiveOn: '2026-11-15', rows, note: '' }, ctx).body).toEqual({
      effectiveFrom: '2026-11-15T00:00:00+02:00',
      rules: {
        taken: { factor: 1, billable: true },
        'cancelled:holiday': { factor: 1, billable: false, paidHolidayOnly: true },
      },
      note: null,
    });
  });

  it('refuses a past start, a bad or repeated key and a factor above 5', () => {
    expect(
      validateRuleSet({ effectiveOn: '2026-11-11', rows, note: '' }, ctx).errors.effectiveOn,
    ).toBe('dateFromToday');
    const bad = (key: string, factor = '1') =>
      validateRuleSet(
        { effectiveOn: '2026-11-12', rows: [{ ...rows[0]!, key, factor }], note: '' },
        ctx,
      ).errors.rows;
    expect(bad('Taken!')).toBe('rulesInvalid');
    expect(bad('taken', '6')).toBe('rulesInvalid');
    expect(
      validateRuleSet({ effectiveOn: '2026-11-12', rows: [rows[0]!, rows[0]!], note: '' }, ctx)
        .errors.rows,
    ).toBe('rulesInvalid');
    expect(
      validateRuleSet({ effectiveOn: '2026-11-12', rows: [], note: '' }, ctx).errors.rows,
    ).toBe('rulesRequired');
  });
});
