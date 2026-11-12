'use client';

import {
  INVOICE_STATUS_LABELS,
  type BillingSummaryDto,
  INVOICE_TAB_LABELS,
  type InvoiceDto,
  type InvoiceListQuery,
  type InvoiceTab,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Input } from '@qarabic/ui/components/input';
import { Label } from '@qarabic/ui/components/label';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { useIsMobile } from '@qarabic/ui/hooks/use-mobile';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { CalendarPlusIcon, ReceiptTextIcon, SearchXIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import type { ColumnMeta } from '@/components/data-table';
import { DataTable } from '@/components/data-table';
import { ListPagination } from '@/components/list/list-pagination';
import { ClearFiltersButton, ListToolbar, StatusTabs } from '@/components/list/list-toolbar';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { Highlight } from '@/components/people/people-list';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { billingKeys, fetchBillingSummary, fetchInvoices } from '@/lib/api/billing';
import { can } from '@/lib/auth/use-me';
import { monthLabel, periodLabel } from '@/lib/billing/labels';
import { minorOf } from '@/lib/billing/money';
import { useListParams } from '@/lib/list-params';
import { formatDate } from '@/lib/time';
import { InvoiceStatusBadge, Money } from './billing-bits';
import { InvoiceRunDialog } from './invoice-run-dialog';

const TABS = [
  'all',
  'open',
  'overdue',
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'void',
  'split',
] as const;
type Tab = (typeof TABS)[number];

/**
 * «الفواتير» for staff (docs/20 §12, the current app's `InvoicesPage`): the amounts per currency
 * first (due, overdue, collected this month), then the list-page standard (search by number or
 * family, the month filter, status tabs with counts incl. the derived «متأخرة»), table on desktop
 * and cards on phones, everything in the URL. Primary action: «إصدار فواتير الشهر».
 */
export function InvoicesView() {
  const t = useTranslations('billing');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const isMobile = useIsMobile();
  const monthId = useId();
  const allowed = can(me, 'invoices.view');
  const manage = can(me, 'invoices.manage');
  const seesKpi = manage || can(me, 'reports.financial');
  const [running, setRunning] = useState(false);
  const tabParam = params.get('status') as Tab;
  const tab: Tab = TABS.includes(tabParam) ? tabParam : 'all';
  const period = params.get('period');
  const periodValid = /^\d{4}-(0[1-9]|1[0-2])$/.test(period);

  const query: InvoiceListQuery = {
    status: tab === 'all' ? undefined : (tab as InvoiceTab),
    q: params.q || undefined,
    period: periodValid ? period : undefined,
    page: params.page,
    perPage: params.perPage,
  };
  const list = useQuery({
    queryKey: billingKeys.invoices(query),
    queryFn: ({ signal }) => fetchInvoices(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  const summary = useQuery({
    queryKey: billingKeys.summary,
    queryFn: ({ signal }) => fetchBillingSummary(signal),
    enabled: allowed && seesKpi,
  });

  const rows = useMemo(() => list.data?.data ?? [], [list.data]);
  const meta = list.data?.meta;
  const filtersOn = !!(params.q || periodValid);
  const href = (x: InvoiceDto) => `/invoices/${x.id}`;

  const columns = useMemo<ColumnDef<InvoiceDto, unknown>[]>(
    () => [
      {
        id: 'number',
        header: t('fields.number'),
        cell: ({ row: { original: x } }) => (
          <Link href={href(x)} className="font-semibold text-primary hover:underline">
            <bdi>
              {x.number ? <Highlight text={x.number} query={params.q} /> : t('detail.draftTitle')}
            </bdi>
          </Link>
        ),
      },
      {
        id: 'family',
        header: t('fields.family'),
        cell: ({ row: { original: x } }) => <Highlight text={x.family.name} query={params.q} />,
      },
      {
        id: 'period',
        header: t('fields.period'),
        cell: ({ row: { original: x } }) => (
          <span className="text-muted-foreground">{periodLabel(x, locale) ?? '—'}</span>
        ),
      },
      {
        id: 'due',
        header: t('fields.dueDate'),
        cell: ({ row: { original: x } }) => (
          <span className={x.isOverdue ? 'font-semibold text-destructive' : undefined}>
            {formatDate(x.dueDate, locale) ?? '—'}
          </span>
        ),
      },
      {
        id: 'total',
        header: t('fields.total'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: x } }) => <Money amount={x.total} currency={x.currency} />,
      },
      {
        id: 'balance',
        header: t('fields.balance'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: x } }) => (
          <Money amount={x.balance} currency={x.currency} strong={minorOf(x.balance) > 0} />
        ),
      },
      {
        id: 'status',
        header: t('fields.status'),
        cell: ({ row: { original: x } }) => <InvoiceStatusBadge invoice={x} />,
      },
    ],
    [t, locale, params.q],
  );

  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('invoices.title')} />
        <ForbiddenState />
      </>
    );
  }

  const clearFilters = () => {
    params.setSearchInput('');
    params.set({ q: null, period: null });
  };
  const tabLabel = (x: Tab) =>
    x === 'all'
      ? t('invoices.all')
      : x === 'open' || x === 'overdue'
        ? INVOICE_TAB_LABELS[x][locale]
        : INVOICE_STATUS_LABELS[x][locale];

  return (
    <>
      <PageHeader
        title={t('invoices.title')}
        meta={meta ? t('invoices.count', { count: meta.total }) : undefined}
        actions={
          manage && (
            <Button className="h-10" onClick={() => setRunning(true)}>
              <CalendarPlusIcon />
              {t('run.open')}
            </Button>
          )
        }
      />
      {seesKpi && <SummaryTiles summary={summary} />}
      <Card className="gap-0 py-0 shadow-none">
        <ListToolbar
          search={{
            label: t('invoices.searchLabel'),
            placeholder: t('invoices.search'),
            value: params.searchInput,
            onChange: params.setSearchInput,
          }}
          filters={
            <>
              <div className="flex min-w-40 flex-col gap-1.5">
                <Label htmlFor={monthId} className="text-caption text-muted-foreground">
                  {t('invoices.month')}
                </Label>
                <Input
                  id={monthId}
                  type="month"
                  dir="ltr"
                  value={periodValid ? period : ''}
                  onChange={(e) => params.set({ period: e.target.value || null })}
                  className="h-10 bg-card text-start"
                />
              </div>
              {filtersOn && <ClearFiltersButton onClick={clearFilters} />}
            </>
          }
          tabs={
            <StatusTabs
              label={t('invoices.tabs')}
              value={tab === 'all' ? '' : tab}
              onChange={(v) => params.set({ status: v || null })}
              options={TABS.map((x) => ({
                value: x === 'all' ? '' : x,
                label: tabLabel(x),
                count: meta?.counts[x],
              }))}
            />
          }
        />
        {list.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : !list.isPending && rows.length === 0 ? (
          <div className="p-4">
            {filtersOn || tab !== 'all' ? (
              <EmptyState
                icon={SearchXIcon}
                role="status"
                title={t('invoices.noResults')}
                description={
                  periodValid
                    ? t('invoices.noResultsMonth', { month: monthLabel(period, locale) })
                    : t('invoices.noResultsHint')
                }
                action={
                  filtersOn ? (
                    <Button variant="outline" onClick={clearFilters}>
                      {t('invoices.clear')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <EmptyState
                icon={ReceiptTextIcon}
                title={t('invoices.empty')}
                description={t('invoices.emptyHint')}
                action={
                  manage ? (
                    <Button onClick={() => setRunning(true)}>{t('run.open')}</Button>
                  ) : undefined
                }
              />
            )}
          </div>
        ) : isMobile ? (
          <ResponsiveList
            columns={columns}
            rows={rows}
            loading={list.isPending}
            label={t('invoices.title')}
            emptyText={t('invoices.empty')}
            getRowId={(x) => x.id}
            getRowHref={href}
            renderCard={(x) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-semibold text-primary">{x.family.name}</span>
                  <InvoiceStatusBadge invoice={x} />
                </div>
                <span className="text-sm text-muted-foreground">
                  <bdi>{x.number ?? t('detail.draftTitle')}</bdi>
                  {x.dueDate && ` · ${t('fields.dueDate')}: ${formatDate(x.dueDate, locale)}`}
                </span>
                <span className="text-sm">
                  {t('fields.balance')}: <Money amount={x.balance} currency={x.currency} strong />
                </span>
              </div>
            )}
          />
        ) : (
          <DataTable
            bare
            columns={columns}
            data={rows}
            label={t('invoices.title')}
            emptyText={t('invoices.empty')}
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
      {running && <InvoiceRunDialog open onOpenChange={setRunning} />}
    </>
  );
}

/** The money per currency (`GET /billing/summary`): what is due, overdue and collected this month. */
function SummaryTiles({
  summary,
}: {
  summary: { isPending: boolean; isError: boolean; data?: BillingSummaryDto };
}) {
  const t = useTranslations('billing.kpi');
  const locale = useUiLocale();
  if (summary.isError) return null;
  if (summary.isPending) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
    );
  }
  const rows = summary.data?.byCurrency ?? [];
  if (!rows.length) return null;
  return (
    <section aria-label={t('title')} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {rows.map((c) => (
        <Card key={c.currency} size="sm" className="gap-2 px-4 shadow-none">
          <h2 className="text-sm font-semibold text-muted-foreground">
            <bdi>{c.currency}</bdi>
          </h2>
          <dl className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-sm text-muted-foreground">{t('due', { count: c.openCount })}</dt>
              <dd className="text-lg font-bold">
                <Money amount={c.due} currency={c.currency} />
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-sm text-muted-foreground">
                {t('overdue', { count: c.overdueCount })}
              </dt>
              <dd className={minorOf(c.overdue) > 0 ? 'font-semibold text-destructive' : undefined}>
                <Money amount={c.overdue} currency={c.currency} />
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-sm text-muted-foreground">
                {t('collected', { month: monthLabel(summary.data!.month, locale) })}
              </dt>
              <dd>
                <Money amount={c.collectedThisMonth} currency={c.currency} />
              </dd>
            </div>
          </dl>
        </Card>
      ))}
    </section>
  );
}
