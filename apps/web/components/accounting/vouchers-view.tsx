'use client';

import {
  CURRENCIES,
  VOUCHER_STATUS_LABELS,
  VOUCHER_STATUSES,
  VOUCHER_TYPE_LABELS,
  VOUCHER_TYPES,
  type VoucherListQuery,
  type VoucherRowDto,
  type VoucherStatus,
  type VoucherType,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { useIsMobile } from '@qarabic/ui/hooks/use-mobile';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowDownLeftIcon, ArrowUpRightIcon, ReceiptTextIcon, SearchXIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { ColumnMeta } from '@/components/data-table';
import { DataTable } from '@/components/data-table';
import { ListPagination } from '@/components/list/list-pagination';
import {
  ClearFiltersButton,
  FilterSelect,
  ListToolbar,
  StatusTabs,
} from '@/components/list/list-toolbar';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { Highlight } from '@/components/people/people-list';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { accountingKeys, fetchVouchers } from '@/lib/api/accounting';
import { isApiError } from '@/lib/api/client';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { formatDate } from '@/lib/time';
import { DateRangeFilters, Money, VoucherStatusBadge, VoucherTypeBadge } from './accounting-bits';
import { VoucherDialog } from './voucher-dialog';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * «سندات القبض والصرف» (M7, the old Receipts & Payments): money in and out that is not an invoice
 * or a salary — suppliers, rent, subscriptions, a refunded advance. Search by number, party or
 * description; type, currency and date filters; status tabs with counts. Primary actions:
 * «سند صرف» and «سند قبض» (accounting.manage).
 */
export function VouchersView() {
  const t = useTranslations('accounting');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const isMobile = useIsMobile();
  const [creating, setCreating] = useState<VoucherType | null>(null);
  const allowed = can(me, 'accounting.view');
  const manage = can(me, 'accounting.manage');
  const statusParam = params.get('status') as VoucherStatus;
  const status = VOUCHER_STATUSES.includes(statusParam) ? statusParam : undefined;
  const typeParam = params.get('type') as VoucherType;
  const type = VOUCHER_TYPES.includes(typeParam) ? typeParam : undefined;
  const currency = (CURRENCIES as readonly string[]).includes(params.get('currency'))
    ? params.get('currency')
    : '';
  const from = DATE.test(params.get('from')) ? params.get('from') : '';
  const to = DATE.test(params.get('to')) ? params.get('to') : '';
  const query: Partial<VoucherListQuery> = {
    q: params.q || undefined,
    status,
    type,
    currency: currency || undefined,
    from: from || undefined,
    to: to || undefined,
    page: params.page,
    perPage: params.perPage,
  };
  const list = useQuery({
    queryKey: accountingKeys.vouchers(query),
    queryFn: ({ signal }) => fetchVouchers(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  const rows = useMemo(() => list.data?.data ?? [], [list.data]);
  const meta = list.data?.meta;
  const filtersOn = !!(params.q || type || currency || from || to);
  const href = (x: VoucherRowDto) => `/accounting/vouchers/${x.id}`;

  const columns = useMemo<ColumnDef<VoucherRowDto, unknown>[]>(
    () => [
      {
        id: 'number',
        header: t('fields.number'),
        cell: ({ row: { original: x } }) => (
          <Link href={href(x)} className="font-semibold text-primary hover:underline">
            <bdi>
              <Highlight text={x.number} query={params.q} />
            </bdi>
          </Link>
        ),
      },
      {
        id: 'date',
        header: t('fields.date'),
        cell: ({ row: { original: x } }) => (
          <span className="whitespace-nowrap">{formatDate(x.date, locale)}</span>
        ),
      },
      {
        id: 'type',
        header: t('voucher.type'),
        cell: ({ row: { original: x } }) => <VoucherTypeBadge type={x.type} />,
      },
      {
        id: 'party',
        header: t('voucher.party'),
        cell: ({ row: { original: x } }) => (
          <span className="flex min-w-40 flex-col">
            <span className="font-medium">
              <Highlight text={x.party} query={params.q} />
            </span>
            <span className="line-clamp-1 text-sm text-muted-foreground">{x.description}</span>
          </span>
        ),
      },
      {
        id: 'amount',
        header: t('fields.amount'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: x } }) => (
          <Money
            amount={x.amount}
            currency={x.currency}
            className={x.status === 'void' ? 'text-muted-foreground line-through' : undefined}
          />
        ),
      },
      {
        id: 'status',
        header: t('fields.status'),
        cell: ({ row: { original: x } }) => <VoucherStatusBadge status={x.status} />,
      },
    ],
    [t, locale, params.q],
  );

  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('vouchers.title')} />
        <ForbiddenState />
      </>
    );
  }

  const clearFilters = () => {
    params.setSearchInput('');
    params.set({ q: null, type: null, currency: null, from: null, to: null });
  };
  const actions = manage && (
    <div className="flex flex-wrap gap-2">
      <Button className="h-10" onClick={() => setCreating('payment')}>
        <ArrowUpRightIcon className="rtl:-scale-x-100" />
        {t('voucher.newPayment')}
      </Button>
      <Button variant="outline" className="h-10" onClick={() => setCreating('receipt')}>
        <ArrowDownLeftIcon />
        {t('voucher.newReceipt')}
      </Button>
    </div>
  );

  return (
    <>
      <PageHeader
        title={t('vouchers.title')}
        description={t('vouchers.description')}
        meta={meta ? t('vouchers.count', { count: meta.total }) : undefined}
        actions={actions}
      />
      <Card className="gap-0 py-0 shadow-none">
        <ListToolbar
          search={{
            label: t('vouchers.searchLabel'),
            placeholder: t('vouchers.search'),
            value: params.searchInput,
            onChange: params.setSearchInput,
          }}
          filters={
            <>
              <FilterSelect
                label={t('voucher.type')}
                value={type ?? ''}
                onChange={(v) => params.set({ type: v || null })}
                allLabel={t('vouchers.allTypes')}
                options={VOUCHER_TYPES.map((v) => ({
                  value: v,
                  label: VOUCHER_TYPE_LABELS[v][locale],
                }))}
              />
              <FilterSelect
                label={t('fields.currency')}
                value={currency}
                onChange={(v) => params.set({ currency: v || null })}
                allLabel={t('allCurrencies')}
                options={CURRENCIES.map((c) => ({ value: c, label: c }))}
              />
              <DateRangeFilters from={from} to={to} onChange={(v) => params.set(v)} />
              {filtersOn && <ClearFiltersButton onClick={clearFilters} />}
            </>
          }
          tabs={
            <StatusTabs
              label={t('vouchers.tabs')}
              value={status ?? ''}
              onChange={(v) => params.set({ status: v || null })}
              options={[
                { value: '', label: t('vouchers.all'), count: meta?.counts.all },
                ...VOUCHER_STATUSES.map((s) => ({
                  value: s,
                  label: VOUCHER_STATUS_LABELS[s][locale],
                  count: meta?.counts[s],
                })),
              ]}
            />
          }
        />
        {list.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : !list.isPending && rows.length === 0 ? (
          <div className="p-4">
            {filtersOn || status ? (
              <EmptyState
                icon={SearchXIcon}
                role="status"
                title={t('vouchers.noResults')}
                description={t('vouchers.noResultsHint')}
                action={
                  filtersOn ? (
                    <Button variant="outline" onClick={clearFilters}>
                      {t('clear')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <EmptyState
                icon={ReceiptTextIcon}
                title={t('vouchers.empty')}
                description={t('vouchers.emptyHint')}
                action={actions || undefined}
              />
            )}
          </div>
        ) : isMobile ? (
          <ResponsiveList
            columns={columns}
            rows={rows}
            loading={list.isPending}
            label={t('vouchers.title')}
            emptyText={t('vouchers.empty')}
            getRowId={(x) => x.id}
            getRowHref={href}
            renderCard={(x) => (
              <div className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-semibold text-primary">{x.party}</span>
                  <VoucherTypeBadge type={x.type} />
                </div>
                <span className="line-clamp-1 text-sm">{x.description}</span>
                <span className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                  <span>
                    <bdi>{x.number}</bdi> · {formatDate(x.date, locale)}
                  </span>
                  <Money amount={x.amount} currency={x.currency} strong />
                </span>
                {x.status === 'void' && <VoucherStatusBadge status={x.status} />}
              </div>
            )}
          />
        ) : (
          <DataTable
            bare
            columns={columns}
            data={rows}
            label={t('vouchers.title')}
            emptyText={t('vouchers.empty')}
            loading={list.isPending}
            getRowHref={href}
          />
        )}
        {meta && rows.length > 0 && (
          <ListPagination
            meta={meta}
            onPage={(page) => params.set({ page: page === 1 ? null : page }, { resetPage: false })}
            onPerPage={(perPage) => params.set({ perPage: perPage === 25 ? null : perPage })}
          />
        )}
      </Card>
      {creating && (
        <VoucherDialog
          key={creating}
          open
          defaultType={creating}
          onOpenChange={(o) => !o && setCreating(null)}
        />
      )}
    </>
  );
}
