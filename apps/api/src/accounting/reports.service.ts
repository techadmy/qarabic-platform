import { Injectable } from '@nestjs/common';
import {
  type AccountStatementDto,
  type AccountType,
  type BalanceSheetDto,
  type CashReportDto,
  DEBIT_NORMAL,
  type ProfitAndLossDto,
  type TrialBalanceDto,
} from '@qarabic/shared';
import { notFound } from '../common/errors.js';
import { Prisma } from '../generated/prisma/client.js';
import { cents, fromCents } from '../payroll/money.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fromDbDate, toDbDate } from '../schedule/time.js';

interface Acc {
  id: number;
  code: string;
  nameAr: string;
  nameEn: string;
  type: AccountType;
  parentId: number | null;
}

/** Sums as text (exact), turned into minor units. */
interface SumRow {
  account_id: number;
  od: string | null;
  oc: string | null;
  pd: string | null;
  pc: string | null;
}

const normal = (type: AccountType, debit: number, credit: number) =>
  DEBIT_NORMAL.includes(type) ? debit - credit : credit - debit;

/**
 * The financial reports (old: balance sheet, P&L, cash book …, docs/07 §أ.3), per currency, from
 * the journal only. Aggregation runs in SQL (one grouped query per report); sums travel as text and
 * are added in integer minor units.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private async accounts(): Promise<Map<number, Acc>> {
    const rows = await this.prisma.ledgerAccount.findMany({
      select: { id: true, code: true, nameAr: true, nameEn: true, type: true, parentId: true },
      orderBy: { code: 'asc' },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Per account: sums before `from` (opening) and from `from` to `to` (period). */
  private async sums(
    currency: string | null,
    from: string,
    to: string,
    onlyCash = false,
  ): Promise<Array<SumRow & { currency: string }>> {
    const f = toDbDate(from);
    const t = toDbDate(to);
    return this.prisma.$queryRaw<Array<SumRow & { currency: string }>>`
      SELECT l.account_id, l.currency,
             sum(l.debit)  FILTER (WHERE l.entry_date <  ${f})::text AS od,
             sum(l.credit) FILTER (WHERE l.entry_date <  ${f})::text AS oc,
             sum(l.debit)  FILTER (WHERE l.entry_date >= ${f})::text AS pd,
             sum(l.credit) FILTER (WHERE l.entry_date >= ${f})::text AS pc
        FROM journal_lines l
        ${onlyCash ? Prisma.sql`JOIN ledger_accounts a ON a.id = l.account_id AND a.is_cash` : Prisma.empty}
       WHERE l.entry_date <= ${t}
         ${currency ? Prisma.sql`AND l.currency = ${currency}` : Prisma.empty}
       GROUP BY l.account_id, l.currency`;
  }

  async trialBalance(currency: string, from: string, to: string): Promise<TrialBalanceDto> {
    const [accounts, sums] = await Promise.all([this.accounts(), this.sums(currency, from, to)]);
    const totals = { od: 0, oc: 0, pd: 0, pc: 0, cd: 0, cc: 0 };
    const rows = sums
      .map((s) => {
        const a = accounts.get(s.account_id)!;
        const opening = cents(s.od) - cents(s.oc);
        const pd = cents(s.pd);
        const pc = cents(s.pc);
        const closing = opening + pd - pc;
        const r = {
          a,
          od: Math.max(opening, 0),
          oc: Math.max(-opening, 0),
          pd,
          pc,
          cd: Math.max(closing, 0),
          cc: Math.max(-closing, 0),
        };
        totals.od += r.od;
        totals.oc += r.oc;
        totals.pd += pd;
        totals.pc += pc;
        totals.cd += r.cd;
        totals.cc += r.cc;
        return r;
      })
      .filter((r) => r.od || r.oc || r.pd || r.pc)
      .sort((x, y) => x.a.code.localeCompare(y.a.code));
    return {
      currency,
      from,
      to,
      rows: rows.map((r) => ({
        ...r.a,
        openingDebit: fromCents(r.od),
        openingCredit: fromCents(r.oc),
        periodDebit: fromCents(r.pd),
        periodCredit: fromCents(r.pc),
        closingDebit: fromCents(r.cd),
        closingCredit: fromCents(r.cc),
      })),
      totals: {
        openingDebit: fromCents(totals.od),
        openingCredit: fromCents(totals.oc),
        periodDebit: fromCents(totals.pd),
        periodCredit: fromCents(totals.pc),
        closingDebit: fromCents(totals.cd),
        closingCredit: fromCents(totals.cc),
      },
      balanced: totals.pd === totals.pc && totals.cd === totals.cc && totals.od === totals.oc,
    };
  }

  private section(
    type: AccountType,
    accounts: Map<number, Acc>,
    sums: SumRow[],
    pick: (s: SumRow) => [number, number],
  ) {
    let total = 0;
    const rows = sums
      .map((s) => ({ a: accounts.get(s.account_id)!, s }))
      .filter(({ a }) => a.type === type)
      .map(({ a, s }) => {
        const [d, c] = pick(s);
        const amount = normal(type, d, c);
        total += amount;
        return { ...a, amount };
      })
      .filter((r) => r.amount !== 0)
      .sort((x, y) => x.code.localeCompare(y.code));
    return {
      type,
      rows: rows.map((r) => ({ ...r, amount: fromCents(r.amount) })),
      total: fromCents(total),
      totalMinor: total,
    };
  }

  async profitAndLoss(currency: string, from: string, to: string): Promise<ProfitAndLossDto> {
    const [accounts, sums] = await Promise.all([this.accounts(), this.sums(currency, from, to)]);
    const period = (s: SumRow): [number, number] => [cents(s.pd), cents(s.pc)];
    const { totalMinor: inc, ...income } = this.section('income', accounts, sums, period);
    const { totalMinor: exp, ...expense } = this.section('expense', accounts, sums, period);
    return { currency, from, to, income, expense, netProfit: fromCents(inc - exp) };
  }

  async balanceSheet(currency: string, asOf: string): Promise<BalanceSheetDto> {
    // Everything up to `asOf` sits in the "period" columns when `from` is the epoch.
    const [accounts, sums] = await Promise.all([
      this.accounts(),
      this.sums(currency, '1970-01-01', asOf),
    ]);
    const all = (s: SumRow): [number, number] => [
      cents(s.od) + cents(s.pd),
      cents(s.oc) + cents(s.pc),
    ];
    const { totalMinor: assetsT, ...assets } = this.section('asset', accounts, sums, all);
    const { totalMinor: liabT, ...liabilities } = this.section('liability', accounts, sums, all);
    const { totalMinor: eqT, ...equity } = this.section('equity', accounts, sums, all);
    const incT = this.section('income', accounts, sums, all).totalMinor;
    const expT = this.section('expense', accounts, sums, all).totalMinor;
    const retained = incT - expT;
    const le = liabT + eqT + retained;
    return {
      currency,
      asOf,
      assets,
      liabilities,
      equity,
      retainedEarnings: fromCents(retained),
      totalLiabilitiesAndEquity: fromCents(le),
      balanced: assetsT === le,
    };
  }

  async cash(currency: string | undefined, from: string, to: string): Promise<CashReportDto> {
    const [accounts, sums] = await Promise.all([
      this.accounts(),
      this.sums(currency ?? null, from, to, true),
    ]);
    const byCurrency = new Map<string, Array<SumRow & { currency: string }>>();
    for (const s of sums) byCurrency.set(s.currency, [...(byCurrency.get(s.currency) ?? []), s]);
    const currencies = [...byCurrency.keys()].sort();
    return {
      from,
      to,
      currencies: currencies.map((cur) => {
        const t = { o: 0, i: 0, out: 0, c: 0 };
        const rows = byCurrency
          .get(cur)!
          .map((s) => {
            const opening = cents(s.od) - cents(s.oc);
            const inflow = cents(s.pd);
            const outflow = cents(s.pc);
            const closing = opening + inflow - outflow;
            t.o += opening;
            t.i += inflow;
            t.out += outflow;
            t.c += closing;
            return { a: accounts.get(s.account_id)!, opening, inflow, outflow, closing };
          })
          .sort((x, y) => x.a.code.localeCompare(y.a.code));
        return {
          currency: cur,
          accounts: rows.map((r) => ({
            ...r.a,
            opening: fromCents(r.opening),
            inflow: fromCents(r.inflow),
            outflow: fromCents(r.outflow),
            closing: fromCents(r.closing),
          })),
          opening: fromCents(t.o),
          inflow: fromCents(t.i),
          outflow: fromCents(t.out),
          closing: fromCents(t.c),
        };
      }),
    };
  }

  async statement(
    accountId: number,
    q: { currency: string; from: string; to: string; page: number; perPage: number },
  ): Promise<AccountStatementDto> {
    const account = await this.prisma.ledgerAccount.findUnique({
      where: { id: accountId },
      select: { id: true, code: true, nameAr: true, nameEn: true, type: true, parentId: true },
    });
    if (!account) throw notFound();
    const f = toDbDate(q.from);
    const t = toDbDate(q.to);
    const [open] = await this.prisma.$queryRaw<Array<{ d: string | null; c: string | null }>>`
      SELECT sum(debit)::text AS d, sum(credit)::text AS c FROM journal_lines
       WHERE account_id = ${accountId} AND currency = ${q.currency} AND entry_date < ${f}`;
    const [range] = await this.prisma.$queryRaw<
      Array<{ d: string | null; c: string | null; n: number }>
    >`
      SELECT sum(debit)::text AS d, sum(credit)::text AS c, count(*)::int AS n FROM journal_lines
       WHERE account_id = ${accountId} AND currency = ${q.currency}
         AND entry_date >= ${f} AND entry_date <= ${t}`;
    const rows = await this.prisma.$queryRaw<
      Array<{
        line_id: number;
        entry_id: number;
        number: string;
        entry_date: Date;
        memo: string;
        description: string | null;
        debit: string;
        credit: string;
        run_d: string;
        run_c: string;
      }>
    >`
      SELECT * FROM (
        SELECT l.id AS line_id, l.entry_id, e.number, l.entry_date, e.memo, l.description,
               l.debit::text AS debit, l.credit::text AS credit,
               (sum(l.debit) OVER w)::text AS run_d, (sum(l.credit) OVER w)::text AS run_c
          FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
         WHERE l.account_id = ${accountId} AND l.currency = ${q.currency}
           AND l.entry_date >= ${f} AND l.entry_date <= ${t}
        WINDOW w AS (ORDER BY l.entry_date, l.entry_id, l.id)
      ) x
      ORDER BY entry_date, entry_id, line_id
      LIMIT ${q.perPage} OFFSET ${(q.page - 1) * q.perPage}`;
    const opening = normal(account.type, cents(open?.d), cents(open?.c));
    const closing = opening + normal(account.type, cents(range?.d), cents(range?.c));
    const total = range?.n ?? 0;
    return {
      account,
      currency: q.currency,
      from: q.from,
      to: q.to,
      opening: fromCents(opening),
      closing: fromCents(closing),
      rows: rows.map((r) => ({
        lineId: r.line_id,
        entryId: r.entry_id,
        number: r.number,
        date: fromDbDate(r.entry_date),
        memo: r.memo,
        description: r.description,
        debit: fromCents(cents(r.debit)),
        credit: fromCents(cents(r.credit)),
        balance: fromCents(opening + normal(account.type, cents(r.run_d), cents(r.run_c))),
      })),
      meta: {
        page: q.page,
        perPage: q.perPage,
        total,
        lastPage: Math.max(1, Math.ceil(total / q.perPage)),
      },
    };
  }
}
