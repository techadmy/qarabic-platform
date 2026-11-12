'use client';

import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@qarabic/ui/components/tooltip';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import {
  ArchiveRestoreIcon,
  PlusIcon,
  SearchXIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { ListPagination } from '@/components/list/list-pagination';
import {
  ArchivedSwitch,
  ClearFiltersButton,
  FilterSelect,
  ListToolbar,
  StatusTabs,
} from '@/components/list/list-toolbar';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { useOpenFromUrl } from '@/components/list/open-from-url';
import { PersonSheet, type SheetTarget } from '@/components/people/person-sheet';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchPeopleList, type ListRows, type PeopleKind } from '@/lib/api/people';
import { useListParams, type ListParams } from '@/lib/list-params';
import { KINDS, statusLabel } from '@/lib/people/kinds';
import { peopleKeys, usePersonActions } from '@/lib/people/use-person-actions';

export type ListText = {
  title: string;
  description: string;
  add?: string;
  search: string;
  searchHint: string;
  tableLabel: string;
  empty: string;
  emptyDescription: string;
};

/**
 * One People list (docs/15 §5.4.1): page header with the result count and the one primary «أضف …»
 * (manage permission only), the toolbar (search, filters, «المحذوفة», status tabs with counts),
 * the table or phone cards, server pagination; loading skeleton, empty, filtered-empty, error and
 * no-access states. All state lives in the URL.
 */
export function PeopleList<K extends PeopleKind>({
  kind,
  text,
  columns,
  renderCard,
  filters,
  filterKeys = [],
  extraQuery = {},
  sortOptions,
  canManage,
  canSeeArchived,
  allowed,
  icon = UsersIcon,
  showStatusTabs = true,
}: {
  kind: K;
  text: ListText;
  columns: (params: ListParams) => ColumnDef<ListRows[K], unknown>[];
  renderCard: (row: ListRows[K]) => ReactNode;
  filters?: (params: ListParams) => ReactNode;
  /** URL keys of this list's filters (for «مسح الكل» and the query). */
  filterKeys?: string[];
  extraQuery?: Record<string, string | number | undefined>;
  sortOptions: { value: string; label: string }[];
  canManage: boolean;
  canSeeArchived: boolean;
  allowed: boolean;
  icon?: LucideIcon;
  showStatusTabs?: boolean;
}) {
  const t = useTranslations('list');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const params = useListParams();
  const [adding, setAdding] = useState(false);
  useOpenFromUrl(canManage && allowed && !!text.add, () => setAdding(true));
  const status = params.get('status');
  const archived = canSeeArchived && params.archived;
  const filterValues = Object.fromEntries(filterKeys.map((k) => [k, params.get(k) || undefined]));
  const query = {
    q: params.q || undefined,
    status: status || undefined,
    archived: archived || undefined,
    page: params.page,
    perPage: params.perPage,
    sort: params.get('sort') || undefined,
    ...filterValues,
    ...extraQuery,
  };
  const list = useQuery({
    queryKey: peopleKeys.list(kind, query),
    queryFn: ({ signal }) => fetchPeopleList(kind, query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });

  const filtered = !!params.q || !!status || filterKeys.some((k) => params.get(k));
  const meta = list.data?.meta;
  const rows = list.data?.data ?? [];

  let body: ReactNode;
  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={text.title} />
        <ForbiddenState />
      </>
    );
  } else if (list.isError) {
    body = <ErrorState onRetry={() => void list.refetch()} />;
  } else if (!list.isPending && rows.length === 0 && !filtered && !archived) {
    body = (
      <EmptyState
        icon={icon}
        title={text.empty}
        description={text.emptyDescription}
        action={
          canManage && text.add ? (
            <Button onClick={() => setAdding(true)}>
              <PlusIcon />
              {text.add}
            </Button>
          ) : undefined
        }
      />
    );
  } else if (!list.isPending && rows.length === 0) {
    body = (
      <div className="p-4">
        <EmptyState
          icon={SearchXIcon}
          role="status"
          title={params.q ? t('noResultsFor', { q: params.q }) : t('noResults')}
          description={t('noResultsHint')}
          action={<ClearFiltersButton onClick={() => params.clear(filterKeys)} />}
        />
      </div>
    );
  } else {
    body = (
      <ResponsiveList
        columns={columns(params)}
        rows={rows}
        loading={list.isPending}
        label={text.tableLabel}
        emptyText={t('noResults')}
        getRowId={(row) => (row as { id: number }).id}
        getRowHref={(row) => `${KINDS[kind].href}/${(row as { id: number }).id}`}
        renderCard={renderCard}
      />
    );
  }

  const statusOptions = [
    { value: '', label: t('all'), count: meta?.counts.all },
    ...KINDS[kind].statuses.map((s) => ({
      value: s,
      label: statusLabel(kind, s, locale),
      count: meta?.counts[s],
    })),
  ];

  return (
    <>
      <PageHeader
        title={text.title}
        meta={meta ? t('results', { count: meta.total }) : text.description}
        actions={
          canManage && text.add ? (
            <Button className="h-10 px-4" onClick={() => setAdding(true)}>
              <PlusIcon />
              {text.add}
            </Button>
          ) : undefined
        }
      />
      <Card className="gap-0 py-0 shadow-none">
        <ListToolbar
          search={{
            label: text.search,
            placeholder: text.searchHint,
            value: params.searchInput,
            onChange: params.setSearchInput,
          }}
          filters={
            <>
              <FilterSelect
                label={t('sort')}
                value={params.get('sort') || sortOptions[0]!.value}
                onChange={(v) => params.set({ sort: v === sortOptions[0]!.value ? null : v })}
                options={sortOptions}
              />
              {filters?.(params)}
              {canSeeArchived && (
                <ArchivedSwitch
                  checked={params.archived}
                  onChange={(v) => params.set({ archived: v ? 1 : null, status: null })}
                />
              )}
              {filtered && <ClearFiltersButton onClick={() => params.clear(filterKeys)} />}
            </>
          }
          tabs={
            showStatusTabs ? (
              <StatusTabs
                label={t('statusFilter')}
                value={status}
                onChange={(v) => params.set({ status: v || null })}
                options={statusOptions}
              />
            ) : undefined
          }
        />
        <div aria-live="polite" className="sr-only">
          {meta ? t('results', { count: meta.total }) : ''}
        </div>
        {body}
        {meta && rows.length > 0 && (
          <ListPagination
            meta={meta}
            onPage={(page) => params.set({ page: page === 1 ? null : page }, { resetPage: false })}
            onPerPage={(perPage) => params.set({ perPage: perPage === 25 ? null : perPage })}
          />
        )}
      </Card>
      {canManage && (
        <PersonSheet target={{ kind } as SheetTarget} open={adding} onOpenChange={setAdding} />
      )}
    </>
  );
}

/** Icon shortcut in a row (K5): a real link with a tooltip, keyboard reachable. */
export function RowShortcut({
  href,
  label,
  icon: Icon,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" asChild>
          <Link href={href} aria-label={label}>
            <Icon />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** «استعادة» on an archived row: restores with an Undo toast. */
export function RestoreButton({
  kind,
  record,
}: {
  kind: PeopleKind;
  record: { id: number; name: string; reason: string | null };
}) {
  const t = useTranslations('people');
  const actions = usePersonActions(kind);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={actions.restore.isPending}
      onClick={() => actions.restoreWithUndo(record)}
    >
      <ArchiveRestoreIcon />
      {t('archive.restore')}
      <span className="sr-only">: {record.name}</span>
    </Button>
  );
}

/** Name + secondary line in the first column: the name is a link (the row also opens it). */
export function RecordCell({
  href,
  name,
  secondary,
}: {
  href: string;
  name: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <Link href={href} className="line-clamp-2 font-semibold text-primary hover:underline">
        {name}
      </Link>
      {secondary && <span className="truncate text-sm text-muted-foreground">{secondary}</span>}
    </div>
  );
}

/** The matched part of a name in bold (docs/15 §5.4.1 `Highlight`). */
export function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const index = text.toLowerCase().indexOf(q.toLowerCase());
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-sm bg-accent px-0.5 text-inherit">
        {text.slice(index, index + q.length)}
      </mark>
      {text.slice(index + q.length)}
    </>
  );
}
