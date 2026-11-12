import { describe, expect, it } from 'vitest';
import { createJournalEntrySchema } from '@qarabic/shared';
import {
  checkJournal,
  checkVoucher,
  emptyLine,
  emptyVoucherLine,
  monthBounds,
  serverFieldErrors,
  sharedSchemaErrors,
} from './forms';

const line = (accountId: number | null, debit = '', credit = '') => ({
  ...emptyLine(),
  accountId,
  debit,
  credit,
});

describe('checkJournal', () => {
  const base = { date: '2026-11-12', currency: 'USD', memo: 'Rent for November' };

  it('builds the body of a balanced entry, amounts as 2-decimal strings', () => {
    const c = checkJournal({
      ...base,
      lines: [line(1, '150'), line(2, '', '150.5'), line(3, '0.5')],
    });
    expect(c.errors).toEqual({});
    expect(c.totals).toEqual({ debit: 15050, credit: 15050, difference: 0 });
    expect(c.body?.lines).toEqual([
      { accountId: 1, debit: '150.00' },
      { accountId: 2, credit: '150.50' },
      { accountId: 3, debit: '0.50' },
    ]);
  });

  it('refuses an unbalanced entry and shows the difference', () => {
    const c = checkJournal({ ...base, lines: [line(1, '100'), line(2, '', '90')] });
    expect(c.errors.lines).toBe('unbalanced');
    expect(c.totals.difference).toBe(1000);
    expect(c.body).toBeNull();
  });

  it('a line needs an account and exactly one of debit / credit; blank lines are ignored', () => {
    const a = line(null, '10');
    const b = line(2, '10', '10');
    const c = checkJournal({ ...base, lines: [a, b, line(null)] });
    expect(c.lineErrors[a.key]).toEqual({ accountId: 'accountRequired' });
    expect(c.lineErrors[b.key]).toEqual({ amount: 'debitOrCredit' });
    expect(checkJournal({ ...base, lines: [line(1, '5'), line(null)] }).errors.lines).toBe(
      'twoLines',
    );
  });

  it('accepts Arabic-Indic digits; checks date, currency and memo', () => {
    const c = checkJournal({
      date: '',
      currency: '',
      memo: 'x',
      lines: [line(1, '١٠٠'), line(2, '', '100')],
    });
    expect(c.errors).toEqual({
      date: 'dateRequired',
      currency: 'currencyRequired',
      memo: 'memoRequired',
    });
    expect(c.totals.debit).toBe(10000);
  });
});

describe('checkVoucher', () => {
  const v = {
    type: 'payment' as const,
    date: '2026-11-12',
    currency: 'EGP',
    cashAccountId: 5,
    party: 'Zoom',
    description: 'Monthly plan',
    reference: '',
    chequeNumber: ' 0042 ',
    lines: [{ ...emptyVoucherLine(), accountId: 9, amount: '149' }],
  };

  it('totals the lines and drops empty optional fields', () => {
    const c = checkVoucher(v);
    expect(c.total).toBe(14900);
    expect(c.body).toMatchObject({
      chequeNumber: '0042',
      lines: [{ accountId: 9, amount: '149.00' }],
    });
    expect(c.body).not.toHaveProperty('reference');
  });

  it('needs the cash account, the party and at least one line with an amount', () => {
    const c = checkVoucher({
      ...v,
      cashAccountId: null,
      party: ' ',
      lines: [{ ...emptyVoucherLine(), accountId: 9 }],
    });
    expect(c.errors).toMatchObject({ cashAccountId: 'cashRequired', party: 'partyRequired' });
    expect(Object.values(c.lineErrors)[0]).toEqual({ amount: 'amountRequired' });
    expect(checkVoucher({ ...v, lines: [] }).errors.lines).toBe('oneLine');
  });
});

it('monthBounds: first and last day of the month', () => {
  expect(monthBounds('2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  expect(monthBounds('2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
});

describe('shared schema gate and server errors', () => {
  it('a 422 lands on its field, lines by the sent order', async () => {
    const { ApiError } = await import('@/lib/api/client');
    const error = new ApiError(422, {
      message: 'Invalid',
      code: 'validation_failed',
      errors: { memo: ['The memo field is required.'], 'lines.1.accountId': ['Invalid.'] },
    });
    expect(serverFieldErrors(error, ['a', 'b'])).toEqual({
      errors: { memo: 'server.required' },
      lineErrors: { b: { accountId: 'server.invalidChoice' } },
    });
    expect(serverFieldErrors(new Error('boom'))).toBeNull();
  });

  it('the shared schema refuses what the local checks miss (a 4-letter currency)', () => {
    const out = sharedSchemaErrors(
      createJournalEntrySchema,
      { date: '2026-11-12', currency: 'USDX', memo: 'ok memo', lines: [] },
      [],
    );
    expect(out.errors).toMatchObject({ currency: 'invalid', lines: 'invalid' });
  });
});
