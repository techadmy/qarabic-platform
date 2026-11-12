import type { CreateJournalEntryInput, CreateVoucherInput, VoucherType } from '@qarabic/shared';
import { ACADEMY_TZ } from '@/lib/billing/labels';
import { parseAmount, toAmount } from '@/lib/billing/money';
import { addDays, dateKeyIn } from '@/lib/schedule-time';

/** Today in the academy calendar (entry dates are academy dates). */
export const academyToday = () => dateKeyIn(ACADEMY_TZ);

/** The first and last day of the month of a date key. */
export function monthBounds(key: string) {
  const first = `${key.slice(0, 7)}-01`;
  const [y, m] = key.split('-').map(Number) as [number, number];
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { from: first, to: addDays(next, -1) };
}

/**
 * Client checks of the accounting forms (the API checks again, with the same rules): every field
 * error is a message key under `accounting.form`, the body is built only when there is none.
 * The running totals are for the person typing; the server decides whether the entry balances.
 */
export type JournalLineForm = {
  key: string;
  accountId: number | null;
  debit: string;
  credit: string;
  description: string;
};

export type JournalForm = {
  date: string;
  currency: string;
  memo: string;
  lines: JournalLineForm[];
};

type LineErrors = { accountId?: string; amount?: string };

export type JournalCheck = {
  errors: { date?: string; currency?: string; memo?: string; lines?: string };
  lineErrors: Record<string, LineErrors>;
  totals: { debit: number; credit: number; difference: number };
  body: CreateJournalEntryInput | null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

let keySeq = 0;
export const newLineKey = () => `l${++keySeq}`;
export const emptyLine = (): JournalLineForm => ({
  key: newLineKey(),
  accountId: null,
  debit: '',
  credit: '',
  description: '',
});

export function checkJournal(form: JournalForm): JournalCheck {
  const errors: JournalCheck['errors'] = {};
  const lineErrors: JournalCheck['lineErrors'] = {};
  if (!DATE.test(form.date)) errors.date = 'dateRequired';
  if (!/^[A-Z]{3}$/.test(form.currency)) errors.currency = 'currencyRequired';
  if (form.memo.trim().length < 3) errors.memo = 'memoRequired';
  let debit = 0;
  let credit = 0;
  const used = form.lines.filter(
    (l) => l.accountId || l.debit.trim() || l.credit.trim() || l.description.trim(),
  );
  const lines: CreateJournalEntryInput['lines'] = [];
  for (const l of used) {
    const e: LineErrors = {};
    if (!l.accountId) e.accountId = 'accountRequired';
    const d = l.debit.trim() ? parseAmount(l.debit) : null;
    const c = l.credit.trim() ? parseAmount(l.credit) : null;
    const badD = l.debit.trim() !== '' && d === null;
    const badC = l.credit.trim() !== '' && c === null;
    if (badD || badC) e.amount = 'amountInvalid';
    else if ((d === null) === (c === null)) e.amount = 'debitOrCredit';
    if (d) debit += d;
    if (c) credit += c;
    if (Object.keys(e).length) lineErrors[l.key] = e;
    else
      lines.push({
        accountId: l.accountId!,
        ...(d ? { debit: toAmount(d) } : { credit: toAmount(c!) }),
        ...(l.description.trim() ? { description: l.description.trim() } : {}),
      });
  }
  if (used.length < 2) errors.lines = 'twoLines';
  else if (debit !== credit) errors.lines = 'unbalanced';
  const ok = !Object.keys(errors).length && !Object.keys(lineErrors).length;
  return {
    errors,
    lineErrors,
    totals: { debit, credit, difference: debit - credit },
    body: ok ? { date: form.date, currency: form.currency, memo: form.memo.trim(), lines } : null,
  };
}

export type VoucherLineForm = {
  key: string;
  accountId: number | null;
  amount: string;
  description: string;
};

export type VoucherForm = {
  type: VoucherType;
  date: string;
  currency: string;
  cashAccountId: number | null;
  party: string;
  description: string;
  reference: string;
  chequeNumber: string;
  lines: VoucherLineForm[];
};

export type VoucherCheck = {
  errors: Partial<
    Record<'date' | 'currency' | 'cashAccountId' | 'party' | 'description' | 'lines', string>
  >;
  lineErrors: Record<string, LineErrors>;
  total: number;
  body: CreateVoucherInput | null;
};

export const emptyVoucherLine = (): VoucherLineForm => ({
  key: newLineKey(),
  accountId: null,
  amount: '',
  description: '',
});

export function checkVoucher(form: VoucherForm): VoucherCheck {
  const errors: VoucherCheck['errors'] = {};
  const lineErrors: VoucherCheck['lineErrors'] = {};
  if (!DATE.test(form.date)) errors.date = 'dateRequired';
  if (!/^[A-Z]{3}$/.test(form.currency)) errors.currency = 'currencyRequired';
  if (!form.cashAccountId) errors.cashAccountId = 'cashRequired';
  if (form.party.trim().length < 2) errors.party = 'partyRequired';
  if (form.description.trim().length < 3) errors.description = 'descriptionRequired';
  let total = 0;
  const used = form.lines.filter((l) => l.accountId || l.amount.trim() || l.description.trim());
  const lines: CreateVoucherInput['lines'] = [];
  for (const l of used) {
    const e: LineErrors = {};
    if (!l.accountId) e.accountId = 'accountRequired';
    const a = parseAmount(l.amount);
    if (a === null) e.amount = l.amount.trim() ? 'amountInvalid' : 'amountRequired';
    else total += a;
    if (Object.keys(e).length) lineErrors[l.key] = e;
    else
      lines.push({
        accountId: l.accountId!,
        amount: toAmount(a!),
        ...(l.description.trim() ? { description: l.description.trim() } : {}),
      });
  }
  if (used.length === 0) errors.lines = 'oneLine';
  const ok = !Object.keys(errors).length && !Object.keys(lineErrors).length;
  return {
    errors,
    lineErrors,
    total,
    body: ok
      ? {
          type: form.type,
          date: form.date,
          currency: form.currency,
          cashAccountId: form.cashAccountId!,
          party: form.party.trim(),
          description: form.description.trim(),
          ...(form.reference.trim() ? { reference: form.reference.trim() } : {}),
          ...(form.chequeNumber.trim() ? { chequeNumber: form.chequeNumber.trim() } : {}),
          lines,
        }
      : null,
  };
}
