'use client';

import { WALLET_TX_TYPE_LABELS, type PayslipDto, type WalletRowDto } from '@qarabic/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ChevronLeftIcon, ReceiptTextIcon, WalletIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo } from 'react';
import type { ColumnMeta } from '@/components/data-table';
import { DataTable } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchMyPayslips, fetchMyWallet, fetchWallets, payrollKeys } from '@/lib/api/payroll';
import { can } from '@/lib/auth/use-me';
import { monthLabel } from '@/lib/billing/labels';
import { minorOf } from '@/lib/billing/money';
import { formatInstant } from '@/lib/time';
import { Money, PayslipStatusBadge } from './payroll-bits';
import { payslipHref } from './run-view';

/**
 * Wallets (D93; docs/21 §1.7): the balance of each person = approved salaries − payments recorded.
 * Staff with `wallet.manage` see everyone's balance per currency; anyone with `payroll.view` /
 * `wallet.view` sees «راتبي»: own balance, payslips (newest first) and wallet activity.
 */
export function WalletsView() {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const allowed = can(me, 'wallet.manage');
  const list = useQuery({
    queryKey: payrollKeys.wallets,
    queryFn: ({ signal }) => fetchWallets(signal),
    enabled: allowed,
  });
  const columns = useMemo<ColumnDef<WalletRowDto, unknown>[]>(
    () => [
      {
        id: 'person',
        header: t('person'),
        cell: ({ row: { original: r } }) => <span className="font-semibold">{r.user.name}</span>,
      },
      {
        id: 'currency',
        header: t('wallets.currency'),
        cell: ({ row: { original: r } }) => <bdi>{r.currency}</bdi>,
      },
      {
        id: 'balance',
        header: t('wallets.balance'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: r } }) => (
          <Money amount={r.balance} currency={r.currency} strong={minorOf(r.balance) !== 0} />
        ),
      },
      {
        id: 'last',
        header: t('wallets.lastAt'),
        cell: ({ row: { original: r } }) => (
          <span className="text-muted-foreground">
            {formatInstant(r.lastAt, tz, locale) ?? '—'}
          </span>
        ),
      },
    ],
    [t, locale, tz],
  );
  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('wallets.title')} />
        <ForbiddenState />
      </>
    );
  }
  return (
    <>
      <PageHeader title={t('wallets.title')} description={t('wallets.description')} />
      {list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : !list.isPending && !list.data?.length ? (
        <EmptyState
          icon={WalletIcon}
          title={t('wallets.none')}
          description={t('wallets.description')}
        />
      ) : (
        <DataTable
          columns={columns}
          data={list.data ?? []}
          loading={list.isPending}
          label={t('wallets.table')}
          emptyText={t('wallets.none')}
        />
      )}
    </>
  );
}

/** «راتبي» (teacher portal, mobile-first): balance, payslips, wallet activity. */
export function MyPayrollView() {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const allowed = can(me, 'payroll.view');
  const seesWallet = can(me, 'wallet.view');
  const slips = useQuery({
    queryKey: payrollKeys.myPayslips,
    queryFn: ({ signal }) => fetchMyPayslips(signal),
    enabled: allowed,
  });
  const wallet = useQuery({
    queryKey: payrollKeys.myWallet,
    queryFn: ({ signal }) => fetchMyWallet(signal),
    enabled: allowed && seesWallet,
  });
  if (!allowed || isApiError(slips.error, 403)) {
    return (
      <>
        <PageHeader title={t('my.title')} />
        <ForbiddenState />
      </>
    );
  }
  return (
    <>
      <PageHeader title={t('my.title')} />
      {seesWallet && (
        <section aria-labelledby="my-wallet" className="flex flex-col gap-3">
          <h2 id="my-wallet" className="text-base font-bold">
            {t('my.wallet')}
          </h2>
          {wallet.isError ? (
            <ErrorState onRetry={() => void wallet.refetch()} />
          ) : !wallet.data ? (
            <Skeleton className="h-24 rounded-xl" />
          ) : wallet.data.balances.length === 0 ? (
            <p className="text-muted-foreground">{t('my.walletEmpty')}</p>
          ) : (
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {wallet.data.balances.map((b) => (
                <Card key={b.currency} size="sm" className="gap-1 px-4 shadow-none">
                  <dt className="order-2 text-sm text-muted-foreground">
                    {t('wallets.balance')} · <bdi>{b.currency}</bdi>
                  </dt>
                  <dd className="order-1 text-2xl font-bold tabular-nums">
                    <Money amount={b.balance} currency={b.currency} />
                  </dd>
                </Card>
              ))}
            </dl>
          )}
        </section>
      )}
      <Card className="gap-2 shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-base font-bold">
            <h2>{t('my.payslips')}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {slips.isError ? (
            <ErrorState onRetry={() => void slips.refetch()} />
          ) : slips.isPending ? (
            <Skeleton className="h-32" />
          ) : !slips.data.length ? (
            <EmptyState
              icon={ReceiptTextIcon}
              title={t('my.none')}
              description={t('my.noneHint')}
            />
          ) : (
            <ul aria-label={t('my.payslipsList')} className="flex flex-col divide-y">
              {slips.data.map((s: PayslipDto) => (
                <li key={s.id}>
                  <Link
                    href={payslipHref(s)}
                    aria-label={t('my.open', { month: monthLabel(s.period, locale) })}
                    className="flex min-h-12 items-center justify-between gap-3 py-3 hover:bg-subtle focus-visible:outline-2"
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="font-semibold">{monthLabel(s.period, locale)}</span>
                      <PayslipStatusBadge status={s.status} />
                    </span>
                    <span className="flex items-center gap-2">
                      <Money amount={s.net} currency={s.currency} strong />
                      <ChevronLeftIcon className="size-4 ltr:rotate-180" aria-hidden />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {seesWallet && wallet.data && (
        <Card className="gap-2 shadow-none">
          <CardHeader className="border-b">
            <CardTitle className="text-base font-bold">
              <h2>{t('my.history')}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!wallet.data.transactions.length ? (
              <p className="text-muted-foreground">{t('my.noHistory')}</p>
            ) : (
              <ul aria-label={t('my.historyList')} className="flex flex-col divide-y">
                {wallet.data.transactions.map((x) => (
                  <li key={x.id} className="flex items-center justify-between gap-3 py-3">
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">
                        {WALLET_TX_TYPE_LABELS[x.type][locale]}
                        {x.period && ` · ${monthLabel(x.period, locale)}`}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {formatInstant(x.occurredAt, tz, locale)}
                        {x.reference && (
                          <>
                            {' · '}
                            <bdi dir="ltr" className="whitespace-nowrap">
                              {x.reference}
                            </bdi>
                          </>
                        )}
                      </span>
                    </span>
                    <span className={minorOf(x.amount) < 0 ? 'text-destructive' : undefined}>
                      <Money amount={x.amount} currency={x.currency} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
