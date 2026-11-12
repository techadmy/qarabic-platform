import {
  createJournalEntrySchema,
  createVoucherSchema,
  type CreateJournalEntryInput,
  type CreateVoucherInput,
  type VoucherType,
} from '@qarabic/shared';
import type { z } from 'zod';
import { isApiError } from '@/lib/api/client';
import { serverMessageKey } from '@/lib/forms/server-errors';
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

type LineErrors = { accountId?: string; amount?: string; description?: string };

/**
 * Field errors as message keys: `form.*` keys of the accounting messages, or `server.*` keys of the
 * shared `validation` messages (from a 422). Lines are keyed by the form line's key.
 */
export type PlacedErrors = {
  errors: Record<string, string>;
  lineErrors: Record<string, LineErrors>;
};

/** Puts one error on its field: `lines.2.debit` → the third sent line's amount. */
function place(path: PropertyKey[], key: string, lineKeys: string[], out: PlacedErrors) {
  const [head, index, leaf] = path;
  if (head === 'lines' && typeof index === 'number' && lineKeys[index]) {
    const k = lineKeys[index]!;
    const field =
      leaf === 'accountId' ? 'accountId' : leaf === 'description' ? 'description' : 'amount';
    out.lineErrors[k] = { ...out.lineErrors[k], [field]: key };
  } else if (typeof head === 'string') {
    out.errors[head] ??= key;
  }
}

/**
 * The body checked by the shared schema too (the API's own rules), so the screen and the API
 * cannot drift: anything the local checks let through lands on its field as «القيمة غير صحيحة».
 */
export function sharedSchemaErrors(
  schema: z.ZodType,
  body: unknown,
  lineKeys: string[],
): PlacedErrors {
  const out: PlacedErrors = { errors: {}, lineErrors: {} };
  const parsed = schema.safeParse(body);
  if (!parsed.success) for (const i of parsed.error.issues) place(i.path, 'invalid', lineKeys, out);
  return out;
}

/** A 422 from the API mapped onto the fields (`lines.0.accountId`, `code`, …); null otherwise. */
export function serverFieldErrors(error: unknown, lineKeys: string[] = []): PlacedErrors | null {
  if (!isApiError(error, 422) || !error.error?.errors) return null;
  const out: PlacedErrors = { errors: {}, lineErrors: {} };
  for (const [key, messages] of Object.entries(error.error.errors)) {
    const path = key.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p));
    place(path, `server.${serverMessageKey(messages[0])}`, lineKeys, out);
  }
  return Object.keys(out.errors).length || Object.keys(out.lineErrors).length ? out : null;
}

const hasAny = (e: PlacedErrors) =>
  Object.keys(e.errors).length > 0 || Object.keys(e.lineErrors).length > 0;

export type JournalCheck = {
  errors: { date?: string; currency?: string; memo?: string; lines?: string };
  lineErrors: Record<string, LineErrors>;
  /** The keys of the lines that are sent, in order (`lines.N` of the body). */
  lineKeys: string[];
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
  let ok = !Object.keys(errors).length && !Object.keys(lineErrors).length;
  const body = { date: form.date, currency: form.currency, memo: form.memo.trim(), lines };
  if (ok) {
    const shared = sharedSchemaErrors(
      createJournalEntrySchema,
      body,
      used.map((l) => l.key),
    );
    Object.assign(errors, shared.errors);
    Object.assign(lineErrors, shared.lineErrors);
    ok = !hasAny(shared);
  }
  return {
    errors,
    lineErrors,
    lineKeys: used.map((l) => l.key),
    totals: { debit, credit, difference: debit - credit },
    body: ok ? body : null,
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
  > &
    Record<string, string | undefined>;
  lineErrors: Record<string, LineErrors>;
  lineKeys: string[];
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
  let ok = !Object.keys(errors).length && !Object.keys(lineErrors).length;
  const body: CreateVoucherInput = {
    type: form.type,
    date: form.date,
    currency: form.currency,
    cashAccountId: form.cashAccountId ?? 0,
    party: form.party.trim(),
    description: form.description.trim(),
    ...(form.reference.trim() ? { reference: form.reference.trim() } : {}),
    ...(form.chequeNumber.trim() ? { chequeNumber: form.chequeNumber.trim() } : {}),
    lines,
  };
  if (ok) {
    const shared = sharedSchemaErrors(
      createVoucherSchema,
      body,
      used.map((l) => l.key),
    );
    Object.assign(errors, shared.errors);
    Object.assign(lineErrors, shared.lineErrors);
    ok = !hasAny(shared);
  }
  return { errors, lineErrors, lineKeys: used.map((l) => l.key), total, body: ok ? body : null };
}
