import {
  DEBIT_NORMAL,
  fromMinor,
  toMinor,
  type AccountingPeriodDto,
  type JournalEntryDto,
  type JournalSource,
  type LedgerAccountDto,
  type OutboxSource,
  type VoucherDto,
  type VoucherType,
} from '@qarabic/shared';
import { addDays, dateKeyIn } from '@/lib/schedule-time';
import { CHART } from './accounting-chart';

/**
 * The mock ledger for M7 (apps/api `accounting/`): the seeded chart, a few months of entries in
 * USD and EGP (opening capital, tuition invoices and payments from the billing outbox, salaries
 * and payouts from the payroll outbox, vouchers), one closed month and a small outbox backlog.
 * Amounts are integer minor units here; the handlers present decimal strings. Fake data only.
 */
export type AccountRow = LedgerAccountDto;
export type LineRow = {
  id: number;
  accountId: number;
  debit: number;
  credit: number;
  description: string | null;
};
export type EntryRow = {
  id: number;
  number: string;
  date: string;
  currency: string;
  memo: string;
  source: JournalSource;
  sourceRef: string | null;
  reversesId: number | null;
  reversedById: number | null;
  voucherId: number | null;
  createdBy: { id: number; name: string } | null;
  createdAt: string;
  lines: LineRow[];
};
export type VoucherRow = {
  id: number;
  number: string;
  type: VoucherType;
  status: 'posted' | 'void';
  date: string;
  currency: string;
  party: string;
  description: string;
  reference: string | null;
  chequeNumber: string | null;
  cashAccountId: number;
  lines: { accountId: number; amount: number; description: string | null }[];
  journalEntryId: number;
  voidEntryId: number | null;
  voidReason: string | null;
  voidedAt: string | null;
  createdBy: { id: number; name: string } | null;
  createdAt: string;
};
export type PeriodRow = {
  period: string;
  closed: boolean;
  closedAt: string | null;
  closedBy: { id: number; name: string } | null;
  reopenReason: string | null;
};
export type OutboxRow = {
  source: OutboxSource;
  eventId: number;
  eventType: string;
  createdAt: string;
  /** What it posts when processed. */
  plan: { date: string; currency: string; memo: string; lines: [string, number, number][] };
  error: string | null;
  attempts: number;
  lastAttemptAt: string | null;
};

export const ACADEMY_TZ = 'Africa/Cairo';
export const ADMIN_REF = { id: 1, name: 'مدير النظام' };
export const academyToday = () => dateKeyIn(ACADEMY_TZ, new Date());

type Db = {
  accounts: AccountRow[];
  entries: EntryRow[];
  vouchers: VoucherRow[];
  periods: PeriodRow[];
  outbox: OutboxRow[];
  seq: { account: number; entry: number; line: number; voucher: number; event: number };
};

const empty = (): Db => ({
  accounts: [],
  entries: [],
  vouchers: [],
  periods: [],
  outbox: [],
  seq: { account: 0, entry: 0, line: 0, voucher: 0, event: 0 },
});

export let adb: Db = empty();

export function resetAccountingDb() {
  adb = build();
}

export const accountByCode = (code: string) => adb.accounts.find((a) => a.code === code)!;
export const accountById = (id: number) => adb.accounts.find((a) => a.id === id);
export const periodOf = (date: string) => date.slice(0, 7);
export const isClosed = (date: string) =>
  adb.periods.some((p) => p.period === periodOf(date) && p.closed);

/** Next number per year: `JE-2026-00012`, `RV-2026-0003` (receipt), `PV-2026-0004` (payment). */
function nextNumber(prefix: string, date: string, existing: { number: string }[], pad: number) {
  const year = date.slice(0, 4);
  const n = existing.filter((x) => x.number.startsWith(`${prefix}-${year}-`)).length + 1;
  return `${prefix}-${year}-${String(n).padStart(pad, '0')}`;
}

/** Posts a balanced entry (lines as `[account code, debit minor, credit minor]` or ids). */
export function postEntry(input: {
  date: string;
  currency: string;
  memo: string;
  source: JournalSource;
  sourceRef?: string | null;
  reversesId?: number | null;
  voucherId?: number | null;
  createdBy?: { id: number; name: string } | null;
  lines: { accountId: number; debit: number; credit: number; description?: string | null }[];
}): EntryRow {
  const row: EntryRow = {
    id: ++adb.seq.entry,
    number: nextNumber('JE', input.date, adb.entries, 5),
    date: input.date,
    currency: input.currency,
    memo: input.memo,
    source: input.source,
    sourceRef: input.sourceRef ?? null,
    reversesId: input.reversesId ?? null,
    reversedById: null,
    voucherId: input.voucherId ?? null,
    createdBy: input.createdBy ?? null,
    createdAt: new Date().toISOString(),
    lines: input.lines.map((l) => ({
      id: ++adb.seq.line,
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      description: l.description ?? null,
    })),
  };
  adb.entries.push(row);
  return row;
}

const byCode = (lines: [string, number, number][]) =>
  lines.map(([code, debit, credit]) => ({ accountId: accountByCode(code).id, debit, credit }));

export function reverseEntry(
  entry: EntryRow,
  date: string,
  memo: string,
  by: { id: number; name: string } | null,
) {
  const rev = postEntry({
    date,
    currency: entry.currency,
    memo,
    source: 'reversal',
    sourceRef: `journal_entry:${entry.id}`,
    reversesId: entry.id,
    voucherId: entry.voucherId,
    createdBy: by,
    lines: entry.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      description: l.description,
    })),
  });
  entry.reversedById = rev.id;
  return rev;
}

export function postVoucher(
  v: Omit<
    VoucherRow,
    | 'id'
    | 'number'
    | 'journalEntryId'
    | 'voidEntryId'
    | 'voidReason'
    | 'voidedAt'
    | 'createdAt'
    | 'status'
  >,
): VoucherRow {
  const id = ++adb.seq.voucher;
  const total = v.lines.reduce((s, l) => s + l.amount, 0);
  const receipt = v.type === 'receipt';
  const entry = postEntry({
    date: v.date,
    currency: v.currency,
    memo: `${receipt ? 'سند قبض' : 'سند صرف'}: ${v.description}`,
    source: 'voucher',
    sourceRef: `voucher:${id}`,
    voucherId: id,
    createdBy: v.createdBy,
    lines: [
      { accountId: v.cashAccountId, debit: receipt ? total : 0, credit: receipt ? 0 : total },
      ...v.lines.map((l) => ({
        accountId: l.accountId,
        debit: receipt ? 0 : l.amount,
        credit: receipt ? l.amount : 0,
        description: l.description,
      })),
    ],
  });
  const row: VoucherRow = {
    ...v,
    id,
    number: nextNumber(
      receipt ? 'RV' : 'PV',
      v.date,
      adb.vouchers.filter((x) => x.type === v.type),
      4,
    ),
    status: 'posted',
    journalEntryId: entry.id,
    voidEntryId: null,
    voidReason: null,
    voidedAt: null,
    createdAt: new Date().toISOString(),
  };
  adb.vouchers.push(row);
  return row;
}

export function processOutboxRow(o: OutboxRow) {
  postEntry({
    date: o.plan.date,
    currency: o.plan.currency,
    memo: o.plan.memo,
    source: o.source,
    sourceRef: `${o.source}_event:${o.eventId}`,
    lines: byCode(o.plan.lines),
  });
}

// ------------------------------------------------------------------ presenters

export function presentEntry(e: EntryRow, withLines = true): JournalEntryDto {
  const total = e.lines.reduce((s, l) => s + l.debit, 0);
  const base = {
    id: e.id,
    number: e.number,
    date: e.date,
    currency: e.currency,
    memo: e.memo,
    source: e.source,
    sourceRef: e.sourceRef,
    reversesId: e.reversesId,
    reversedById: e.reversedById,
    voucherId: e.voucherId,
    total: fromMinor(total),
    createdBy: e.createdBy,
    createdAt: e.createdAt,
  };
  if (!withLines) return base as JournalEntryDto;
  return {
    ...base,
    lines: e.lines.map((l) => {
      const a = accountById(l.accountId)!;
      return {
        id: l.id,
        accountId: a.id,
        accountCode: a.code,
        accountNameAr: a.nameAr,
        accountNameEn: a.nameEn,
        debit: fromMinor(l.debit),
        credit: fromMinor(l.credit),
        description: l.description,
        partyType: null,
        partyId: null,
      };
    }),
  };
}

export function presentVoucher(v: VoucherRow, withLines = true): VoucherDto {
  const cash = accountById(v.cashAccountId)!;
  const base = {
    id: v.id,
    number: v.number,
    type: v.type,
    status: v.status,
    date: v.date,
    currency: v.currency,
    amount: fromMinor(v.lines.reduce((s, l) => s + l.amount, 0)),
    party: v.party,
    description: v.description,
    reference: v.reference,
    chequeNumber: v.chequeNumber,
    cashAccount: { id: cash.id, code: cash.code, nameAr: cash.nameAr, nameEn: cash.nameEn },
    journalEntryId: v.journalEntryId,
    voidEntryId: v.voidEntryId,
    voidReason: v.voidReason,
    voidedAt: v.voidedAt,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
  };
  if (!withLines) return base as VoucherDto;
  return {
    ...base,
    lines: v.lines.map((l) => {
      const a = accountById(l.accountId)!;
      return {
        accountId: a.id,
        accountCode: a.code,
        accountNameAr: a.nameAr,
        accountNameEn: a.nameEn,
        amount: fromMinor(l.amount),
        description: l.description,
      };
    }),
  };
}

export function presentPeriods(year: number): AccountingPeriodDto[] {
  return Array.from({ length: 12 }, (_, i) => {
    const period = `${year}-${String(i + 1).padStart(2, '0')}`;
    const row = adb.periods.find((p) => p.period === period);
    return {
      period,
      status: row?.closed ? 'closed' : 'open',
      closedAt: row?.closed ? row.closedAt : null,
      closedBy: row?.closed ? row.closedBy : null,
      reopenReason: row?.reopenReason ?? null,
      entries: adb.entries.filter((e) => periodOf(e.date) === period).length,
    };
  });
}

// ------------------------------------------------------------------ balances

/** Debit − credit of an account (and its sub-accounts) in a currency within [from, to]. */
export function movement(
  accountIds: Set<number>,
  currency: string | null,
  from: string | null,
  to: string,
) {
  let debit = 0;
  let credit = 0;
  for (const e of adb.entries) {
    if (currency && e.currency !== currency) continue;
    if (e.date > to || (from && e.date < from)) continue;
    for (const l of e.lines) {
      if (!accountIds.has(l.accountId)) continue;
      debit += l.debit;
      credit += l.credit;
    }
  }
  return { debit, credit };
}

export const debitNormal = (a: { type: AccountRow['type'] }) => DEBIT_NORMAL.includes(a.type);

/** The account and every descendant (a group's report line covers its sub-accounts). */
export function subtree(id: number): Set<number> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of adb.accounts) {
      if (a.parentId && out.has(a.parentId) && !out.has(a.id)) {
        out.add(a.id);
        grew = true;
      }
    }
  }
  return out;
}

export const toM = toMinor;

// ------------------------------------------------------------------ seed

function build(): Db {
  const db = empty();
  adb = db;
  for (const r of CHART) {
    db.accounts.push({
      id: ++db.seq.account,
      code: r.code,
      nameAr: r.nameAr,
      nameEn: r.nameEn,
      type: r.type,
      parentId: r.parent ? db.accounts.find((a) => a.code === r.parent)!.id : null,
      isGroup: !!r.group,
      isCash: !!r.cash,
      currency: null,
      systemKey: r.key ?? null,
      isActive: true,
      description: null,
    });
  }
  // One archived head, so the «المؤرشفة» filter has something to show.
  const goodwill = db.accounts.find((a) => a.code === '1530');
  if (goodwill) goodwill.isActive = false;

  const today = academyToday();
  const month = (back: number) => {
    const [y, m] = today.split('-').map(Number) as [number, number];
    const d = new Date(Date.UTC(y, m - 1 - back, 1));
    return d.toISOString().slice(0, 7);
  };
  const day = (back: number, d: number) => `${month(back)}-${String(d).padStart(2, '0')}`;
  const e = (
    date: string,
    currency: string,
    memo: string,
    source: JournalSource,
    lines: [string, number, number][],
    ref: string | null = null,
  ) =>
    postEntry({
      date,
      currency,
      memo,
      source,
      sourceRef: ref,
      createdBy: source === 'manual' ? ADMIN_REF : null,
      lines: byCode(lines),
    });

  let ev = 100;
  e(day(3, 1), 'USD', 'رصيد افتتاحي: رأس المال في البنك', 'manual', [
    ['1120', 2_000_000, 0],
    ['3100', 0, 2_000_000],
  ]);
  e(day(3, 1), 'EGP', 'رصيد افتتاحي: النقدية بالصندوق', 'manual', [
    ['1110', 5_000_000, 0],
    ['3300', 0, 5_000_000],
  ]);
  for (const back of [3, 2, 1, 0]) {
    const invoices = 1_840_000 - back * 60_000;
    e(
      day(back, 1),
      'USD',
      `فواتير شهر ${month(back)}`,
      'billing',
      [
        ['1210', invoices, 0],
        ['4100', 0, invoices],
      ],
      `billing_event:${++ev}`,
    );
    if (back > 0 || Number(today.slice(8)) > 5) {
      e(
        day(back, 5),
        'USD',
        `مدفوعات Stripe لفواتير ${month(back)}`,
        'billing',
        [
          ['1130', invoices - 220_000, 0],
          ['1210', 0, invoices - 220_000],
        ],
        `billing_event:${++ev}`,
      );
    }
    if (back > 0) {
      e(
        day(back, 28),
        'EGP',
        `رواتب المعلمين ${month(back)}`,
        'payroll',
        [
          ['5110', 18_500_000, 0],
          ['2110', 0, 18_500_000],
        ],
        `payroll_event:${++ev}`,
      );
      e(
        day(back, 28),
        'EGP',
        `صرف رواتب ${month(back)} عبر فودافون كاش`,
        'payroll',
        [
          ['2110', 18_500_000, 0],
          ['1150', 0, 18_500_000],
        ],
        `payroll_event:${++ev}`,
      );
      e(day(back, 25), 'USD', `تحويل من Stripe إلى البنك`, 'manual', [
        ['1120', 1_500_000, 0],
        ['1130', 0, 1_500_000],
      ]);
      e(day(back, 26), 'EGP', 'تمويل المحفظة لصرف الرواتب', 'manual', [
        ['1150', 18_500_000, 0],
        ['3100', 0, 18_500_000],
      ]);
    }
  }
  const expense = (code: string) => db.accounts.find((a) => a.code === code)?.id;
  const firstExpense = (prefix: string) =>
    db.accounts.find((a) => a.code.startsWith(prefix) && !a.isGroup && a.type === 'expense')!.id;
  for (const back of [2, 1, 0]) {
    postVoucher({
      type: 'payment',
      date: day(back, 10),
      currency: 'USD',
      cashAccountId: accountByCode('1120').id,
      party: 'Zoom Video Communications',
      description: `اشتراك Zoom لشهر ${month(back)}`,
      reference: `INV-Z-${back + 40}`,
      chequeNumber: null,
      createdBy: ADMIN_REF,
      lines: [
        { accountId: expense('5150') ?? firstExpense('51'), amount: 149_00, description: null },
      ],
    });
  }
  postVoucher({
    type: 'receipt',
    date: day(1, 12),
    currency: 'EGP',
    cashAccountId: accountByCode('1110').id,
    party: 'Ahmed Samir',
    description: 'استرداد سلفة',
    reference: null,
    chequeNumber: null,
    createdBy: ADMIN_REF,
    lines: [{ accountId: accountByCode('1310').id, amount: 250_000, description: null }],
  });
  const voided = postVoucher({
    type: 'payment',
    date: day(1, 14),
    currency: 'EGP',
    cashAccountId: accountByCode('1110').id,
    party: 'Office Supplies Co.',
    description: 'أدوات مكتبية (مكررة)',
    reference: 'OS-118',
    chequeNumber: null,
    createdBy: ADMIN_REF,
    lines: [
      { accountId: expense('5215') ?? firstExpense('52'), amount: 80_000, description: null },
    ],
  });
  const rev = reverseEntry(
    db.entries.find((x) => x.id === voided.journalEntryId)!,
    day(1, 15),
    `إلغاء السند ${voided.number}: مسجل مرتين`,
    ADMIN_REF,
  );
  voided.status = 'void';
  voided.voidEntryId = rev.id;
  voided.voidReason = 'مسجل مرتين';
  voided.voidedAt = `${day(1, 15)}T10:00:00.000Z`;

  db.periods.push({
    period: month(3),
    closed: true,
    closedAt: `${day(2, 3)}T09:00:00.000Z`,
    closedBy: ADMIN_REF,
    reopenReason: null,
  });
  db.outbox.push(
    {
      source: 'billing',
      eventId: ++ev,
      eventType: 'payment.succeeded',
      createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      plan: {
        date: today,
        currency: 'USD',
        memo: 'دفعة PayPal لفاتورة',
        lines: [
          ['1140', 60_00, 0],
          ['1210', 0, 60_00],
        ],
      },
      error: null,
      attempts: 0,
      lastAttemptAt: null,
    },
    {
      source: 'payroll',
      eventId: ++ev,
      eventType: 'adjustment.approved',
      createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      plan: {
        date: addDays(today, -1),
        currency: 'EGP',
        memo: 'جزاء معتمد',
        lines: [
          ['2110', 20_000, 0],
          ['4200', 0, 20_000],
        ],
      },
      error: 'No open salary payable balance for this teacher.',
      attempts: 3,
      lastAttemptAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
  );
  db.seq.event = ev;
  return db;
}

resetAccountingDb();
