import type { SystemAccountKey } from '@qarabic/shared';
import { cents } from '../payroll/money.js';

/**
 * Posting rules of the automatic entries (docs/07 §أ.5, docs/20 §10, docs/21 §10). Pure: an outbox
 * event in, the lines of one balanced entry out (or `null` = nothing to post, e.g. a run summary).
 * Amounts are minor units; accounts are system keys resolved by the caller.
 */
export interface DraftLine {
  key: SystemAccountKey;
  debit: number;
  credit: number;
  description?: string | null;
  partyType?: 'family' | 'user' | null;
  partyId?: number | null;
}

export interface DraftEntry {
  /** Local date `YYYY-MM-DD` (academy zone) the entry is dated. */
  date: string;
  currency: string;
  memo: string;
  lines: DraftLine[];
}

export class PostingRuleError extends Error {}

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;

const dr = (key: SystemAccountKey, amount: number, extra: Partial<DraftLine> = {}): DraftLine => ({
  key,
  debit: amount,
  credit: 0,
  ...extra,
});
const cr = (key: SystemAccountKey, amount: number, extra: Partial<DraftLine> = {}): DraftLine => ({
  key,
  debit: 0,
  credit: amount,
  ...extra,
});

/** Where a received payment lands (Stripe / PayPal clearing until the payout reaches the bank). */
export function paymentAccount(method: string): SystemAccountKey {
  switch (method) {
    case 'stripe':
      return 'stripe_clearing';
    case 'paypal':
      return 'paypal_clearing';
    case 'bank_transfer':
    case 'cheque':
      return 'bank';
    // A family credit used on an invoice: the liability goes down, no money moves (B115).
    case 'credit':
      return 'customer_credits';
    default:
      return 'cash';
  }
}

/** Where a payslip was paid from. */
export function payoutAccount(method: string): SystemAccountKey {
  switch (method) {
    case 'vodafone_cash':
      return 'vodafone_cash';
    case 'bank_transfer':
      return 'bank';
    default:
      return 'cash';
  }
}

export interface BillingEventInput {
  id: number;
  type: string;
  subjectType: string;
  subjectId: number;
  familyId: number;
  /** Signed minor units. */
  amount: number;
  currency: string;
  payload: Record<string, unknown>;
  /** Academy-zone date of `occurred_at`. */
  date: string;
}

/** `billing_events` → entry (D86). */
/** P1-1: the part of a payment that became the family's credit (minor units, 0…amount). */
function unappliedOf(payload: Record<string, unknown>, amount: number): number {
  const raw = payload.unapplied;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? cents(raw) : 0;
  return Math.min(Math.max(0, n), amount);
}

/** The receivable side of a payment, with its unapplied part on customer credits (B115). */
function withCredit(
  lines: DraftLine[],
  side: 'dr' | 'cr',
  amount: number,
  unapplied: number,
  party: Partial<DraftLine>,
): DraftLine[] {
  const post = side === 'cr' ? cr : dr;
  const applied = amount - unapplied;
  if (applied > 0) lines.push(post('receivable', applied, party));
  if (unapplied > 0) lines.push(post('customer_credits', unapplied, party));
  return lines;
}

export function billingEntry(e: BillingEventInput): DraftEntry | null {
  const amount = Math.abs(e.amount);
  if (amount === 0) return null;
  const party = { partyType: 'family' as const, partyId: e.familyId };
  const number = typeof e.payload.number === 'string' ? e.payload.number : `#${e.subjectId}`;
  const base = { date: e.date, currency: e.currency };
  switch (e.type) {
    case 'invoice.issued':
      return {
        ...base,
        memo: `Invoice ${number} issued`,
        lines: [dr('receivable', amount, party), cr('tuition_revenue', amount)],
      };
    case 'invoice.adjusted': {
      const discount = e.payload.lineType === 'discount';
      if (e.amount > 0) {
        return {
          ...base,
          memo: `Invoice ${number} adjusted`,
          lines: [dr('receivable', amount, party), cr('tuition_revenue', amount)],
        };
      }
      return {
        ...base,
        memo: discount ? `Invoice ${number} discount` : `Invoice ${number} adjusted`,
        lines: [
          dr(discount ? 'discounts' : 'tuition_revenue', amount),
          cr('receivable', amount, party),
        ],
      };
    }
    case 'invoice.voided':
      return {
        ...base,
        memo: `Invoice ${number} ${e.payload.reason === 'split' ? 'split' : 'voided'}`,
        lines: [dr('tuition_revenue', amount), cr('receivable', amount, party)],
      };
    case 'payment.succeeded': {
      const method = str(e.payload.method, 'other');
      return {
        ...base,
        memo: `Payment #${e.subjectId} received (${method})`,
        lines: withCredit(
          [dr(paymentAccount(method), amount)],
          'cr',
          amount,
          unappliedOf(e.payload, amount),
          party,
        ),
      };
    }
    case 'payment.refunded': {
      const method = str(e.payload.method, 'other');
      return {
        ...base,
        memo: `Payment #${e.subjectId} refunded (${method})`,
        lines: [
          ...withCredit([], 'dr', amount, unappliedOf(e.payload, amount), party),
          cr(paymentAccount(method), amount),
        ],
      };
    }
    default:
      throw new PostingRuleError(`No posting rule for billing event "${e.type}".`);
  }
}

export interface PayrollEventInput {
  id: number;
  type: string;
  aggregateId: number;
  payload: Record<string, unknown>;
  /** Academy-zone date of `occurred_at`. */
  date: string;
}

interface SlipLine {
  code: string;
  sign: number;
  amount: string;
}

/** The account a payslip line posts to (earnings → salary expense; deductions by kind). */
function slipLineAccount(code: string): SystemAccountKey {
  if (code === 'fine' || code === 'fine_reduction') return 'fines_income';
  if (code === 'advance') return 'staff_advances';
  if (code === 'tax') return 'tax_payable';
  return 'salaries_expense';
}

/** Approved payslip: Dr expense (earnings), Cr deductions by kind, Cr the teacher wallet (net). */
function payslipLines(payload: Record<string, unknown>, slipId: number): DraftLine[] {
  const userId = Number(payload.userId);
  const lines = (Array.isArray(payload.lines) ? payload.lines : []) as SlipLine[];
  const byKey = new Map<string, DraftLine>();
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    const amount = cents(l.amount);
    if (amount <= 0) continue;
    const key = slipLineAccount(l.code);
    const side = l.sign > 0 ? 'debit' : 'credit';
    const k = `${key}:${side}`;
    const row = byKey.get(k) ?? { key, debit: 0, credit: 0 };
    row[side] += amount;
    byKey.set(k, row);
    if (side === 'debit') debit += amount;
    else credit += amount;
  }
  const net = cents(payload.net as string);
  if (debit - credit !== net) {
    throw new PostingRuleError(
      `Payslip ${slipId}: lines (${debit} − ${credit}) do not match the net ${net}.`,
    );
  }
  // Same account on both sides (e.g. leave deduction against salaries) nets to one line.
  const merged = new Map<SystemAccountKey, number>();
  for (const row of byKey.values()) {
    merged.set(row.key, (merged.get(row.key) ?? 0) + row.debit - row.credit);
  }
  const out: DraftLine[] = [];
  for (const [key, signed] of merged) {
    if (signed > 0) out.push(dr(key, signed));
    else if (signed < 0) out.push(cr(key, -signed));
  }
  if (net > 0) out.push(cr('salaries_payable', net, { partyType: 'user', partyId: userId }));
  if (net < 0) throw new PostingRuleError(`Payslip ${slipId}: negative net ${net}.`);
  return out;
}

const swap = (lines: DraftLine[]): DraftLine[] =>
  lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));

/** `payroll_events` → entry (D95). */
export function payrollEntry(e: PayrollEventInput): DraftEntry | null {
  const p = e.payload;
  const currency = str(p.currency);
  const period = str(p.period);
  switch (e.type) {
    case 'payslip.approved': {
      const lines = payslipLines(p, e.aggregateId);
      if (lines.length === 0) return null;
      return {
        date: e.date,
        currency,
        memo: `Payslip #${e.aggregateId} ${period} approved`,
        lines,
      };
    }
    case 'payslip.reversed': {
      const lines = payslipLines(p, e.aggregateId);
      if (lines.length === 0) return null;
      return {
        date: e.date,
        currency,
        memo: `Payslip #${e.aggregateId} ${period} reopened`,
        lines: swap(lines),
      };
    }
    case 'payslip.paid': {
      const net = cents(p.net as string);
      if (net <= 0) return null;
      const method = str(p.method, 'other');
      const ref = typeof p.reference === 'string' && p.reference ? ` ${p.reference}` : '';
      return {
        date: typeof p.paidOn === 'string' ? p.paidOn : e.date,
        currency,
        memo: `Payslip #${e.aggregateId} ${period} paid (${method}${ref})`,
        lines: [
          dr('salaries_payable', net, { partyType: 'user', partyId: Number(p.userId) }),
          cr(payoutAccount(method), net),
        ],
      };
    }
    case 'payroll_run.approved':
    case 'payroll_run.reopened':
    case 'payroll_run.paid':
      return null;
    default:
      throw new PostingRuleError(`No posting rule for payroll event "${e.type}".`);
  }
}
