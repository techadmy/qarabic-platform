'use client';

import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_CHANNEL_LABELS,
  TICKET_CHANNELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_STATUSES,
  type TicketDto,
  type TicketListQuery,
} from '@qarabic/shared';
import { Card } from '@qarabic/ui/components/card';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo } from 'react';
import { ListPagination } from '@/components/list/list-pagination';
import {
  ClearFiltersButton,
  FilterSelect,
  ListToolbar,
  StatusTabs,
} from '@/components/list/list-toolbar';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { useNow, useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchTickets, supportKeys } from '@/lib/api/support';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { relativeTime } from '@/lib/schedule-time';
import { topicLabel } from '@/lib/support/labels';
import { PriorityBadge, SlaBadge, TicketStatusBadge } from './badges';

/** Status tabs: the open lifecycle first, then everything closed, then all. */
/** `any` = every status (the StatusTabs «الكل» slot is the default tab, «المفتوحة»). */
const TABS = ['open', ...TICKET_STATUSES, 'closed', 'any'] as const;
type Tab = (typeof TABS)[number];
const SORTS = ['newest', 'priority', 'updated'] as const;

/**
 * «فرز البلاغات» (`feedback.review`, docs/22 §6): every «تواصل معنا» ticket in one list, the
 * status tabs with their counts, filters for priority, topic, channel and assignee, the search and
 * the sort — all in the URL. A row opens the ticket with its triage panel.
 */
export function TriageView() {
  const t = useTranslations('support.feedback');
  const ts = useTranslations('support');
  const ti = useTranslations('support.inbox');
  const tl = useTranslations('list');
  const locale = useUiLocale();
  const now = useNow(60_000);
  const me = useCurrentUser();
  const params = useListParams();
  const allowed = can(me, 'feedback.review');
  const tabParam = params.get('status') as Tab;
  const tab: Tab = TABS.includes(tabParam) ? tabParam : 'open';
  const priority = params.get('priority');
  const category = params.get('category');
  const channel = params.get('channel');
  const assignee = params.get('assignee');
  const sortParam = params.get('sort') as (typeof SORTS)[number];
  const sort = SORTS.includes(sortParam) ? sortParam : 'newest';
  const query: TicketListQuery = {
    scope: 'all',
    status: tab === 'any' ? undefined : [tab],
    priority: priority ? [priority as 'p0'] : undefined,
    category: category ? [category as 'technical'] : undefined,
    channel: (channel || undefined) as TicketListQuery['channel'],
    assigneeId: assignee === 'none' ? 'none' : undefined,
    q: params.q || undefined,
    sort,
    page: params.page,
    perPage: params.perPage,
  };
  const list = useQuery({
    queryKey: supportKeys.tickets(query),
    // Lists go out as `a,b` (toSearchParams), which the API reads as a list.
    queryFn: ({ signal }) => fetchTickets(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });

  const columns = useMemo<ColumnDef<TicketDto, unknown>[]>(
    () => [
      {
        id: 'title',
        header: t('columns.title'),
        cell: ({ row }) => (
          <div className="flex min-w-60 flex-col gap-0.5">
            <Link
              href={`/tickets/${row.original.id}`}
              className="font-semibold text-primary hover:underline"
            >
              <bdi>{row.original.number}</bdi> · {row.original.title}
            </Link>
            <span className="text-sm text-muted-foreground">
              {topicLabel(row.original, locale)}
            </span>
          </div>
        ),
      },
      {
        id: 'status',
        header: t('columns.status'),
        cell: ({ row }) => (
          <div className="flex flex-col items-start gap-1">
            <TicketStatusBadge status={row.original.status} />
            <SlaBadge dueAt={row.original.slaDueAt} state={row.original.slaState} />
          </div>
        ),
      },
      {
        id: 'priority',
        header: t('columns.priority'),
        cell: ({ row }) => <PriorityBadge priority={row.original.priority} />,
      },
      {
        id: 'reporter',
        header: t('columns.reporter'),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span>{row.original.reporter?.name ?? '—'}</span>
            <span className="text-sm text-muted-foreground">
              {TICKET_CHANNEL_LABELS[row.original.channel][locale]}
            </span>
          </div>
        ),
      },
      {
        id: 'assignee',
        header: t('columns.assignee'),
        cell: ({ row }) =>
          row.original.assignee?.name ?? (
            <span className="text-muted-foreground">{ti('unassignedLabel')}</span>
          ),
      },
      {
        id: 'updated',
        header: t('columns.updated'),
        cell: ({ row }) => (
          <span className="whitespace-nowrap">
            {relativeTime(row.original.updatedAt, now, locale)}
          </span>
        ),
      },
    ],
    [t, ti, locale, now],
  );

  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const meta = list.data?.meta;
  const rows = list.data?.data ?? [];
  const filtered = !!(priority || category || channel || assignee || params.q);
  const tabLabel = (k: Tab) =>
    k === 'any'
      ? ts('status.all')
      : k === 'open' || k === 'closed'
        ? ts(`status.${k}`)
        : TICKET_STATUS_LABELS[k][locale];

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        meta={meta ? ti('count', { count: meta.total }) : undefined}
      />
      <Card className="gap-0 py-0 shadow-none">
        <ListToolbar
          search={{
            label: t('search'),
            placeholder: t('searchPlaceholder'),
            value: params.searchInput,
            onChange: params.setSearchInput,
          }}
          filters={
            <>
              <FilterSelect
                label={ti('filters.priority')}
                value={priority}
                allLabel={ti('filters.any')}
                onChange={(v) => params.set({ priority: v || null })}
                options={[
                  ...TICKET_PRIORITIES.map((p) => ({
                    value: p,
                    label: TICKET_PRIORITY_LABELS[p][locale],
                  })),
                  { value: 'none', label: ts('priorityNone') },
                ]}
              />
              <FilterSelect
                label={ti('filters.category')}
                value={category}
                allLabel={ti('filters.any')}
                onChange={(v) => params.set({ category: v || null })}
                options={TICKET_CATEGORIES.map((c) => ({
                  value: c,
                  label: TICKET_CATEGORY_LABELS[c][locale],
                }))}
              />
              <FilterSelect
                label={t('channel')}
                value={channel}
                allLabel={ti('filters.any')}
                onChange={(v) => params.set({ channel: v || null })}
                options={TICKET_CHANNELS.map((c) => ({
                  value: c,
                  label: TICKET_CHANNEL_LABELS[c][locale],
                }))}
              />
              <FilterSelect
                label={ti('filters.assignee')}
                value={assignee}
                allLabel={ti('filters.any')}
                onChange={(v) => params.set({ assignee: v || null })}
                options={[{ value: 'none', label: ti('filters.unassigned') }]}
              />
              <FilterSelect
                label={t('sort')}
                value={sort}
                onChange={(v) => params.set({ sort: v === 'newest' ? null : v })}
                options={SORTS.map((s) => ({ value: s, label: t(`sorts.${s}`) }))}
              />
              {filtered && (
                <ClearFiltersButton
                  onClick={() => params.clear(['priority', 'category', 'channel', 'assignee'])}
                />
              )}
            </>
          }
          tabs={
            <StatusTabs
              label={tl('statusFilter')}
              value={tab === 'open' ? '' : tab}
              onChange={(v) => params.set({ status: v || null })}
              options={TABS.map((k) => ({
                value: k === 'open' ? '' : k,
                label: tabLabel(k),
                count: meta?.counts[k === 'any' ? 'all' : k],
              }))}
            />
          }
        />
        {list.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : (
          <ResponsiveList
            columns={columns}
            rows={rows}
            loading={list.isPending}
            label={t('title')}
            emptyText={filtered || tab !== 'open' ? tl('noResults') : t('empty')}
            getRowId={(r) => r.id}
            getRowHref={(r) => `/tickets/${r.id}`}
            renderCard={(r) => (
              <div className="flex flex-col gap-1.5">
                <span className="font-semibold text-primary">
                  <bdi>{r.number}</bdi> · {r.title}
                </span>
                <span className="text-sm text-muted-foreground">{topicLabel(r, locale)}</span>
                <span className="flex flex-wrap gap-2">
                  <TicketStatusBadge status={r.status} />
                  <PriorityBadge priority={r.priority} />
                </span>
              </div>
            )}
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
