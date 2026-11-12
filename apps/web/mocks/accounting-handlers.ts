import {
  ACCOUNTING_ERROR_MESSAGES,
  accountListQuerySchema,
  accountStatementQuerySchema,
  cashReportQuerySchema,
  createAccountSchema,
  createJournalEntrySchema,
  createVoucherSchema,
  fromMinor,
  JOURNAL_SOURCES,
  journalListQuerySchema,
  periodListQuerySchema,
  reopenPeriodSchema,
  reportAsOfQuerySchema,
  reportRangeQuerySchema,
  reverseEntrySchema,
  toMinor,
  updateAccountSchema,
  voidVoucherSchema,
  voucherListQuerySchema,
  type AccountingErrorCode,
  type AccountType,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { addDays } from '@/lib/schedule-time';
import type { MockUser } from './data';
import {
  academyToday,
  accountById,
  adb,
  debitNormal,
  isClosed,
  movement,
  periodOf,
  postEntry,
  postVoucher,
  presentEntry,
  presentPeriods,
  presentVoucher,
  processOutboxRow,
  reverseEntry,
  subtree,
  type AccountRow,
} from './accounting-db';
import { paginate, queryOf } from './schedule-handlers';
import { apiError, guard, notFound, validationFailed } from './session';

/**
 * MSW handlers for M7 (apps/api `accounting.controllers.ts`): accounts, journal, vouchers,
 * periods, outbox and reports, with the same permissions (`accounting.view` reads,
 * `accounting.manage` writes) and refusal codes. Fake data only.
 */
const API = '*/api/v1/accounting';
const ref = (me: MockUser) => ({ id: me.id, name: me.name });
const refuse = (code: AccountingErrorCode, status = 422) =>
  apiError(status, code, ACCOUNTING_ERROR_MESSAGES[code].en);

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
const idOf = (params: Record<string, unknown>) => Number(params.id);
const postable = (a: AccountRow | undefined) => !!a && a.isActive && !a.isGroup;

/** The first refusal of a set of lines for a date and currency, or null. */
function lineProblem(date: string, currency: string, accountIds: number[]) {
  for (const id of accountIds) {
    const a = accountById(id);
    if (!postable(a)) return refuse('account_not_postable');
    if (a!.currency && a!.currency !== currency) return refuse('account_currency');
  }
  if (isClosed(date)) return refuse('period_closed');
  return null;
}

const reportAccount = (a: AccountRow) => ({
  id: a.id,
  code: a.code,
  nameAr: a.nameAr,
  nameEn: a.nameEn,
  type: a.type,
  parentId: a.parentId,
});
const leaves = () => adb.accounts.filter((a) => !a.isGroup);
const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code);

/** One report section: non-zero leaf amounts in the type's normal direction, as of [from, to]. */
function section(type: AccountType, currency: string, from: string | null, to: string) {
  const rows = leaves()
    .filter((a) => a.type === type)
    .map((a) => {
      const m = movement(new Set([a.id]), currency, from, to);
      const amount = debitNormal(a) ? m.debit - m.credit : m.credit - m.debit;
      return { a, amount };
    })
    .filter((r) => r.amount !== 0)
    .sort((x, y) => byCode(x.a, y.a));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return {
    out: {
      type,
      rows: rows.map((r) => ({ ...reportAccount(r.a), amount: fromMinor(r.amount) })),
      total: fromMinor(total),
    },
    total,
  };
}

const split = (net: number) => ({ d: net > 0 ? net : 0, c: net < 0 ? -net : 0 });

export const accountingHandlers: HttpHandler[] = [
  // ---------------------------------------------------------------- accounts
  http.get(`${API}/accounts`, ({ request }) => {
    const g = guard(request, 'accounting.view');
    if ('error' in g) return g.error;
    const parsed = accountListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const { q, type, only } = parsed.data;
    const needle = q?.toLowerCase();
    const rows = adb.accounts
      .filter((a) => !type || a.type === type)
      .filter((a) => only === 'all' || (a.isActive && (only === 'active' || !a.isGroup)))
      .filter(
        (a) =>
          !needle ||
          a.code.startsWith(needle) ||
          a.nameAr.includes(q!) ||
          a.nameEn.toLowerCase().includes(needle),
      )
      .sort(byCode);
    return HttpResponse.json({ data: rows });
  }),

  http.post(`${API}/accounts`, async ({ request }) => {
    const g = guard(request, 'accounting.manage');
    if ('error' in g) return g.error;
    const parsed = createAccountSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const b = parsed.data;
    if (adb.accounts.some((a) => a.code === b.code)) return refuse('code_taken');
    if (b.parentId) {
      const p = accountById(b.parentId);
      if (!p || !p.isGroup || p.type !== b.type) return refuse('parent_invalid');
    }
    const row: AccountRow = {
      id: ++adb.seq.account,
      code: b.code,
      nameAr: b.nameAr,
      nameEn: b.nameEn,
      type: b.type,
      parentId: b.parentId ?? null,
      isGroup: b.isGroup,
      isCash: b.isCash,
      currency: b.currency ?? null,
      systemKey: null,
      isActive: true,
      description: b.description ?? null,
    };
    adb.accounts.push(row);
    return HttpResponse.json({ data: row }, { status: 201 });
  }),

  http.patch(`${API}/accounts/:id`, async ({ request, params }) => {
    const g = guard(request, 'accounting.manage');
    if ('error' in g) return g.error;
    const a = accountById(idOf(params));
    if (!a) return notFound();
    const parsed = updateAccountSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const b = parsed.data;
    if (b.isActive === false && a.isActive) {
      if (a.systemKey) return refuse('system_account');
      if (a.isGroup && adb.accounts.some((c) => c.parentId === a.id && c.isActive)) {
        return refuse('group_has_children');
      }
    }
    if (b.parentId !== undefined && b.parentId !== null) {
      const p = accountById(b.parentId);
      if (!p || !p.isGroup || p.type !== a.type || p.id === a.id) return refuse('parent_invalid');
    }
    Object.assign(a, {
      ...(b.nameAr !== undefined && { nameAr: b.nameAr }),
      ...(b.nameEn !== undefined && { nameEn: b.nameEn }),
      ...(b.parentId !== undefined && { parentId: b.parentId }),
      ...(b.isCash !== undefined && { isCash: b.isCash }),
      ...(b.isActive !== undefined && { isActive: b.isActive }),
      ...(b.description !== undefined && { description: b.description }),
    });
    return HttpResponse.json({ data: a });
  }),

  http.get(`${API}/accounts/:id`, ({ request, params }) => {
    const g = guard(request, 'accounting.view');
    if ('error' in g) return g.error;
    const a = accountById(idOf(params));
    return a ? HttpResponse.json({ data: a }) : notFound();
  }),

  http.get(`${API}/accounts/:id/statement`, ({ request, params }) => {
    const g = guard(request, 'accounting.view');
    if ('error' in g) return g.error;
    const a = accountById(idOf(params));
    if (!a) return notFound();
    const parsed = accountStatementQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const { currency, from, to, page, perPage } = parsed.data;
    const ids = subtree(a.id);
    const sign = debitNormal(a) ? 1 : -1;
    const before = movement(ids, currency, null, addDays(from, -1));
    const opening = sign * (before.debit - before.credit);
    let balance = opening;
    const rows = adb.entries
      .filter((e) => e.currency === currency && e.date >= from && e.date <= to)
      .sort((x, y) => x.date.localeCompare(y.date) || x.id - y.id)
      .flatMap((e) =>
        e.lines
          .filter((l) => ids.has(l.accountId))
          .map((l) => {
            balance += sign * (l.debit - l.credit);
            return {
              lineId: l.id,
              entryId: e.id,
              number: e.number,
              date: e.date,
              memo: e.memo,
              description: l.description,
              debit: fromMinor(l.debit),
              credit: fromMinor(l.credit),
              balance: fromMinor(balance),
            };
          }),
      );
    const { data, meta } = paginate(rows, page, perPage, {});
    return HttpResponse.json({
      account: reportAccount(a),
      currency,
      from,
      to,
      opening: fromMinor(opening),
      closing: fromMinor(balance),
      rows: data,
      meta: { page: meta.page, perPage: meta.perPage, total: meta.total, lastPage: meta.lastPage },
    });
  }),

  // ---------------------------------------------------------------- journal
  http.get(`${API}/journal`, ({ request }) => {
    const g = guard(request, 'accounting.view');
    if ('error' in g) return g.error;
    const parsed = journalListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const { q, currency, source, accountId, from, to, page, perPage } = parsed.data;
    const needle = q?.toLowerCase();
    const base = adb.entries
      .filter((e) => !currency || e.currency === currency)
      .filter((e) => !accountId || e.lines.some((l) => l.accountId === accountId))
      .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
      .filter(
        (e) =>
          !needle ||
          e.number.toLowerCase().includes(needle) ||
          e.memo.toLowerCase().includes(needle),
      )
      .sort((x, y) => y.date.localeCompare(x.date) || y.id - x.id);
    // Like the API: counts per source over the same filters, ignoring `source`.
    const counts: Record<string, number> = { all: base.length };
    for (const src of JOURNAL_SOURCES) counts[src] = base.filter((e) => e.source === src).length;
    const rows = base.filter((e) => !source || e.source === source);
    const out = paginate(rows, page, perPage, counts);
    return HttpResponse.json({ ...out, data: out.data.map((e) => presentEntry(e, false)) });
  }),

  http.get(`${API}/journal/:id`, ({ request, params }) => {
    const g = guard(request, 'accounting.view');
    if ('error' in g) return g.error;
    const e = adb.entries.find((x) => x.id === idOf(params));
    return e ? HttpResponse.json({ data: presentEntry(e) }) : notFound();
  }),

  http.post(`${API}/journal`, async ({ request }) => {
    const g = guard(request, 'accounting.manage');
    if ('error' in g) return g.error;
    const parsed = createJournalEntrySchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const b = parsed.data;
    const lines = b.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit ? toMinor(l.debit) : 0,
      credit: l.credit ? toMinor(l.credit) : 0,
      description: l.description ?? null,
    }));
    const dr = lines.reduce((s, l) => s + l.debit, 0);
    const cr = lines.reduce((s, l) => s + l.credit, 0);
    if (dr !== cr) return refuse('unbalanced');
    const problem = lineProblem(
      b.date,
      b.currency,
      lines.map((l) => l.accountId),
    );
    if (problem) return problem;
    const e = postEntry({
      date: b.date,
      currency: b.currency,
      memo: b.memo,
      source: 'manual',
      createdBy: ref(g.me),
      lines,
    });
    return HttpResponse.json({ data: presentEntry(e) }, { status: 201 });
  }),

  http.post(`${API}/journal/:id/reverse`, async ({ request, params }) => {
    const g = guard(request, 'accounting.manage');
    if ('error' in g) return g.error;
    const e = adb.entries.find((x) => x.id === idOf(params));
    if (!e) return notFound();
    const parsed = reverseEntrySchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    if (e.voucherId) return refuse('reverse_voucher_entry', 409);
    if (e.reversedById || e.source === 'reversal') return refuse('already_reversed', 409);
    const date = parsed.data.date ?? academyToday();
    if (isClosed(date)) return refuse('period_closed');
    const rev = reverseEntry(e, date, `عكس القيد ${e.number}: ${parsed.data.reason}`, ref(g.me));
    return HttpResponse.json({ data: presentEntry(rev) }, { status: 201 });
  }),

  // ---------------------------------------------------------------- vouchers
  http.get(`${API}/vouchers`, ({ request }) => {
    const g = guard(request, 'accounting.view');
    if ('error' in g) return g.error;
    const parsed = voucherListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const { q, type, status, currency, from, to, page, perPage } = parsed.data;
    const needle = q?.toLowerCase();
    const base = adb.vouchers
      .filter((v) => !type || v.type === type)
      .filter((v) => !currency || v.currency === currency)
      .filter((v) => (!from || v.date >= from) && (!to || v.date <= to))
      .filter(
        (v) =>
          !needle ||
          v.number.toLowerCase().includes(needle) ||
          v.party.toLowerCase().includes(needle) ||
          v.description.toLowerCase().includes(needle),
      )
      .sort((x, y) => y.date.localeCompare(x.date) || y.id - x.id);
    const counts: Record<string, number> = { all: base.length, posted: 0, void: 0 };
    for (const v of base) counts[v.status] = (counts[v.status] ?? 0) + 1;
    const rows = base.filter((v) => !status || v.status === status);
    const out = paginate(rows, page, perPage, counts);
    return HttpResponse.json({ ...out, data: out.data.map((v) => presentVoucher(v, false)) });
  }),

  http.get(`${API}/vouchers/:id`, ({ request, params }) => {
    const g = guard(request, 'accounting.view');
    if ('error' in g) return g.error;
    const v = adb.vouchers.find((x) => x.id === idOf(params));
    return v ? HttpResponse.json({ data: presentVoucher(v) }) : notFound();
  }),

  http.post(`${API}/vouchers`, async ({ request }) => {
    const g = guard(request, 'accounting.manage');
    if ('error' in g) return g.error;
    const parsed = createVoucherSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const b = parsed.data;
    const cash = accountById(b.cashAccountId);
    if (!cash?.isCash) return refuse('account_not_postable');
    const problem = lineProblem(b.date, b.currency, [
      b.cashAccountId,
      ...b.lines.map((l) => l.accountId),
    ]);
    if (problem) return problem;
    const v = postVoucher({
      type: b.type,
      date: b.date,
      currency: b.currency,
      cashAccountId: b.cashAccountId,
      party: b.party,
      description: b.description,
      reference: b.reference ?? null,
      chequeNumber: b.chequeNumber ?? null,
      createdBy: ref(g.me),
      lines: b.lines.map((l) => ({
        accountId: l.accountId,
        amount: toMinor(l.amount),
        description: l.description ?? null,
      })),
    });
    return HttpResponse.json({ data: presentVoucher(v) }, { status: 201 });
  }),

  http.post(`${API}/vouchers/:id/void`, async ({ request, params }) => {
    const g = guard(request, 'accounting.manage');
    if ('error' in g) return g.error;
    const v = adb.vouchers.find((x) => x.id === idOf(params));
    if (!v) return notFound();
    const parsed = voidVoucherSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    if (v.status === 'void') return refuse('voucher_void', 409);
    const today = academyToday();
    if (isClosed(today)) return refuse('period_closed');
    const entry = adb.entries.find((e) => e.id === v.journalEntryId)!;
    const rev = reverseEntry(
      entry,
      today,
      `إلغاء السند ${v.number}: ${parsed.data.reason}`,
      ref(g.me),
    );
    Object.assign(v, {
      status: 'void',
      voidEntryId: rev.id,
      voidReason: parsed.data.reason,
      voidedAt: new Date().toISOString(),
    });
    return HttpResponse.json({ data: presentVoucher(v) });
  }),

  // ---------------------------------------------------------------- periods and the outbox
  http.get(`${API}/periods`, ({ request }) => {
    const g = guard(request, 'accounting.view');
    if ('error' in g) return g.error;
    const parsed = periodListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    return HttpResponse.json({ data: presentPeriods(parsed.data.year) });
  }),

  http.post(`${API}/periods/:period/close`, ({ request, params }) => {
    const g = guard(request, 'accounting.manage');
    if ('error' in g) return g.error;
    const period = String(params.period);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return notFound();
    if (period >= periodOf(academyToday())) return refuse('period_not_ended');
    const row = adb.periods.find((p) => p.period === period);
    if (row?.closed) return refuse('period_already_closed', 409);
    if (adb.outbox.some((o) => periodOf(o.plan.date) === period)) return refuse('outbox_pending');
    const closed = { closed: true, closedAt: new Date().toISOString(), closedBy: ref(g.me) };
    if (row) Object.assign(row, closed);
    else adb.periods.push({ period, reopenReason: null, ...closed });
    return HttpResponse.json({ data: presentPeriods(Number(period.slice(0, 4))) });
  }),

  http.post(`${API}/periods/:period/reopen`, async ({ request, params }) => {
    const g = guard(request, 'accounting.manage');
    if ('error' in g) return g.error;
    const period = String(params.period);
    const parsed = reopenPeriodSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const row = adb.periods.find((p) => p.period === period);
    if (!row?.closed) return refuse('period_not_closed', 409);
    Object.assign(row, {
      closed: false,
      closedAt: null,
      closedBy: null,
      reopenReason: parsed.data.reason,
    });
    return HttpResponse.json({ data: presentPeriods(Number(period.slice(0, 4))) });
  }),

  http.get(`${API}/outbox`, ({ request }) => {
    const g = guard(request, 'accounting.view');
    if ('error' in g) return g.error;
    const pending = { billing: 0, payroll: 0 };
    for (const o of adb.outbox) pending[o.source] += 1;
    const oldest = adb.outbox.map((o) => o.createdAt).sort()[0] ?? null;
    return HttpResponse.json({
      data: {
        pending,
        oldestPendingAt: oldest,
        failures: adb.outbox
          .filter((o) => o.error)
          .map((o) => ({
            source: o.source,
            eventId: o.eventId,
            eventType: o.eventType,
            error: o.error!,
            attempts: o.attempts,
            lastAttemptAt: o.lastAttemptAt!,
          })),
      },
    });
  }),

  http.post(`${API}/outbox/process`, ({ request }) => {
    const g = guard(request, 'accounting.manage');
    if ('error' in g) return g.error;
    let posted = 0;
    let failed = 0;
    for (const o of [...adb.outbox]) {
      if (o.error) {
        o.attempts += 1;
        o.lastAttemptAt = new Date().toISOString();
        failed += 1;
        continue;
      }
      processOutboxRow(o);
      adb.outbox.splice(adb.outbox.indexOf(o), 1);
      posted += 1;
    }
    return HttpResponse.json({ data: { posted, skipped: 0, failed } });
  }),

  // ---------------------------------------------------------------- reports
  http.get(`${API}/reports/trial-balance`, ({ request }) => {
    const g = guard(request, 'accounting.view');
    if ('error' in g) return g.error;
    const parsed = reportRangeQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const { currency, from, to } = parsed.data;
    const totals = { od: 0, oc: 0, pd: 0, pc: 0, cd: 0, cc: 0 };
    const rows = leaves()
      .sort(byCode)
      .flatMap((a) => {
        const ids = new Set([a.id]);
        const o = movement(ids, currency, null, addDays(from, -1));
        const p = movement(ids, currency, from, to);
        if (!o.debit && !o.credit && !p.debit && !p.credit) return [];
        const open = split(o.debit - o.credit);
        const close = split(o.debit - o.credit + p.debit - p.credit);
        totals.od += open.d;
        totals.oc += open.c;
        totals.pd += p.debit;
        totals.pc += p.credit;
        totals.cd += close.d;
        totals.cc += close.c;
        return [
          {
            ...reportAccount(a),
            openingDebit: fromMinor(open.d),
            openingCredit: fromMinor(open.c),
            periodDebit: fromMinor(p.debit),
            periodCredit: fromMinor(p.credit),
            closingDebit: fromMinor(close.d),
            closingCredit: fromMinor(close.c),
          },
        ];
      });
    return HttpResponse.json({
      data: {
        currency,
        from,
        to,
        rows,
        totals: {
          openingDebit: fromMinor(totals.od),
          openingCredit: fromMinor(totals.oc),
          periodDebit: fromMinor(totals.pd),
          periodCredit: fromMinor(totals.pc),
          closingDebit: fromMinor(totals.cd),
          closingCredit: fromMinor(totals.cc),
        },
        balanced: totals.cd === totals.cc,
      },
    });
  }),

  http.get(`${API}/reports/profit-and-loss`, ({ request }) => {
    const g = guard(request, 'accounting.view');
    if ('error' in g) return g.error;
    const parsed = reportRangeQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const { currency, from, to } = parsed.data;
    const income = section('income', currency, from, to);
    const expense = section('expense', currency, from, to);
    return HttpResponse.json({
      data: {
        currency,
        from,
        to,
        income: income.out,
        expense: expense.out,
        netProfit: fromMinor(income.total - expense.total),
      },
    });
  }),

  http.get(`${API}/reports/balance-sheet`, ({ request }) => {
    const g = guard(request, 'accounting.view');
    if ('error' in g) return g.error;
    const parsed = reportAsOfQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const { currency, asOf } = parsed.data;
    const assets = section('asset', currency, null, asOf);
    const liabilities = section('liability', currency, null, asOf);
    const equity = section('equity', currency, null, asOf);
    const retained =
      section('income', currency, null, asOf).total -
      section('expense', currency, null, asOf).total;
    const right = liabilities.total + equity.total + retained;
    return HttpResponse.json({
      data: {
        currency,
        asOf,
        assets: assets.out,
        liabilities: liabilities.out,
        equity: equity.out,
        retainedEarnings: fromMinor(retained),
        totalLiabilitiesAndEquity: fromMinor(right),
        balanced: right === assets.total,
      },
    });
  }),

  http.get(`${API}/reports/cash`, ({ request }) => {
    const g = guard(request, 'accounting.view');
    if ('error' in g) return g.error;
    const parsed = cashReportQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const { currency, from, to } = parsed.data;
    const cash = leaves()
      .filter((a) => a.isCash)
      .sort(byCode);
    const currencies = [...new Set(adb.entries.map((e) => e.currency))]
      .filter((c) => !currency || c === currency)
      .sort();
    return HttpResponse.json({
      data: {
        from,
        to,
        currencies: currencies.map((cur) => {
          const t = { opening: 0, inflow: 0, outflow: 0, closing: 0 };
          const accounts = cash.flatMap((a) => {
            const ids = new Set([a.id]);
            const o = movement(ids, cur, null, addDays(from, -1));
            const p = movement(ids, cur, from, to);
            if (!o.debit && !o.credit && !p.debit && !p.credit) return [];
            const opening = o.debit - o.credit;
            const closing = opening + p.debit - p.credit;
            t.opening += opening;
            t.inflow += p.debit;
            t.outflow += p.credit;
            t.closing += closing;
            return [
              {
                ...reportAccount(a),
                opening: fromMinor(opening),
                inflow: fromMinor(p.debit),
                outflow: fromMinor(p.credit),
                closing: fromMinor(closing),
              },
            ];
          });
          return {
            currency: cur,
            accounts,
            opening: fromMinor(t.opening),
            inflow: fromMinor(t.inflow),
            outflow: fromMinor(t.outflow),
            closing: fromMinor(t.closing),
          };
        }),
      },
    });
  }),
];
