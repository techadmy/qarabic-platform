'use client';

import { CURRENCIES, type LedgerAccountDto } from '@qarabic/shared';
import { Card } from '@qarabic/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId } from 'react';
import { Label } from '@qarabic/ui/components/label';
import { ListPagination } from '@/components/list/list-pagination';
import { KeyFacts, ProfileSkeleton } from '@/components/people/detail';
import { PageHeader } from '@/components/page-header';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { accountingKeys, fetchAccounts, fetchAccountStatement } from '@/lib/api/accounting';
import { isApiError } from '@/lib/api/client';
import { academyToday, monthBounds } from '@/lib/accounting/forms';
import { DEFAULT_CURRENCY } from '@/lib/accounting/periods';
import { can } from '@/lib/auth/use-me';
import { minorOf } from '@/lib/billing/money';
import { useListParams } from '@/lib/list-params';
import { formatDate } from '@/lib/time';
import { accountLabel, CurrencySelect, DateRangeFilters, Money } from './accounting-bits';
import { FileSearchIcon } from 'lucide-react';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * «كشف حساب» (M7; the old ledger of an account head): opening balance, every line in the range
 * with the running balance in the account's normal direction, and the closing balance. One
 * currency at a time (the books are per currency); the range defaults to this month.
 */
export function StatementView({ id }: { id: number }) {
  const t = useTranslations('accounting');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const currencyId = useId();
  const allowed = can(me, 'accounting.view');
  const month = monthBounds(academyToday());
  const currency = (CURRENCIES as readonly string[]).includes(params.get('currency'))
    ? params.get('currency')
    : DEFAULT_CURRENCY;
  const from = DATE.test(params.get('from')) ? params.get('from') : month.from;
  const to = DATE.test(params.get('to')) ? params.get('to') : month.to;
  const q = { currency, from, to, page: params.page, perPage: params.perPage };
  const accounts = useQuery({
    queryKey: accountingKeys.accounts({ only: 'all' }),
    queryFn: ({ signal }) => fetchAccounts({ only: 'all' }, signal),
    enabled: allowed,
  });
  const account: LedgerAccountDto | undefined = accounts.data?.find((a) => a.id === id);
  const query = useQuery({
    queryKey: accountingKeys.statement(id, q),
    queryFn: ({ signal }) => fetchAccountStatement(id, q, signal),
    placeholderData: keepPreviousData,
    enabled: allowed && from <= to,
  });
  const back = { href: '/accounting/accounts', label: t('accounts.title') };
  if (!allowed || isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={t('statement.title')} back={back} />
        <ForbiddenState />
      </>
    );
  }
  if (isApiError(query.error, 404)) {
    return (
      <>
        <PageHeader title={t('statement.title')} back={back} />
        <ErrorState />
      </>
    );
  }
  const s = query.data;
  const title = account
    ? t('statement.titleOf', { name: accountLabel(account, locale) })
    : t('statement.title');
  const balance = (v: string) => (
    <Money
      amount={v}
      currency={currency}
      className={minorOf(v) < 0 ? 'text-destructive' : undefined}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={title} description={t('statement.hint')} back={back} />
      <Card className="flex-row flex-wrap items-end gap-3 p-4 shadow-none">
        <div className="flex min-w-32 flex-col gap-2">
          <Label htmlFor={currencyId} className="text-[0.8125rem] text-muted-foreground">
            {t('fields.currency')}
          </Label>
          <CurrencySelect
            id={currencyId}
            value={currency}
            onChange={(v) => params.set({ currency: v })}
          />
        </div>
        <DateRangeFilters from={from} to={to} onChange={(v) => params.set(v)} />
      </Card>
      {from > to ? null : query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} />
      ) : !s ? (
        <ProfileSkeleton />
      ) : (
        <>
          <KeyFacts
            items={[
              { label: t('statement.opening'), value: balance(s.opening) },
              { label: t('statement.closing'), value: balance(s.closing) },
              { label: t('statement.lines'), value: s.meta.total },
              {
                label: t('statement.range'),
                value: (
                  <span className="text-base">
                    {formatDate(s.from, locale)} – {formatDate(s.to, locale)}
                  </span>
                ),
              },
            ]}
          />
          {s.rows.length === 0 ? (
            <EmptyState
              icon={FileSearchIcon}
              role="status"
              title={t('statement.empty')}
              description={t('statement.emptyHint')}
            />
          ) : (
            <Card className="gap-0 overflow-x-auto py-0 shadow-none">
              <Table aria-label={title}>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t('fields.date')}</TableHead>
                    <TableHead>{t('fields.number')}</TableHead>
                    <TableHead>{t('fields.memo')}</TableHead>
                    <TableHead className="text-end">{t('fields.debit')}</TableHead>
                    <TableHead className="text-end">{t('fields.credit')}</TableHead>
                    <TableHead className="text-end">{t('statement.balance')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.rows.map((r) => (
                    <TableRow key={r.lineId}>
                      <TableCell className="whitespace-nowrap">
                        {formatDate(r.date, locale)}
                      </TableCell>
                      <TableCell>
                        <Link
                          href={`/accounting/journal/${r.entryId}`}
                          className="font-semibold text-primary hover:underline"
                        >
                          <bdi>{r.number}</bdi>
                        </Link>
                      </TableCell>
                      <TableCell className="min-w-48">
                        {r.memo}
                        {r.description && (
                          <span className="block text-sm text-muted-foreground">
                            {r.description}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-end">
                        {minorOf(r.debit) ? <Money amount={r.debit} currency={currency} /> : '—'}
                      </TableCell>
                      <TableCell className="text-end">
                        {minorOf(r.credit) ? <Money amount={r.credit} currency={currency} /> : '—'}
                      </TableCell>
                      <TableCell className="text-end font-semibold">{balance(r.balance)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ListPagination
                meta={{ ...s.meta, counts: {} }}
                onPage={(page) =>
                  params.set({ page: page === 1 ? null : page }, { resetPage: false })
                }
                onPerPage={(perPage) => params.set({ perPage: perPage === 25 ? null : perPage })}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
