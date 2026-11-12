'use client';

import {
  TASK_BOX_LABELS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  type TaskBox,
  type TaskDto,
  type TaskListQuery,
  type TaskPriority,
  type TaskStatus,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Label } from '@qarabic/ui/components/label';
import { Switch } from '@qarabic/ui/components/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@qarabic/ui/components/tabs';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ClipboardListIcon, MessageSquareIcon, PlusIcon, SearchXIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
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
import { isApiError } from '@/lib/api/client';
import { fetchTasks, operationsKeys } from '@/lib/api/operations';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { useDirection } from '@/lib/use-direction';
import { PriorityBadge, TaskStatusBadge, ViewerTime } from './ops-bits';
import { TaskDialog } from './task-dialog';

type StatusTab = TaskStatus | 'open' | 'all';

const href = (x: TaskDto) => `/tasks/${x.id}`;

/** The due time in the viewer's zone (D30); overdue in the destructive colour. */
function DueCell({ task: x }: { task: TaskDto }) {
  if (!x.dueAt) return <span className="text-muted-foreground">—</span>;
  return (
    <ViewerTime at={x.dueAt} className={x.overdue ? 'font-semibold text-destructive' : undefined} />
  );
}

/**
 * «المهام» (M8; the old Given / Issued boxes, docs/03 §11): «المسندة إليّ», «التي أصدرتها» and,
 * for supervisors (`tasks.oversee`), «كل المهام». Status tabs with counts (open by default),
 * priority and overdue filters, search; table on desktop, cards on phones. «مهمة جديدة» for
 * `tasks.manage`.
 */
export function TasksView() {
  const t = useTranslations('operations.tasks');
  const locale = useUiLocale();
  const dir = useDirection();
  const me = useCurrentUser();
  const params = useListParams();
  const overdueId = useId();
  const [creating, setCreating] = useState(false);
  const allowed = can(me, 'tasks.view');
  const boxes: TaskBox[] = can(me, 'tasks.oversee')
    ? ['given', 'issued', 'all']
    : ['given', 'issued'];
  const boxParam = params.get('box') as TaskBox;
  const box: TaskBox = boxes.includes(boxParam) ? boxParam : 'given';
  const statusParam = params.get('status');
  const status: StatusTab =
    statusParam === 'all' || (TASK_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as StatusTab)
      : 'open';
  const priorityParam = params.get('priority') as TaskPriority;
  const priority = TASK_PRIORITIES.includes(priorityParam) ? priorityParam : undefined;
  const overdue = params.get('overdue') === '1';
  const query: Partial<TaskListQuery> = {
    box,
    status: status === 'all' ? undefined : status,
    priority,
    overdue: overdue || undefined,
    q: params.q || undefined,
    page: params.page,
    perPage: params.perPage,
  };
  const list = useQuery({
    queryKey: operationsKeys.tasks(query),
    queryFn: ({ signal }) => fetchTasks(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  const rows = useMemo(() => list.data?.data ?? [], [list.data]);
  const meta = list.data?.meta;
  const filtersOn = !!(params.q || priority || overdue);
  const columns = useMemo<ColumnDef<TaskDto, unknown>[]>(
    () => [
      {
        id: 'title',
        header: t('fields.title'),
        cell: ({ row: { original: x } }) => (
          <span className="flex min-w-56 flex-col gap-1">
            <Link href={href(x)} className="font-semibold text-primary hover:underline">
              <Highlight text={x.title} query={params.q} />
            </Link>
            {x.comments > 0 && (
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <MessageSquareIcon className="size-4" aria-hidden />
                {t('comments', { count: x.comments })}
              </span>
            )}
          </span>
        ),
      },
      {
        id: 'person',
        header: box === 'given' ? t('fields.createdBy') : t('fields.assignee'),
        cell: ({ row: { original: x } }) => (box === 'given' ? x.createdBy : x.assignee).name,
      },
      {
        id: 'priority',
        header: t('fields.priority'),
        cell: ({ row: { original: x } }) => <PriorityBadge priority={x.priority} />,
      },
      {
        id: 'due',
        header: t('fields.due'),
        cell: ({ row: { original: x } }) => <DueCell task={x} />,
      },
      {
        id: 'status',
        header: t('fields.status'),
        cell: ({ row: { original: x } }) => (
          <TaskStatusBadge status={x.status} overdue={x.overdue} />
        ),
      },
    ],
    [t, params.q, box],
  );

  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const clearFilters = () => {
    params.setSearchInput('');
    params.set({ q: null, priority: null, overdue: null });
  };
  const newTask = can(me, 'tasks.manage') && (
    <Button className="h-10" onClick={() => setCreating(true)}>
      <PlusIcon />
      {t('new')}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t('title')}
        meta={meta ? t('count', { count: meta.total }) : undefined}
        actions={newTask}
      />
      <Tabs
        value={box}
        dir={dir}
        onValueChange={(v) => params.set({ box: v === 'given' ? null : v, status: null })}
        className="gap-4"
      >
        <TabsList className="h-auto max-w-full flex-wrap justify-start" aria-label={t('boxes')}>
          {boxes.map((b) => (
            <TabsTrigger key={b} value={b} className="h-9 px-3">
              {TASK_BOX_LABELS[b][locale]}
            </TabsTrigger>
          ))}
        </TabsList>
        {boxes.map((b) => (
          <TabsContent key={b} value={b} forceMount hidden={b !== box}>
            {b === box && (
              <Card className="gap-0 py-0 shadow-none">
                <ListToolbar
                  search={{
                    label: t('searchLabel'),
                    placeholder: t('search'),
                    value: params.searchInput,
                    onChange: params.setSearchInput,
                  }}
                  filters={
                    <>
                      <FilterSelect
                        label={t('fields.priority')}
                        value={priority ?? ''}
                        onChange={(v) => params.set({ priority: v || null })}
                        allLabel={t('allPriorities')}
                        options={TASK_PRIORITIES.map((p) => ({
                          value: p,
                          label: TASK_PRIORITY_LABELS[p][locale],
                        }))}
                      />
                      <div className="flex h-10 items-center gap-2 self-end">
                        <Switch
                          id={overdueId}
                          checked={overdue}
                          onCheckedChange={(v) => params.set({ overdue: v ? 1 : null })}
                        />
                        <Label htmlFor={overdueId} className="font-medium">
                          {t('overdueOnly')}
                        </Label>
                      </div>
                      {filtersOn && <ClearFiltersButton onClick={clearFilters} />}
                    </>
                  }
                  tabs={
                    <StatusTabs
                      label={t('statusTabs')}
                      value={status}
                      onChange={(v) => params.set({ status: v === 'open' || !v ? null : v })}
                      options={[
                        {
                          value: 'open',
                          label: t('open'),
                          count: meta
                            ? (meta.counts.pending ?? 0) + (meta.counts.awaiting ?? 0)
                            : undefined,
                        },
                        ...TASK_STATUSES.map((s) => ({
                          value: s,
                          label: TASK_STATUS_LABELS[s][locale],
                          count: meta?.counts[s],
                        })),
                        { value: 'all', label: t('all'), count: meta?.counts.all },
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
                    <EmptyState
                      icon={filtersOn ? SearchXIcon : ClipboardListIcon}
                      role="status"
                      title={filtersOn ? t('noResults') : t('empty')}
                      description={filtersOn ? t('noResultsHint') : t(`emptyHint.${box}`)}
                      action={
                        filtersOn ? (
                          <Button variant="outline" onClick={clearFilters}>
                            {t('clear')}
                          </Button>
                        ) : undefined
                      }
                    />
                  </div>
                ) : (
                  <ResponsiveList
                    columns={columns}
                    rows={rows}
                    loading={list.isPending}
                    label={t('title')}
                    emptyText={t('empty')}
                    getRowId={(x) => x.id}
                    getRowHref={href}
                    renderCard={(x) => (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-start justify-between gap-2">
                          <span className="min-w-0 font-semibold text-primary">{x.title}</span>
                          <TaskStatusBadge status={x.status} overdue={x.overdue} />
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {box === 'given'
                            ? t('from', { name: x.createdBy.name })
                            : t('to', { name: x.assignee.name })}
                        </span>
                        <span className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <DueCell task={x} />
                          <PriorityBadge priority={x.priority} />
                        </span>
                      </div>
                    )}
                  />
                )}
                {meta && rows.length > 0 && (
                  <ListPagination
                    meta={meta}
                    onPage={(page) =>
                      params.set({ page: page === 1 ? null : page }, { resetPage: false })
                    }
                    onPerPage={(perPage) =>
                      params.set({ perPage: perPage === 25 ? null : perPage })
                    }
                  />
                )}
              </Card>
            )}
          </TabsContent>
        ))}
      </Tabs>
      {creating && <TaskDialog open onOpenChange={setCreating} />}
    </>
  );
}
