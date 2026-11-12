'use client';

import {
  CURRENCIES,
  JOURNAL_SOURCE_LABELS,
  JOURNAL_SOURCES,
  type JournalEntryRowDto,
  type JournalListQuery,
  type JournalSource,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { useIsMobile } from '@qarabic/ui/hooks/use-mobile';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { BookOpenTextIcon, PlusIcon, SearchXIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo } from 'react';
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
import { accountingKeys, fetchJournal } from '@/lib/api/accounting';
import { isApiError } from '@/lib/api/client';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { formatDate } from '@/lib/time';
import { DateRangeFilters, Money, SourceBadge } from './accounting-bits';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * «القيود اليومية» (M7, docs/07 §أ): every journal entry, newest first — manual entries, vouchers,
 * the automatic ones from billing and payroll, reversals. The list-page standard (docs/15 §5.4.1):
 * search by number or memo, currency and date filters, source tabs with counts, everything in
 * the URL. Primary action: «قيد جديد» (accounting.manage).
 */
export function JournalView() {
  const t = useTranslations('accounting');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const isMobile = useIsMobile();
  const allowed = can(me, 'accounting.view');
  const manage = can(me, 'accounting.manage');
  const sourceParam = params.get('source') as JournalSource;
  const source = JOURNAL_SOURCES.includes(sourceParam) ? sourceParam : undefined;
  const currency = (CURRENCIES as readonly string[]).includes(params.get('currency'))
    ? params.get('currency')
    : '';
  const from = DATE.test(params.get('from')) ? params.get('from') : '';
  const to = DATE.test(params.get('to')) ? params.get('to') : '';

  const query: Partial<JournalListQuery> = {
    q: params.q || undefined,
    source,
    currency: currency || undefined,
    from: from || undefined,
    to: to || undefined,
    page: params.page,
    perPage: params.perPage,
  };
  const list = useQuery({
    queryKey: accountingKeys.journal(query),
    queryFn: ({ signal }) => fetchJournal(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  const rows = useMemo(() => list.data?.data ?? [], [list.data]);
  const meta = list.data?.meta;
  const filtersOn = !!(params.q || currency || from || to);
  const href = (x: JournalEntryRowDto) => `/accounting/journal/${x.id}`;

  const columns = useMemo<ColumnDef<JournalEntryRowDto, unknown>[]>(
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
        id: 'memo',
        header: t('fields.memo'),
        cell: ({ row: { original: x } }) => (
          <span className="line-clamp-2 min-w-48">
            <Highlight text={x.memo} query={params.q} />
          </span>
        ),
      },
      {
        id: 'source',
        header: t('fields.source'),
        cell: ({ row: { original: x } }) => <SourceBadge source={x.source} />,
      },
      {
        id: 'total',
        header: t('fields.total'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: x } }) => <Money amount={x.total} currency={x.currency} />,
      },
    ],
    [t, locale, params.q],
  );

  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('journal.title')} />
        <ForbiddenState />
      </>
    );
  }

  const clearFilters = () => {
    params.setSearchInput('');
    params.set({ q: null, currency: null, from: null, to: null });
  };
  const newEntry = manage && (
    <Button className="h-10" asChild>
      <Link href="/accounting/journal/new">
        <PlusIcon />
        {t('journal.new')}
      </Link>
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t('journal.title')}
        description={t('journal.description')}
        meta={meta ? t('journal.count', { count: meta.total }) : undefined}
        actions={newEntry}
      />
      <Card className="gap-0 py-0 shadow-none">
        <ListToolbar
          search={{
            label: t('journal.searchLabel'),
            placeholder: t('journal.search'),
            value: params.searchInput,
            onChange: params.setSearchInput,
          }}
          filters={
            <>
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
              label={t('journal.tabs')}
              value={source ?? ''}
              onChange={(v) => params.set({ source: v || null })}
              options={[
                { value: '', label: t('journal.all'), count: meta?.counts.all },
                ...JOURNAL_SOURCES.map((s) => ({
                  value: s,
                  label: JOURNAL_SOURCE_LABELS[s][locale],
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
            {filtersOn || source ? (
              <EmptyState
                icon={SearchXIcon}
                role="status"
                title={t('journal.noResults')}
                description={t('journal.noResultsHint')}
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
                icon={BookOpenTextIcon}
                title={t('journal.empty')}
                description={t('journal.emptyHint')}
                action={newEntry || undefined}
              />
            )}
          </div>
        ) : isMobile ? (
          <ResponsiveList
            columns={columns}
            rows={rows}
            loading={list.isPending}
            label={t('journal.title')}
            emptyText={t('journal.empty')}
            getRowId={(x) => x.id}
            getRowHref={href}
            renderCard={(x) => (
              <div className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <bdi className="font-semibold text-primary">{x.number}</bdi>
                  <SourceBadge source={x.source} />
                </div>
                <span className="line-clamp-2 text-sm">{x.memo}</span>
                <span className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
                  {formatDate(x.date, locale)}
                  <Money amount={x.total} currency={x.currency} strong />
                </span>
              </div>
            )}
          />
        ) : (
          <DataTable
            bare
            columns={columns}
            data={rows}
            label={t('journal.title')}
            emptyText={t('journal.empty')}
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
    </>
  );
}
