'use client';

import {
  ACCOUNT_TYPE_LABELS,
  CURRENCIES,
  type BalanceSheetDto,
  type CashReportDto,
  type ProfitAndLossDto,
  type TrialBalanceDto,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Label } from '@qarabic/ui/components/label';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@qarabic/ui/components/tabs';
import { cn } from '@qarabic/ui/lib/utils';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangleIcon, CircleCheckIcon, PrinterIcon, WalletIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { PageHeader } from '@/components/page-header';
import { ToneBadge } from '@/components/sessions/badges';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import {
  accountingKeys,
  fetchBalanceSheet,
  fetchCashReport,
  fetchProfitAndLoss,
  fetchTrialBalance,
} from '@/lib/api/accounting';
import { isApiError } from '@/lib/api/client';
import { academyToday, monthBounds } from '@/lib/accounting/forms';
import { DEFAULT_CURRENCY, STATEMENT_START } from '@/lib/accounting/periods';
import { DatePicker } from '@/components/forms/date-time';
import { can } from '@/lib/auth/use-me';
import { minorOf } from '@/lib/billing/money';
import { useListParams } from '@/lib/list-params';
import { formatDate } from '@/lib/time';
import { useDirection } from '@/lib/use-direction';
import { accountLabel, CurrencySelect, DateRangeFilters, Money } from './accounting-bits';

export const REPORTS = ['trial-balance', 'profit-and-loss', 'balance-sheet', 'cash'] as const;
export type ReportName = (typeof REPORTS)[number];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Ref = { id: number; code: string; nameAr: string; nameEn: string };
type Range = { currency: string; from: string; to: string };

/** An account name that opens its statement for the same currency and range. */
function AccountLink({ a, range }: { a: Ref; range: Range }) {
  const locale = useUiLocale();
  const qs = new URLSearchParams(range).toString();
  return (
    <Link href={`/accounting/accounts/${a.id}?${qs}`} className="text-primary hover:underline">
      {accountLabel(a, locale)}
    </Link>
  );
}

function Amount({ v, currency, strong }: { v: string; currency: string; strong?: boolean }) {
  if (!minorOf(v)) return <span className="text-muted-foreground">—</span>;
  return (
    <Money
      amount={v}
      currency={currency}
      strong={strong}
      className={minorOf(v) < 0 ? 'text-destructive' : undefined}
    />
  );
}

function Balanced({ ok }: { ok: boolean }) {
  const t = useTranslations('accounting.reports');
  return ok ? (
    <ToneBadge tone="green" icon={CircleCheckIcon} label={t('balanced')} />
  ) : (
    <ToneBadge tone="red" icon={AlertTriangleIcon} label={t('notBalanced')} />
  );
}

function ReportCard({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b py-4">
        <CardTitle className="text-base font-bold">
          <h2>{title}</h2>
        </CardTitle>
        {badge}
      </CardHeader>
      <div className="overflow-x-auto">{children}</div>
    </Card>
  );
}

function TrialBalance({ data: d, range }: { data: TrialBalanceDto; range: Range }) {
  const t = useTranslations('accounting.reports');
  const tf = useTranslations('accounting.fields');
  const pair = ['opening', 'period', 'closing'] as const;
  return (
    <ReportCard title={t('trial-balance')} badge={<Balanced ok={d.balanced} />}>
      <Table aria-label={t('trial-balance')}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead rowSpan={2} scope="col">
              {tf('account')}
            </TableHead>
            {pair.map((p) => (
              <TableHead key={p} colSpan={2} scope="colgroup" className="border-s text-center">
                {t(`tb.${p}`)}
              </TableHead>
            ))}
          </TableRow>
          <TableRow className="hover:bg-transparent">
            {pair.map((p) => (
              <DebitCreditHeads key={p} />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {d.rows.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={7} className="text-muted-foreground">
                {t('noRows')}
              </TableCell>
            </TableRow>
          )}
          {d.rows.map((r) => (
            <TableRow key={r.id}>
              <TableHead scope="row" className="min-w-56 font-medium">
                <AccountLink a={r} range={range} />
              </TableHead>
              <TableCell className="border-s text-end">
                <Amount v={r.openingDebit} currency={d.currency} />
              </TableCell>
              <TableCell className="text-end">
                <Amount v={r.openingCredit} currency={d.currency} />
              </TableCell>
              <TableCell className="border-s text-end">
                <Amount v={r.periodDebit} currency={d.currency} />
              </TableCell>
              <TableCell className="text-end">
                <Amount v={r.periodCredit} currency={d.currency} />
              </TableCell>
              <TableCell className="border-s text-end">
                <Amount v={r.closingDebit} currency={d.currency} />
              </TableCell>
              <TableCell className="text-end">
                <Amount v={r.closingCredit} currency={d.currency} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="row" className="font-semibold text-foreground">
              {t('total')}
            </TableHead>
            {(
              [
                'openingDebit',
                'openingCredit',
                'periodDebit',
                'periodCredit',
                'closingDebit',
                'closingCredit',
              ] as const
            ).map((k, i) => (
              <TableCell key={k} className={cn('text-end', i % 2 === 0 && 'border-s')}>
                <Money amount={d.totals[k]} currency={d.currency} strong />
              </TableCell>
            ))}
          </TableRow>
        </TableFooter>
      </Table>
    </ReportCard>
  );
}

function DebitCreditHeads() {
  const tf = useTranslations('accounting.fields');
  return (
    <>
      <TableHead scope="col" className="border-s text-end">
        {tf('debit')}
      </TableHead>
      <TableHead scope="col" className="text-end">
        {tf('credit')}
      </TableHead>
    </>
  );
}

/** One section of P&L or the balance sheet: account | amount, then the total. */
function Section({
  title,
  rows,
  total,
  totalLabel,
  currency,
  range,
  extra,
}: {
  title: string;
  rows: (Ref & { amount: string })[];
  total: string;
  totalLabel: string;
  currency: string;
  range: Range;
  extra?: ReactNode;
}) {
  const t = useTranslations('accounting.reports');
  const tf = useTranslations('accounting.fields');
  return (
    <Table aria-label={title}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col">{title}</TableHead>
          <TableHead scope="col" className="text-end">
            {tf('amount')}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && !extra && (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={2} className="text-muted-foreground">
              {t('noRows')}
            </TableCell>
          </TableRow>
        )}
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableHead scope="row" className="min-w-48 font-medium">
              <AccountLink a={r} range={range} />
            </TableHead>
            <TableCell className="text-end">
              <Amount v={r.amount} currency={currency} />
            </TableCell>
          </TableRow>
        ))}
        {extra}
      </TableBody>
      <TableFooter>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="row" className="font-semibold text-foreground">
            {totalLabel}
          </TableHead>
          <TableCell className="text-end">
            <Money amount={total} currency={currency} strong />
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

function ProfitAndLoss({ data: d, range }: { data: ProfitAndLossDto; range: Range }) {
  const t = useTranslations('accounting.reports');
  const locale = useUiLocale();
  const loss = minorOf(d.netProfit) < 0;
  return (
    <ReportCard title={t('profit-and-loss')}>
      <Section
        title={ACCOUNT_TYPE_LABELS.income[locale]}
        rows={d.income.rows}
        total={d.income.total}
        totalLabel={t('totalIncome')}
        currency={d.currency}
        range={range}
      />
      <Section
        title={ACCOUNT_TYPE_LABELS.expense[locale]}
        rows={d.expense.rows}
        total={d.expense.total}
        totalLabel={t('totalExpense')}
        currency={d.currency}
        range={range}
      />
      <div className="flex items-center justify-between gap-2 border-t bg-muted/50 px-4 py-4">
        <span className="text-lg font-bold">{loss ? t('netLoss') : t('netProfit')}</span>
        <Money
          amount={d.netProfit}
          currency={d.currency}
          strong
          className={cn('text-lg', loss && 'text-destructive')}
        />
      </div>
    </ReportCard>
  );
}

function BalanceSheet({ data: d, range }: { data: BalanceSheetDto; range: Range }) {
  const t = useTranslations('accounting.reports');
  const locale = useUiLocale();
  return (
    <ReportCard title={t('balance-sheet')} badge={<Balanced ok={d.balanced} />}>
      <Section
        title={ACCOUNT_TYPE_LABELS.asset[locale]}
        rows={d.assets.rows}
        total={d.assets.total}
        totalLabel={t('totalAssets')}
        currency={d.currency}
        range={range}
      />
      <Section
        title={ACCOUNT_TYPE_LABELS.liability[locale]}
        rows={d.liabilities.rows}
        total={d.liabilities.total}
        totalLabel={t('totalLiabilities')}
        currency={d.currency}
        range={range}
      />
      <Section
        title={ACCOUNT_TYPE_LABELS.equity[locale]}
        rows={d.equity.rows}
        total={d.equity.total}
        totalLabel={t('totalEquity')}
        currency={d.currency}
        range={range}
        extra={
          <TableRow>
            <TableCell className="font-medium">{t('retainedEarnings')}</TableCell>
            <TableCell className="text-end">
              <Amount v={d.retainedEarnings} currency={d.currency} />
            </TableCell>
          </TableRow>
        }
      />
      <div className="flex items-center justify-between gap-2 border-t bg-muted/50 px-4 py-4">
        <span className="font-bold">{t('totalLiabilitiesAndEquity')}</span>
        <Money amount={d.totalLiabilitiesAndEquity} currency={d.currency} strong />
      </div>
    </ReportCard>
  );
}

function CashReport({ data: d }: { data: CashReportDto }) {
  const t = useTranslations('accounting.reports');
  const tf = useTranslations('accounting.fields');
  if (d.currencies.length === 0) {
    return <EmptyState icon={WalletIcon} title={t('noCash')} description={t('noCashHint')} />;
  }
  const cols = ['opening', 'inflow', 'outflow', 'closing'] as const;
  return (
    <div className="flex flex-col gap-4">
      {d.currencies.map((c) => (
        <ReportCard key={c.currency} title={t('cashIn', { currency: c.currency })}>
          <Table aria-label={t('cashIn', { currency: c.currency })}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">{tf('account')}</TableHead>
                {cols.map((k) => (
                  <TableHead key={k} scope="col" className="text-end">
                    {t(`cashCols.${k}`)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {c.accounts.map((a) => (
                <TableRow key={a.id}>
                  <TableHead scope="row" className="min-w-48 font-medium">
                    <AccountLink a={a} range={{ currency: c.currency, from: d.from, to: d.to }} />
                  </TableHead>
                  {cols.map((k) => (
                    <TableCell key={k} className="text-end">
                      <Amount v={a[k]} currency={c.currency} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="row" className="font-semibold text-foreground">
                  {t('total')}
                </TableHead>
                {cols.map((k) => (
                  <TableCell key={k} className="text-end">
                    <Money amount={c[k]} currency={c.currency} strong />
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          </Table>
        </ReportCard>
      ))}
    </div>
  );
}

/**
 * «التقارير المالية» (M7, docs/07 §أ.4; the old Balance sheet, Profit & Loss, Cash book and
 * Receipts & Payments): trial balance, profit and loss, balance sheet and cash, one currency at a
 * time (the cash report can show every currency). Report, currency and dates live in the URL;
 * every account opens its statement for the same range. Printable.
 */
export function ReportsView() {
  const t = useTranslations('accounting.reports');
  const ta = useTranslations('accounting');
  const me = useCurrentUser();
  const locale = useUiLocale();
  const dir = useDirection();
  const params = useListParams();
  const ids = { currency: useId(), asOf: useId() };
  const allowed = can(me, 'accounting.view');
  const reportParam = params.get('report') as ReportName;
  const report: ReportName = REPORTS.includes(reportParam) ? reportParam : 'trial-balance';
  const today = academyToday();
  const month = monthBounds(today);
  const currencyParam = params.get('currency');
  const known = (CURRENCIES as readonly string[]).includes(currencyParam);
  const currency = known ? currencyParam : report === 'cash' ? '' : DEFAULT_CURRENCY;
  const from = DATE.test(params.get('from')) ? params.get('from') : month.from;
  const to = DATE.test(params.get('to')) ? params.get('to') : month.to;
  const asOf = DATE.test(params.get('asOf')) ? params.get('asOf') : today;
  const range = { currency: currency || DEFAULT_CURRENCY, from, to };
  const q =
    report === 'balance-sheet'
      ? { currency: range.currency, asOf }
      : report === 'cash'
        ? { ...(currency ? { currency } : {}), from, to }
        : range;
  const valid = report === 'balance-sheet' || from <= to;
  const query = useQuery({
    queryKey: accountingKeys.report(report, q),
    queryFn: ({ signal }): Promise<unknown> => {
      switch (report) {
        case 'profit-and-loss':
          return fetchProfitAndLoss(range, signal);
        case 'balance-sheet':
          return fetchBalanceSheet({ currency: range.currency, asOf }, signal);
        case 'cash':
          return fetchCashReport({ ...(currency ? { currency } : {}), from, to }, signal);
        default:
          return fetchTrialBalance(range, signal);
      }
    },
    placeholderData: keepPreviousData,
    enabled: allowed && valid,
  });

  if (!allowed || isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const stale = query.isPlaceholderData;
  const data = query.data;
  // A start after the end is said under the date pickers; nothing to show until it is fixed.
  const body = !valid ? null : query.isError ? (
    <ErrorState onRetry={() => void query.refetch()} />
  ) : !data || stale ? (
    <Skeleton className="h-96" aria-busy="true" />
  ) : report === 'profit-and-loss' ? (
    <ProfitAndLoss data={data as ProfitAndLossDto} range={range} />
  ) : report === 'balance-sheet' ? (
    <BalanceSheet
      data={data as BalanceSheetDto}
      range={{ ...range, from: STATEMENT_START, to: asOf }}
    />
  ) : report === 'cash' ? (
    <CashReport data={data as CashReportDto} />
  ) : (
    <TrialBalance data={data as TrialBalanceDto} range={range} />
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        description={
          report === 'balance-sheet'
            ? t('asOfLine', { date: formatDate(asOf, locale) ?? asOf })
            : t('rangeLine', {
                from: formatDate(from, locale) ?? from,
                to: formatDate(to, locale) ?? to,
              })
        }
        actions={
          <Button variant="outline" className="h-10 print:hidden" onClick={() => window.print()}>
            <PrinterIcon />
            {ta('voucher.print')}
          </Button>
        }
      />
      <Tabs
        value={report}
        dir={dir}
        onValueChange={(v) => params.set({ report: v === 'trial-balance' ? null : v })}
        className="gap-4"
      >
        <TabsList className="h-auto max-w-full flex-wrap justify-start print:hidden">
          {REPORTS.map((r) => (
            <TabsTrigger key={r} value={r} className="h-9 px-3">
              {t(r)}
            </TabsTrigger>
          ))}
        </TabsList>
        <Card className="flex-row flex-wrap items-end gap-3 p-4 shadow-none print:hidden">
          <div className="flex min-w-32 flex-col gap-2">
            <Label htmlFor={ids.currency} className="text-sm text-muted-foreground">
              {ta('fields.currency')}
            </Label>
            <CurrencySelect
              id={ids.currency}
              value={currency}
              allowAll={report === 'cash'}
              onChange={(v) => params.set({ currency: v || null })}
            />
          </div>
          {report === 'balance-sheet' ? (
            <div className="flex min-w-36 flex-col gap-2">
              <Label htmlFor={ids.asOf} className="text-sm text-muted-foreground">
                {t('asOf')}
              </Label>
              <DatePicker
                id={ids.asOf}
                value={asOf}
                onChange={(v) => params.set({ asOf: v || null })}
              />
            </div>
          ) : (
            <DateRangeFilters from={from} to={to} onChange={(v) => params.set(v)} />
          )}
        </Card>
        {REPORTS.map((r) => (
          <TabsContent key={r} value={r} forceMount hidden={r !== report}>
            {r === report && body}
          </TabsContent>
        ))}
      </Tabs>
      <p className="text-sm text-muted-foreground">{t('perCurrencyNote')}</p>
    </div>
  );
}
