import {
  fromMinor,
  isOpenInvoice,
  percentOf,
  prorate,
  toMinor,
  type BillingSettingsDto,
  type Currency,
  type FamilyFeeDto,
  type FeeLineDto,
  type InvoiceKind,
  type InvoiceLineType,
  type InvoiceStatus,
  type PaymentMethod,
  type PaymentStatus,
} from '@qarabic/shared';
import { addDays, dateKeyIn } from '@/lib/schedule-time';
import { db as people } from './people-db';

/**
 * Fake billing data for the mocks (N6): fee packages with prices per currency, a billing profile
 * per family, invoices in every status (draft, issued, overdue, partially paid, paid, void, split)
 * and their payments. Amounts are integer minor units inside the mock, decimal strings on the wire
 * (as the API). Dates are built from today's academy date when the data is (re)built, so "overdue"
 * and "due soon" always exist. Made-up families from people-db only.
 */
export const ACADEMY_TZ = 'Africa/Cairo';
export const ADMIN = { id: 1, name: 'مدير النظام' };

export interface PackageRow {
  id: number;
  name: string;
  classesPerWeek: number;
  sessionMinutes: number;
  description: string | null;
  isActive: boolean;
  /** Currency → minor units. */
  prices: Partial<Record<Currency, number>>;
}

export interface ProfileRow {
  currency: Currency | null;
  billingDay: 1 | 15;
  enabled: boolean;
  customFeeMinor: number | null;
  startsOn: string | null;
}

export interface LineRow {
  id: number;
  type: InvoiceLineType;
  studentId: number | null;
  description: string;
  amountMinor: number;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface InvoiceRow {
  id: number;
  number: string | null;
  kind: InvoiceKind;
  status: InvoiceStatus;
  familyId: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  issueDate: string | null;
  dueDate: string | null;
  notes: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  splitFromId: number | null;
  paidAt: string | null;
  createdAt: string;
  lines: LineRow[];
}

export interface PaymentRow {
  id: number;
  invoiceId: number;
  method: PaymentMethod;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  reference: string | null;
  note: string | null;
  receivedAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  receiptNumber: string | null;
  failureReason: string | null;
  providerPaymentId: string | null;
  providerRef: string | null;
  recordedBy: { id: number; name: string } | null;
}

export interface BillingDb {
  packages: PackageRow[];
  profiles: Map<number, ProfileRow>;
  /** Student id → fee package id. */
  studentPackages: Map<number, number | null>;
  invoices: InvoiceRow[];
  payments: PaymentRow[];
  settings: BillingSettingsDto;
  /** Online providers the mock reports as configured (tests can switch one off). */
  online: ('stripe' | 'paypal')[];
  /** Invoice id → last manual reminder (ms). */
  reminded: Map<number, number>;
  next: { invoice: number; line: number; payment: number; package: number; receipt: number };
  /** Year → last invoice number. */
  numbers: Map<number, number>;
}

export const BILLING_DEFAULTS: BillingSettingsDto = {
  'billing.deducting_stages': ['taken', 'absent', 'declined'],
  'billing.reminder_days': [-3, 0, 3, 7],
  'billing.default_due_days': 7,
  'billing.notify_parents': false,
};

const COUNTRY_CURRENCY: Record<string, Currency> = {
  US: 'USD',
  GB: 'GBP',
  CA: 'CAD',
  AU: 'AUD',
  AE: 'AED',
  DE: 'EUR',
  PK: 'PKR',
  EG: 'EGP',
  SA: 'SAR',
};

/** Today in the academy zone (`YYYY-MM-DD`). */
export const academyToday = () => dateKeyIn(ACADEMY_TZ, new Date());
export const isoNow = () => new Date().toISOString();
export const instantOf = (dateKey: string, hour = 10) =>
  `${dateKey}T${String(hour).padStart(2, '0')}:00:00.000Z`;

/** `YYYY-MM` + billing day → the period `[day, same day next month − 1]` (docs/20 §4.2). */
export function periodOf(month: string, day: 1 | 15) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = `${month}-${String(day).padStart(2, '0')}`;
  const nextStart = new Date(Date.UTC(y, m, day)).toISOString().slice(0, 10);
  const end = addDays(nextStart, -1);
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  return { start, end, days, key: (familyId: number) => `family:${familyId}:${start}` };
}

export const monthOf = (dateKey: string) => dateKey.slice(0, 7);
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

/** Active children of a family (an inactive child is not billed, D125). */
export const childrenOf = (familyId: number) =>
  people.students.filter((s) => s.familyId === familyId && s.status.value !== 'inactive');

/** The monthly fee of a family for a period (D84, D85): custom fee, else the children's packages. */
export function feeFor(
  bdb: BillingDb,
  familyId: number,
  period: ReturnType<typeof periodOf>,
): FamilyFeeDto & { totalMinor: number; lineRows: Omit<LineRow, 'id' | 'createdAt'>[] } {
  const profile = bdb.profiles.get(familyId);
  const currency = profile?.currency ?? null;
  const out = {
    periodStart: period.start,
    periodEnd: period.end,
    currency,
    total: '0.00',
    lines: [] as FeeLineDto[],
    warnings: [] as string[],
    totalMinor: 0,
    lineRows: [] as Omit<LineRow, 'id' | 'createdAt'>[],
  };
  if (!currency) {
    out.warnings.push('missing_currency');
    return out;
  }
  const kids = childrenOf(familyId);
  let rows: (Omit<LineRow, 'id' | 'createdAt'> & { feePackageId: number | null })[] = [];
  if (profile?.customFeeMinor !== null && profile?.customFeeMinor !== undefined) {
    rows.push({
      type: 'package',
      studentId: null,
      feePackageId: null,
      description: 'Monthly fee',
      amountMinor: profile.customFeeMinor,
      meta: { source: 'custom_fee', children: kids.length },
    });
  } else {
    for (const kid of kids) {
      const pkgId = bdb.studentPackages.get(kid.id) ?? null;
      const pkg = bdb.packages.find((p) => p.id === pkgId);
      if (!pkg) {
        out.warnings.push(`no_package:${kid.id}`);
        continue;
      }
      const price = pkg.prices[currency];
      if (price === undefined) {
        out.warnings.push(`missing_price:${kid.id}`);
        continue;
      }
      rows.push({
        type: 'package',
        studentId: kid.id,
        feePackageId: pkg.id,
        description: `${kid.name} — ${pkg.name}`,
        amountMinor: price,
        meta: {
          source: 'package',
          classesPerWeek: pkg.classesPerWeek,
          sessionMinutes: pkg.sessionMinutes,
        },
      });
    }
    if (out.warnings.some((w) => w.startsWith('missing_price'))) return out;
  }
  const start = profile?.startsOn ?? null;
  if (start && start > period.end) {
    out.warnings.push('not_started');
    return out;
  }
  if (start && start > period.start) {
    const remaining = Math.round((Date.parse(period.end) - Date.parse(start)) / 86_400_000) + 1;
    rows = rows.map((r) => ({
      ...r,
      amountMinor: prorate(r.amountMinor, remaining, period.days),
      meta: {
        ...r.meta,
        prorated: true,
        fullAmount: fromMinor(r.amountMinor),
        days: remaining,
        periodDays: period.days,
      },
    }));
  }
  out.totalMinor = rows.reduce((s, r) => s + r.amountMinor, 0);
  out.total = fromMinor(out.totalMinor);
  out.lines = rows.map((r) => ({
    type: r.type,
    studentId: r.studentId,
    feePackageId: r.feePackageId,
    description: r.description,
    amount: fromMinor(r.amountMinor),
    meta: r.meta,
  }));
  out.lineRows = rows.map(({ feePackageId: _f, ...r }) => r);
  if (!rows.length && !out.warnings.length) out.warnings.push('no_fee');
  return out;
}

/** Totals from the lines and the succeeded payments only (docs/20 §4.6). */
export function totalsOf(bdb: BillingDb, inv: InvoiceRow) {
  const sum = (types: InvoiceLineType[]) =>
    inv.lines.filter((l) => types.includes(l.type)).reduce((s, l) => s + l.amountMinor, 0);
  const subtotal = sum(['package', 'manual', 'split']);
  const adjustments = sum(['adjustment']);
  const discounts = sum(['discount']);
  const total = subtotal + adjustments + discounts;
  const paid = bdb.payments
    .filter((p) => p.invoiceId === inv.id && p.status === 'succeeded')
    .reduce((s, p) => s + p.amountMinor, 0);
  return { subtotal, adjustments, discounts, total, paid, balance: total - paid };
}

/** Status after a change (docs/20 §4.6); draft, void and split stay as they are. */
export function recalculate(bdb: BillingDb, inv: InvoiceRow) {
  if (!isOpenInvoice(inv.status) && inv.status !== 'paid') return;
  const t = totalsOf(bdb, inv);
  if (t.paid >= t.total && (t.total > 0 || t.paid === 0)) {
    if (inv.status !== 'paid') inv.paidAt = isoNow();
    inv.status = 'paid';
  } else if (t.paid > 0) {
    inv.status = 'partially_paid';
    inv.paidAt = null;
  } else {
    inv.status = 'issued';
    inv.paidAt = null;
  }
}

export function nextNumber(bdb: BillingDb, dateKey: string): string {
  const year = Number(dateKey.slice(0, 4));
  const n = (bdb.numbers.get(year) ?? 0) + 1;
  bdb.numbers.set(year, n);
  return `INV-${year}-${String(n).padStart(6, '0')}`;
}

export function nextReceipt(bdb: BillingDb): string {
  bdb.next.receipt += 1;
  return `RC-${String(bdb.next.receipt).padStart(6, '0')}`;
}

export const isOverdue = (inv: Pick<InvoiceRow, 'status' | 'dueDate'>, today = academyToday()) =>
  isOpenInvoice(inv.status) && !!inv.dueDate && inv.dueDate < today;

function build(): BillingDb {
  const today = academyToday();
  const thisMonth = monthOf(today);
  const lastMonth = shiftMonth(thisMonth, -1);
  const bdb: BillingDb = {
    packages: [
      {
        id: 1,
        name: 'باقة يومين',
        classesPerWeek: 2,
        sessionMinutes: 30,
        description: 'حصتان أسبوعيًّا',
        isActive: true,
        prices: {
          USD: 6000,
          GBP: 4800,
          CAD: 8000,
          AUD: 9000,
          AED: 22000,
          EUR: 5500,
          PKR: 900000,
          EGP: 150000,
        },
      },
      {
        id: 2,
        name: 'باقة ثلاثة أيام',
        classesPerWeek: 3,
        sessionMinutes: 30,
        description: null,
        isActive: true,
        prices: { USD: 8500, GBP: 6800, CAD: 11000, AED: 31000, EUR: 7800 },
      },
      {
        id: 3,
        name: 'باقة أربعة أيام',
        classesPerWeek: 4,
        sessionMinutes: 45,
        description: null,
        isActive: true,
        prices: { USD: 12000, GBP: 9600 },
      },
      {
        id: 4,
        name: 'باقة يوم واحد (قديمة)',
        classesPerWeek: 1,
        sessionMinutes: 30,
        description: null,
        isActive: false,
        prices: { USD: 3500 },
      },
    ],
    profiles: new Map(),
    studentPackages: new Map(),
    invoices: [],
    payments: [],
    settings: structuredClone(BILLING_DEFAULTS),
    online: ['stripe', 'paypal'],
    reminded: new Map(),
    next: { invoice: 1, line: 1, payment: 1, package: 5, receipt: 0 },
    numbers: new Map(),
  };

  for (const f of people.families) {
    bdb.profiles.set(f.id, {
      currency: f.id === 7 ? null : (COUNTRY_CURRENCY[f.countryCode ?? ''] ?? 'USD'),
      billingDay: f.id === 12 ? 15 : 1,
      enabled: f.id !== 10 && f.status.value === 'regular' && !f.archive,
      customFeeMinor: f.id === 5 ? 20000 : null,
      startsOn: f.id === 16 ? `${shiftMonth(thisMonth, 1)}-10` : null,
    });
    childrenOf(f.id).forEach((kid, index) => {
      bdb.studentPackages.set(kid.id, f.id === 9 && index === 0 ? null : index % 2 ? 2 : 1);
    });
  }

  const add = (
    familyId: number,
    opts: {
      kind?: InvoiceKind;
      status: InvoiceStatus;
      month?: string;
      issue?: string;
      due?: string | null;
      lines?: Omit<LineRow, 'id' | 'createdAt'>[];
      notes?: string | null;
    },
  ): InvoiceRow => {
    const kind = opts.kind ?? 'monthly';
    const period = opts.month && kind === 'monthly' ? periodOf(opts.month, 1) : null;
    const fee = period ? feeFor(bdb, familyId, period) : null;
    const issue = opts.status === 'draft' ? null : (opts.issue ?? today);
    const inv: InvoiceRow = {
      id: bdb.next.invoice++,
      number: opts.status === 'draft' ? null : nextNumber(bdb, issue ?? today),
      kind,
      status: opts.status,
      familyId,
      currency: fee?.currency ?? bdb.profiles.get(familyId)?.currency ?? 'USD',
      periodStart: period?.start ?? null,
      periodEnd: period?.end ?? null,
      issueDate: issue,
      dueDate: opts.due === undefined ? addDays(issue ?? today, 7) : opts.due,
      notes: opts.notes ?? null,
      voidReason: null,
      voidedAt: null,
      splitFromId: null,
      paidAt: null,
      createdAt: instantOf(issue ?? today, 8),
      lines: [],
    };
    for (const l of opts.lines ?? fee?.lineRows ?? []) {
      inv.lines.push({ ...l, id: bdb.next.line++, createdAt: inv.createdAt });
    }
    bdb.invoices.push(inv);
    return inv;
  };
  const pay = (
    inv: InvoiceRow,
    method: PaymentMethod,
    amountMinor: number,
    day: string,
    extra: Partial<PaymentRow> = {},
  ) => {
    const row: PaymentRow = {
      id: bdb.next.payment++,
      invoiceId: inv.id,
      method,
      status: 'succeeded',
      amountMinor,
      currency: inv.currency,
      reference: null,
      note: null,
      receivedAt: instantOf(day, 11),
      refundedAt: null,
      createdAt: instantOf(day, 11),
      receiptNumber: nextReceipt(bdb),
      failureReason: null,
      providerPaymentId: null,
      providerRef: null,
      recordedBy: method === 'stripe' || method === 'paypal' ? null : ADMIN,
      ...extra,
    };
    bdb.payments.push(row);
    recalculate(bdb, inv);
    return row;
  };

  // 1–2: the demo parent's family: this month open (due in 5 days), last month paid by card.
  add(1, { status: 'issued', month: thisMonth, due: addDays(today, 5), issue: addDays(today, -2) });
  const lastPaid = add(1, {
    status: 'issued',
    month: lastMonth,
    issue: `${lastMonth}-01`,
    due: `${lastMonth}-08`,
  });
  pay(lastPaid, 'stripe', totalsOf(bdb, lastPaid).total, `${lastMonth}-04`, {
    providerPaymentId: 'pi_mock_0001',
    providerRef: 'cs_test_mock_0001',
  });
  // 3: overdue (due 5 days ago).
  add(2, {
    status: 'issued',
    month: thisMonth,
    issue: addDays(today, -12),
    due: addDays(today, -5),
  });
  // 4: partially paid by bank transfer.
  const partial = add(3, { status: 'issued', month: thisMonth, issue: addDays(today, -3) });
  pay(partial, 'bank_transfer', 5000, addDays(today, -1), { reference: 'TRX-55012' });
  // 5: a manual draft (customer service).
  add(6, {
    kind: 'manual',
    status: 'draft',
    due: addDays(today, 14),
    notes: 'كتاب التجويد للمستوى الأول',
    lines: [
      {
        type: 'manual',
        studentId: null,
        description: 'كتاب التجويد',
        amountMinor: 2500,
        meta: null,
      },
    ],
  });
  // 6: void with its reason.
  const voided = add(6, { status: 'issued', month: thisMonth, issue: addDays(today, -4) });
  voided.status = 'void';
  voided.voidReason = 'أُصدرت بالخطأ قبل تحديث الباقة.';
  voided.voidedAt = instantOf(addDays(today, -3), 9);
  // 7 → 8, 9: last month split into two instalments.
  const original = add(8, {
    status: 'issued',
    month: lastMonth,
    issue: `${lastMonth}-01`,
    due: `${lastMonth}-08`,
  });
  original.status = 'split';
  const total = totalsOf(bdb, original).total;
  const half = Math.floor(total / 2);
  [half, total - half].forEach((amount, i) => {
    const part = add(8, {
      kind: 'split',
      status: 'issued',
      issue: `${lastMonth}-03`,
      due: i === 0 ? addDays(today, 3) : addDays(today, 33),
      notes: 'تقسيط بطلب ولي الأمر',
      lines: [
        {
          type: 'split',
          studentId: null,
          description: `Part ${i + 1} of 2 of invoice ${original.number}`,
          amountMinor: amount,
          meta: { splitFrom: original.number, part: i + 1, parts: 2 },
        },
      ],
    });
    part.splitFromId = original.id;
  });
  // 10: paid in cash.
  const cash = add(13, { status: 'issued', month: thisMonth, issue: addDays(today, -6) });
  pay(cash, 'cash', totalsOf(bdb, cash).total, addDays(today, -2), { note: 'استُلمت في المكتب' });
  // 11: a 10 % discount.
  const discounted = add(15, { status: 'issued', month: thisMonth, due: addDays(today, 10) });
  discounted.lines.push({
    id: bdb.next.line++,
    type: 'discount',
    studentId: null,
    description: 'خصم الأخوة',
    amountMinor: -percentOf(totalsOf(bdb, discounted).total, '10'),
    meta: { percent: '10.00' },
    createdAt: instantOf(today, 9),
  });
  // 12: overdue with an adjustment.
  const adjusted = add(5, {
    status: 'issued',
    month: thisMonth,
    issue: addDays(today, -10),
    due: addDays(today, -2),
  });
  adjusted.lines.push({
    id: bdb.next.line++,
    type: 'adjustment',
    studentId: null,
    description: 'حصة إضافية في الأسبوع الأول',
    amountMinor: toMinor('10.00'),
    meta: null,
    createdAt: instantOf(addDays(today, -9), 9),
  });
  return bdb;
}

export let bdb: BillingDb = undefined as unknown as BillingDb;
resetBillingDb();

export function resetBillingDb() {
  bdb = build();
}
