'use client';

import { Badge } from '@qarabic/ui/components/badge';
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
import { fixFirstColumn, useColumnVisibility } from '@/components/list/column-chooser';
import { ListActions } from '@/components/list/list-actions';
import { ResponsiveList } from '@/components/list/responsive-list';
import { SplitList, SplitView, useSplitView } from '@/components/list/split-view';
import { MAX_STATUS_TABS, ViewsMenu } from '@/components/list/views-menu';
import { useCurrentUser } from '@/components/shell/app-shell';
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
 * One People list (docs/15 §5.4.1, with the D141 patterns of §5.4.2: views menu over five views,
 * `ListActions`, the column chooser and, when `renderDetail` is given, the split view): page header with the result count and the one primary «أضف …»
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
  renderDetail,
  renderSplitItem,
}: {
  kind: K;
  text: ListText;
  /** `recordHref` opens a record: in the split view when there is room, else its full page. */
  columns: (
    params: ListParams,
    recordHref: (id: number) => string,
  ) => ColumnDef<ListRows[K], unknown>[];
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
  /** The record view shown beside the list from 1024 px (D141 §1 split view). */
  renderDetail?: (id: number) => ReactNode;
  /** One narrowed row in the split view (name + status chip + one line); defaults to the card. */
  renderSplitItem?: (row: ListRows[K]) => ReactNode;
}) {
  const t = useTranslations('list');
  const tp = useTranslations('people.detail');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const params = useListParams();
  const me = useCurrentUser();
  const [adding, setAdding] = useState(false);
  const split = useSplitView(KINDS[kind].href);
  const [columnVisibility, setColumnVisibility] = useColumnVisibility(`${kind}:${me.id}`);
  const recordHref = (id: number) =>
    renderDetail ? split.hrefFor(id) : `${KINDS[kind].href}/${id}`;
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
        columns={fixFirstColumn(columns(params, recordHref))}
        rows={rows}
        loading={list.isPending}
        label={text.tableLabel}
        emptyText={t('noResults')}
        getRowId={(row) => (row as { id: number }).id}
        getRowHref={(row) => recordHref((row as { id: number }).id)}
        renderCard={renderCard}
        columnVisibility={columnVisibility}
        onColumnVisibilityChange={setColumnVisibility}
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

  // More than five views: they move into the title (D141 §2); five or fewer stay tabs.
  // «الكل» does not count (docs/15 §5.4.2): families' five statuses stay tabs.
  const useViews = showStatusTabs && KINDS[kind].statuses.length > MAX_STATUS_TABS;
  const header = (
    <PageHeader
      title={
        useViews ? (
          <ViewsMenu
            title={text.title}
            label={t('statusFilter')}
            value={status}
            onChange={(v) => params.set({ status: v || null })}
            options={statusOptions}
          />
        ) : (
          text.title
        )
      }
      meta={meta ? t('results', { count: meta.total }) : text.description}
      actions={
        <ListActions
          create={
            canManage && text.add ? { label: text.add, onClick: () => setAdding(true) } : undefined
          }
        />
      }
    />
  );
  const search = {
    label: text.search,
    placeholder: text.searchHint,
    value: params.searchInput,
    onChange: params.setSearchInput,
  };
  const pagination = meta && rows.length > 0 && (
    <ListPagination
      meta={meta}
      onPage={(page) => params.set({ page: page === 1 ? null : page }, { resetPage: false })}
      onPerPage={(perPage) => params.set({ perPage: perPage === 25 ? null : perPage })}
    />
  );
  const sheet = canManage && (
    <PersonSheet target={{ kind } as SheetTarget} open={adding} onOpenChange={setAdding} />
  );

  const extraFilters = filterKeys.filter((k) => params.get(k)).length;
  const activeFilters = !!status || archived || extraFilters > 0;
  if (renderDetail && split.selectedId) {
    return (
      <>
        {header}
        <SplitView
          selectedId={split.selectedId}
          wide={split.wide}
          detailLabel={tp(kind as PeopleKind)}
          onClose={split.close}
          fullHref={split.fullHref}
          list={
            <SplitList
              rows={rows}
              loading={list.isPending}
              label={text.tableLabel}
              emptyText={t('noResults')}
              getRowId={(row) => (row as { id: number }).id}
              hrefFor={split.hrefFor}
              selectedId={split.selectedId}
              header={
                <>
                  <ListToolbar search={search} />
                  {activeFilters && (
                    // The tabs and filters are not in the narrowed list: say what narrows it and
                    // offer the way out (D141 §1).
                    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
                      <span className="text-muted-foreground">{t('activeFilters')}</span>
                      {status && (
                        <Badge variant="secondary">{statusLabel(kind, status, locale)}</Badge>
                      )}
                      {archived && <Badge variant="secondary">{t('archived')}</Badge>}
                      {extraFilters > 0 && (
                        <Badge variant="secondary">
                          {t('moreFilters', { count: extraFilters })}
                        </Badge>
                      )}
                      <ClearFiltersButton
                        onClick={() => params.clear([...filterKeys, 'archived'])}
                      />
                    </div>
                  )}
                </>
              }
              footer={pagination}
              renderItem={renderSplitItem ?? renderCard}
            />
          }
          detail={renderDetail(Number(split.selectedId))}
        />
        {sheet}
      </>
    );
  }

  return (
    <>
      {header}
      <Card className="gap-0 py-0 shadow-none">
        <ListToolbar
          search={search}
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
            showStatusTabs && !useViews ? (
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
        {pagination}
      </Card>
      {sheet}
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
