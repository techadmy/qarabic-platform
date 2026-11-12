'use client';

import {
  LEAD_SOURCE_LABELS,
  LEAD_SOURCES,
  LEAD_STATUS_LABELS,
  LOST_REASON_LABELS,
  LOST_REASONS,
  isOpenLeadStatus,
  type LeadDto,
  type LeadListQuery,
  type LeadStatus,
  type LostReason,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
import { Label } from '@qarabic/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Switch } from '@qarabic/ui/components/switch';
import { Toggle } from '@qarabic/ui/components/toggle';
import { cn } from '@qarabic/ui/lib/utils';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { SearchXIcon, SettingsIcon, UserRoundPlusIcon, UsersRoundIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DataTable } from '@/components/data-table';
import { ListPagination } from '@/components/list/list-pagination';
import { CollapsibleSummary } from '@/components/list/collapsible-summary';
import { useColumnVisibility } from '@/components/list/column-chooser';
import { ListActions } from '@/components/list/list-actions';
import { useOpenFromUrl } from '@/components/list/open-from-url';
import { ClearFiltersButton, FilterSelect, ListToolbar } from '@/components/list/list-toolbar';
import { SplitList, SplitView, useSplitView } from '@/components/list/split-view';
import { ViewsMenu } from '@/components/list/views-menu';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { Highlight, RecordCell } from '@/components/people/people-list';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import {
  assignLead,
  bulkAssignLeads,
  bulkLeadStatus,
  crmKeys,
  fetchLeadAssignees,
  fetchLeads,
  fetchLeadSummary,
} from '@/lib/api/crm';
import { can } from '@/lib/auth/use-me';
import { useIsMobile } from '@qarabic/ui/hooks/use-mobile';
import { useListParams } from '@/lib/list-params';
import { dateKeyIn, relativeTime } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';
import { LeadStatusBadge, OverdueBadge, useCrmError } from './crm-bits';
import { FunnelCard } from './funnel-card';
import { LeadWorkbench } from './lead-workbench';
import { NewLeadDialog } from './new-lead-dialog';

const TABS = [
  'open',
  'new',
  'contacted',
  'trial_scheduled',
  'trial_done',
  'converted',
  'lost',
  'spam',
  'job_applicant',
  'all',
] as const;
type Tab = (typeof TABS)[number];
const TILES = [
  'new',
  'uncontacted',
  'followUpsDue',
  'trialsToday',
  'awaitingOutcome',
  'convertedThisMonth',
] as const;
type TileKey = (typeof TILES)[number];
const TILE_FILTER: Record<TileKey, Record<string, string | null>> = {
  new: { status: 'new' },
  uncontacted: { uncontacted: '1', status: null },
  followUpsDue: { followUp: 'due', status: null },
  trialsToday: { status: 'trial_scheduled' },
  awaitingOutcome: { awaitingOutcome: '1', status: 'trial_scheduled' },
  convertedThisMonth: { status: 'converted' },
};
const FILTER_KEYS = ['assigned', 'source', 'followUp', 'uncontacted', 'awaitingOutcome'];
type Bulk = 'assign' | 'lost' | 'spam';

/**
 * «العملاء المحتملون» (docs/26 §9.1; the current app's `LeadsPage`): today's tiles (they filter),
 * the list-page standard (search, المسؤول, المصدر, المتابعات المستحقة, status tabs with counts),
 * a row «استلم» for a free lead, bulk assign / not interested / spam with a count confirm (D31),
 * and the month's conversion report under the list.
 * D141 reference list: the ten statuses are a views menu on the title, the tiles a collapsible
 * summary, the table has the column chooser, and a row opens the lead in the split view (≥ lg).
 */
export function LeadsView() {
  const t = useTranslations('crm');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const tz = useViewerTz();
  const now = useNow(60_000);
  const params = useListParams();
  const queryClient = useQueryClient();
  const message = useCrmError();
  const isMobile = useIsMobile();
  const allowed = can(me, 'leads.view');
  const manage = can(me, 'leads.manage');
  const assignAny = can(me, 'leads.assign');
  const tabParam = params.get('status') as Tab;
  const tab: Tab = TABS.includes(tabParam) ? tabParam : 'open';
  const assigned = params.get('assigned');
  const source = params.get('source');
  const due = params.get('followUp') === 'due';
  const uncontacted = params.get('uncontacted') === '1';
  const awaiting = params.get('awaitingOutcome') === '1';
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const split = useSplitView('/leads');
  useOpenFromUrl(manage && allowed, () => setAdding(true));
  const [columnVisibility, setColumnVisibility] = useColumnVisibility(`leads:${me.id}`);

  const query: LeadListQuery = {
    status: tab,
    q: params.q || undefined,
    assigned: assigned || undefined,
    source: (source || undefined) as LeadListQuery['source'],
    followUp: due ? 'due' : undefined,
    uncontacted: uncontacted ? '1' : undefined,
    awaitingOutcome: awaiting ? '1' : undefined,
    tz,
    page: params.page,
    perPage: params.perPage,
  };
  const list = useQuery({
    queryKey: crmKeys.leads(query),
    queryFn: ({ signal }) => fetchLeads(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  const summary = useQuery({
    queryKey: crmKeys.summary(tz),
    queryFn: ({ signal }) => fetchLeadSummary(tz, signal),
    enabled: allowed,
    refetchInterval: 60_000,
  });
  const assignees = useQuery({
    queryKey: crmKeys.assignees,
    queryFn: ({ signal }) => fetchLeadAssignees(signal),
    enabled: allowed,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: crmKeys.all });
  const take = useMutation({
    mutationFn: (id: number) => assignLead(id, { userId: me.id }),
    onSuccess: () => {
      toast.success(t('taken'));
      refresh();
    },
    onError: (e) => toast.error(message(e)),
  });

  const rows = useMemo(() => list.data?.data ?? [], [list.data]);
  const meta = list.data?.meta;
  const pageIds = rows.map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
  const someOnPage = pageIds.some((id) => selected.includes(id));
  const filtersOn = !!(params.q || assigned || source || due || uncontacted || awaiting);
  const endOfToday = dateKeyIn(tz, now);
  const isDue = (at: string | null) => !!at && dateKeyIn(tz, new Date(at)) <= endOfToday;
  const toggle = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const columns = useMemo<ColumnDef<LeadDto, unknown>[]>(() => {
    const cols: ColumnDef<LeadDto, unknown>[] = [];
    if (manage) {
      cols.push({
        id: 'select',
        header: () => (
          <Checkbox
            checked={allOnPage ? true : someOnPage ? 'indeterminate' : false}
            onCheckedChange={() =>
              setSelected((s) =>
                allOnPage
                  ? s.filter((id) => !pageIds.includes(id))
                  : [...new Set([...s, ...pageIds])],
              )
            }
            aria-label={t('columns.selectAll')}
          />
        ),
        meta: { className: 'w-10' },
        enableHiding: false,
        cell: ({ row: { original: x } }) => (
          <Checkbox
            checked={selected.includes(x.id)}
            onCheckedChange={() => toggle(x.id)}
            aria-label={t('columns.select', { name: x.parentName })}
          />
        ),
      });
    }
    cols.push(
      {
        id: 'name',
        header: t('columns.name'),
        enableHiding: false,
        cell: ({ row: { original: x } }) => (
          <RecordCell
            href={split.hrefFor(x.id)}
            name={<Highlight text={x.parentName} query={params.q} />}
            secondary={
              <>
                <bdi dir="ltr">{x.phone ?? x.email ?? ''}</bdi> · {cityOf(x.timezone, locale)}
              </>
            }
          />
        ),
      },
      {
        id: 'children',
        header: t('columns.children'),
        cell: ({ row: { original: x } }) => t('childrenCount', { count: x.childrenCount }),
      },
      {
        id: 'source',
        header: t('columns.source'),
        cell: ({ row: { original: x } }) => LEAD_SOURCE_LABELS[x.source][locale],
      },
      {
        id: 'status',
        header: t('columns.status'),
        cell: ({ row: { original: x } }) => (
          <span className="flex flex-wrap gap-1">
            <LeadStatusBadge status={x.status} />
            {x.firstResponseOverdue && <OverdueBadge />}
          </span>
        ),
      },
      {
        id: 'assignee',
        header: t('columns.assignee'),
        cell: ({ row: { original: x } }) =>
          x.assignedTo ? (
            x.assignedTo.name
          ) : manage && isOpenLeadStatus(x.status) ? (
            <Button
              variant="outline"
              size="sm"
              disabled={take.isPending}
              onClick={() => take.mutate(x.id)}
            >
              <UserRoundPlusIcon />
              {t('take')}
              <span className="sr-only">: {x.parentName}</span>
            </Button>
          ) : (
            <span className="text-muted-foreground">{t('unassigned')}</span>
          ),
      },
      {
        id: 'followUp',
        header: t('columns.followUp'),
        cell: ({ row: { original: x } }) =>
          x.nextFollowUpAt ? (
            <span className={cn(isDue(x.nextFollowUpAt) && 'font-semibold text-destructive')}>
              {relativeTime(x.nextFollowUpAt, now, locale)}
            </span>
          ) : (
            '—'
          ),
      },
      {
        id: 'created',
        header: t('columns.created'),
        cell: ({ row: { original: x } }) => (
          <span className="text-muted-foreground">{relativeTime(x.createdAt, now, locale)}</span>
        ),
      },
    );
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt when the rows or selection change
  }, [t, locale, manage, selected, rows, now, params.q, take.isPending, split.wide]);

  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }

  const s = summary.data;
  const tileValue: Record<TileKey, number | undefined> = {
    new: s?.new,
    uncontacted: s?.uncontacted,
    followUpsDue: s?.followUpsDue,
    trialsToday: s?.trialsToday,
    awaitingOutcome: s?.awaitingOutcome,
    convertedThisMonth: s?.convertedThisMonth,
  };
  const tileActive: Record<TileKey, boolean> = {
    new: tab === 'new' && !filtersOn,
    uncontacted: uncontacted,
    followUpsDue: due,
    trialsToday: tab === 'trial_scheduled' && !awaiting,
    awaitingOutcome: awaiting,
    convertedThisMonth: tab === 'converted' && !filtersOn,
  };
  const clearFilters = () => {
    params.setSearchInput('');
    params.set(Object.fromEntries([...FILTER_KEYS, 'q'].map((k) => [k, null])));
  };
  const selfId = String(me.id);

  const views = (
    <ViewsMenu
      title={t('title')}
      label={t('statusFilter')}
      value={tab}
      onChange={(v) => {
        setSelected([]);
        params.set({ status: v === 'open' ? null : v });
      }}
      options={TABS.map((x) => ({
        value: x,
        label:
          x === 'open' || x === 'all'
            ? t(`tabs.${x}`)
            : LEAD_STATUS_LABELS[x as LeadStatus][locale],
        count: meta?.counts[x],
      }))}
    />
  );
  const header = (
    <PageHeader
      title={views}
      meta={meta ? t('results', { count: meta.total }) : undefined}
      actions={
        <ListActions
          create={manage ? { label: t('newLead'), onClick: () => setAdding(true) } : undefined}
          more={
            can(me, 'settings.view')
              ? [{ label: t('settings.title'), icon: SettingsIcon, href: '/settings/crm' }]
              : []
          }
        />
      }
    />
  );
  const search = {
    label: t('filters.searchLabel'),
    placeholder: t('filters.search'),
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

  if (split.selectedId) {
    return (
      <>
        {header}
        <SplitView
          selectedId={split.selectedId}
          wide={split.wide}
          detailLabel={t('work.title')}
          onClose={split.close}
          fullHref={split.fullHref}
          list={
            <SplitList
              rows={rows}
              loading={list.isPending}
              label={t('title')}
              emptyText={filtersOn ? t('noResults') : t('empty')}
              getRowId={(x) => x.id}
              hrefFor={split.hrefFor}
              selectedId={split.selectedId}
              header={<ListToolbar search={search} />}
              footer={pagination}
              renderItem={(x) => (
                <span className="flex flex-col gap-1">
                  <span className="flex items-start justify-between gap-2">
                    <span className="font-semibold">{x.parentName}</span>
                    <LeadStatusBadge status={x.status} />
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {x.assignedTo?.name ?? t('unassigned')} ·{' '}
                    {relativeTime(x.createdAt, now, locale)}
                  </span>
                </span>
              )}
            />
          }
          detail={<LeadWorkbench key={split.selectedId} id={Number(split.selectedId)} />}
        />
        {adding && <NewLeadDialog open onOpenChange={setAdding} />}
      </>
    );
  }

  return (
    <>
      {header}
      <CollapsibleSummary
        storageKey={`leads:${me.id}`}
        hint={
          s
            ? `${t('tiles.uncontacted')}: ${s.uncontacted} · ${t('tiles.followUpsDue')}: ${s.followUpsDue}`
            : undefined
        }
      >
        <nav
          aria-label={t('tilesLabel')}
          className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6"
        >
          {TILES.map((k) => {
            const n = tileValue[k] ?? 0;
            return (
              <Toggle
                key={k}
                variant="outline"
                pressed={tileActive[k]}
                onPressedChange={(on) =>
                  params.set(
                    on
                      ? {
                          ...Object.fromEntries(FILTER_KEYS.map((f) => [f, null])),
                          ...TILE_FILTER[k],
                        }
                      : Object.fromEntries([...FILTER_KEYS, 'status'].map((f) => [f, null])),
                  )
                }
                className="h-auto min-h-14 flex-col items-start justify-center gap-0.5 bg-card px-4 py-2 data-[state=on]:border-primary data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
              >
                {summary.isPending ? (
                  <Skeleton className="h-6 w-8" />
                ) : (
                  <span className="flex items-baseline gap-2">
                    <bdi
                      className={cn(
                        'text-xl font-bold tabular-nums',
                        k === 'uncontacted' &&
                          (s?.firstResponseOverdue ?? 0) > 0 &&
                          'text-destructive',
                      )}
                    >
                      {n}
                    </bdi>
                    {k === 'uncontacted' && (s?.firstResponseOverdue ?? 0) > 0 && (
                      <span className="text-xs font-semibold text-destructive">
                        {t('overdueCount', { count: s!.firstResponseOverdue })}
                      </span>
                    )}
                  </span>
                )}
                <span className="text-start text-sm font-medium text-muted-foreground">
                  {t(`tiles.${k}`)}
                </span>
              </Toggle>
            );
          })}
        </nav>
      </CollapsibleSummary>
      <Card className="gap-0 py-0 shadow-none">
        <ListToolbar
          search={search}
          filters={
            <>
              <FilterSelect
                label={t('filters.assignee')}
                value={assigned}
                allLabel={t('filters.anyone')}
                onChange={(v) => params.set({ assigned: v || null })}
                options={[
                  { value: 'me', label: t('filters.me') },
                  { value: 'none', label: t('unassigned') },
                  ...(assignees.data ?? [])
                    .filter((a) => String(a.id) !== selfId)
                    .map((a) => ({ value: String(a.id), label: a.name })),
                ]}
              />
              <FilterSelect
                label={t('filters.source')}
                value={source}
                allLabel={t('filters.anySource')}
                onChange={(v) => params.set({ source: v || null })}
                options={LEAD_SOURCES.map((x) => ({
                  value: x,
                  label: LEAD_SOURCE_LABELS[x][locale],
                }))}
              />
              <SwitchFilter
                label={t('filters.dueOnly')}
                checked={due}
                onChange={(v) => params.set({ followUp: v ? 'due' : null })}
              />
              <SwitchFilter
                label={t('filters.uncontacted')}
                checked={uncontacted}
                onChange={(v) => params.set({ uncontacted: v ? '1' : null })}
              />
              {filtersOn && <ClearFiltersButton onClick={clearFilters} />}
            </>
          }
        />
        {selected.length > 0 && (
          <div
            role="region"
            aria-label={t('bulk.selected', { count: selected.length })}
            className="flex flex-wrap items-center gap-2 border-b bg-subtle px-4 py-2"
          >
            <span className="font-semibold">{t('bulk.selected', { count: selected.length })}</span>
            {assignAny && (
              <Button size="sm" variant="outline" onClick={() => setBulk('assign')}>
                {t('bulk.assign')}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setBulk('lost')}>
              {t('bulk.lost')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setBulk('spam')}>
              {t('bulk.spam')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
              {t('bulk.clear')}
            </Button>
          </div>
        )}
        {list.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : !list.isPending && rows.length === 0 ? (
          <div className="p-4">
            {filtersOn ? (
              <EmptyState
                icon={SearchXIcon}
                role="status"
                title={t('noResults')}
                description={t('noResultsHint')}
                action={
                  <Button variant="outline" onClick={clearFilters}>
                    {t('filters.clear')}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={UsersRoundIcon}
                title={t('empty')}
                description={t('emptyHint')}
                action={
                  manage ? (
                    <Button onClick={() => setAdding(true)}>{t('newLead')}</Button>
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
            label={t('title')}
            emptyText={t('empty')}
            getRowId={(x) => x.id}
            getRowHref={(x) => `/leads/${x.id}`}
            renderCard={(x) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold text-primary">{x.parentName}</span>
                  <LeadStatusBadge status={x.status} />
                </div>
                {x.firstResponseOverdue && (
                  <span>
                    <OverdueBadge />
                  </span>
                )}
                <span className="text-sm text-muted-foreground">
                  {LEAD_SOURCE_LABELS[x.source][locale]} ·{' '}
                  {t('childrenCount', { count: x.childrenCount })} · {cityOf(x.timezone, locale)}
                </span>
                <span className="text-sm">
                  {t('columns.assignee')}: {x.assignedTo?.name ?? t('unassigned')}
                  {x.nextFollowUpAt && (
                    <>
                      {' · '}
                      {t('columns.followUp')}:{' '}
                      <span
                        className={cn(isDue(x.nextFollowUpAt) && 'font-semibold text-destructive')}
                      >
                        {relativeTime(x.nextFollowUpAt, now, locale)}
                      </span>
                    </>
                  )}
                </span>
              </div>
            )}
          />
        ) : (
          <DataTable
            bare
            columns={columns}
            data={rows}
            label={t('title')}
            emptyText={t('empty')}
            loading={list.isPending}
            getRowHref={(x) => split.hrefFor(x.id)}
            getRowId={(x) => String(x.id)}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={setColumnVisibility}
          />
        )}
        {pagination}
      </Card>
      <FunnelCard />
      {adding && <NewLeadDialog open onOpenChange={setAdding} />}
      {bulk === 'assign' && (
        <BulkAssignDialog
          ids={selected}
          assignees={assignees.data ?? []}
          onDone={() => {
            setBulk(null);
            setSelected([]);
            refresh();
          }}
          onClose={() => setBulk(null)}
        />
      )}
      {(bulk === 'lost' || bulk === 'spam') && (
        <BulkStatusDialog
          kind={bulk}
          ids={selected}
          trialsBooked={rows.some((r) => selected.includes(r.id) && r.trial?.stage === 'scheduled')}
          onDone={() => {
            setBulk(null);
            setSelected([]);
            refresh();
          }}
          onClose={() => setBulk(null)}
        />
      )}
    </>
  );
}

function SwitchFilter({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex h-10 items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id} className="font-medium">
        {label}
      </Label>
    </div>
  );
}

function bulkToast(
  t: ReturnType<typeof useTranslations<'crm'>>,
  r: { updated: number[]; failed: unknown[] },
) {
  if (r.failed.length) {
    toast.warning(t('bulk.partial', { updated: r.updated.length, failed: r.failed.length }));
  } else toast.success(t('bulk.done', { count: r.updated.length }));
}

function BulkAssignDialog({
  ids,
  assignees,
  onDone,
  onClose,
}: {
  ids: number[];
  assignees: { id: number; name: string; openCount: number }[];
  onDone: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('crm');
  const message = useCrmError();
  const id = useId();
  const NONE = '__none__';
  const [to, setTo] = useState('');
  const [touched, setTouched] = useState(false);
  const run = useMutation({
    mutationFn: () => bulkAssignLeads({ ids, userId: to === NONE ? null : Number(to) }),
    onSuccess: (r) => {
      bulkToast(t, r);
      onDone();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (to) run.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('bulk.assignTitle', { count: ids.length })}</DialogTitle>
            <DialogDescription>{t('bulk.assignBody')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id}>{t('assignTo')}</Label>
            <Select value={to} onValueChange={setTo}>
              <SelectTrigger id={id} className="h-10! w-full" aria-invalid={touched && !to}>
                <SelectValue placeholder={t('choose')} />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value={NONE}>{t('unassigned')}</SelectItem>
                {assignees.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {t('assigneeOption', { name: a.name, count: a.openCount })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {touched && !to && <p className="text-sm text-destructive">{t('assignRequired')}</p>}
          </div>
          {run.isError && (
            <p role="alert" className="text-sm text-destructive">
              {message(run.error)}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t('back')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={run.isPending}>
              {run.isPending && <Spinner />}
              {t('bulk.assign')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BulkStatusDialog({
  kind,
  ids,
  trialsBooked,
  onDone,
  onClose,
}: {
  kind: 'lost' | 'spam';
  ids: number[];
  trialsBooked: boolean;
  onDone: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('crm');
  const locale = useUiLocale();
  const message = useCrmError();
  const run = useMutation({
    mutationFn: (v: { reason: string; note: string }) =>
      bulkLeadStatus({
        ids,
        status: kind,
        lostReason: kind === 'lost' ? (v.reason as LostReason) : undefined,
        note: v.note || undefined,
      }),
    onSuccess: (r) => {
      bulkToast(t, r);
      onDone();
    },
  });
  return (
    <ReasonDialog
      open
      destructive
      onOpenChange={(o) => !o && onClose()}
      title={t(kind === 'lost' ? 'bulk.lostTitle' : 'bulk.spamTitle', { count: ids.length })}
      description={`${t('bulk.body')}${trialsBooked ? ` ${t('bulk.trialsWillCancel')}` : ''}`}
      confirmLabel={t(kind === 'lost' ? 'bulk.lost' : 'bulk.spam')}
      choices={
        kind === 'lost'
          ? LOST_REASONS.map((r) => ({ value: r, label: LOST_REASON_LABELS[r][locale] }))
          : undefined
      }
      choiceLabel={t('confirm.reason')}
      textLabel={t('confirm.note')}
      busy={run.isPending}
      error={run.isError ? message(run.error) : null}
      onConfirm={({ text, choice }) => run.mutate({ reason: choice, note: text })}
    />
  );
}
