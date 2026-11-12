'use client';

import {
  TEST_STATUS_LABELS,
  TEST_STATUSES,
  TEST_SUMMARY_LABELS,
  TEST_TRACK_LABELS,
  TEST_TRACKS,
  type TestDto,
  type TestStatus,
  type TestSummaryDto,
  type TestTrack,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Toggle } from '@qarabic/ui/components/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@qarabic/ui/components/tooltip';
import { cn } from '@qarabic/ui/lib/utils';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  PlusIcon,
  SearchXIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { DataTable } from '@/components/data-table';
import { ListPagination } from '@/components/list/list-pagination';
import { FilterSelect, StatusTabs } from '@/components/list/list-toolbar';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { ScheduleTestDialog } from '@/components/tests/schedule-test-dialog';
import { TestStatusBadge, TestWhen } from '@/components/tests/test-bits';
import { isApiError } from '@/lib/api/client';
import { fetchTests, fetchTestSummary, teachingKeys } from '@/lib/api/teaching';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { dateKeyIn } from '@/lib/schedule-time';
import { intlLocale } from '@/lib/time';

type Tab = 'all' | TestStatus | 'byTeacher';
const TILES = ['created', 'taken', 'remaining', 'refused'] as const;
const TILE_TAB: Record<(typeof TILES)[number], Tab> = {
  created: 'all',
  taken: 'taken',
  remaining: 'scheduled',
  refused: 'refused',
};
const TILE_TEXT: Partial<Record<(typeof TILES)[number], string>> = {
  taken: 'text-status-green-emphasis',
  remaining: 'text-status-sky-emphasis',
  refused: 'text-status-red-emphasis',
};

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * «الاختبارات والنتائج» (docs/27 §8; the current app's `TestsPage`): the month with the old
 * dashboard's tiles (المُنشأة · المنجزة · المتبقية · المرفوضة — they filter), status tabs with
 * counts, a track filter, the tests (both times, student, examiner, track, status, overall %) and
 * «حسب المعلم» for staff. A teacher gets the same page scoped to their tests (default: scheduled).
 */
export function TestsView() {
  const t = useTranslations('tests');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const staff = can(me, 'tests.manage');
  const teacherView = me.role?.kind === 'teacher';
  const allowed = can(me, 'tests.view') && me.role?.kind !== 'parent';
  const canSchedule = can(me, 'tests.manage') || can(me, 'tests.conduct');
  const thisMonth = dateKeyIn('Africa/Cairo').slice(0, 7);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(params.get('month'))
    ? params.get('month')
    : thisMonth;
  const tabs: Tab[] = ['all', ...TEST_STATUSES, ...(staff ? (['byTeacher'] as const) : [])];
  const tabParam = params.get('tab') as Tab;
  const tab: Tab = tabs.includes(tabParam) ? tabParam : teacherView ? 'scheduled' : 'all';
  const trackParam = params.get('track') as TestTrack;
  const track = TEST_TRACKS.includes(trackParam) ? trackParam : null;
  const [scheduling, setScheduling] = useState(false);
  const query = {
    month,
    status: tab === 'all' || tab === 'byTeacher' ? undefined : [tab],
    track: track ?? undefined,
    page: params.page,
    perPage: params.perPage,
  };
  const summary = useQuery({
    queryKey: teachingKeys.testSummary(month),
    queryFn: ({ signal }) => fetchTestSummary(month, signal),
    enabled: allowed,
  });
  const list = useQuery({
    queryKey: teachingKeys.testList(query),
    queryFn: ({ signal }) => fetchTests(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed && tab !== 'byTeacher',
  });
  const monthLabel = new Intl.DateTimeFormat(intlLocale(locale), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00Z`));
  const setMonth = (m: string) => params.set({ month: m === thisMonth ? null : m });
  const setTab = (v: Tab) =>
    params.set({ tab: v === (teacherView ? 'scheduled' : 'all') ? null : v });

  const columns = useMemo<ColumnDef<TestDto, unknown>[]>(
    () => [
      {
        id: 'time',
        header: t('columns.time'),
        cell: ({ row: { original: x } }) => <TestWhen test={x} />,
      },
      {
        id: 'student',
        header: t('columns.student'),
        cell: ({ row: { original: x } }) => (
          <Link href={`/tests/${x.id}`} className="font-semibold text-primary hover:underline">
            {x.student.name}
          </Link>
        ),
      },
      {
        id: 'examiner',
        header: t('columns.examiner'),
        cell: ({ row: { original: x } }) => x.teacher.name,
      },
      {
        id: 'track',
        header: t('columns.track'),
        cell: ({ row: { original: x } }) => (
          <span className="flex flex-col">
            <span>{TEST_TRACK_LABELS[x.track][locale]}</span>
            <span className="text-xs text-muted-foreground">
              {t('sectionsCount', { count: x.sections.length })}
            </span>
          </span>
        ),
      },
      {
        id: 'status',
        header: t('columns.status'),
        cell: ({ row: { original: x } }) => <TestStatusBadge status={x.status} />,
      },
      {
        id: 'overall',
        header: t('columns.overall'),
        meta: { numeric: true },
        cell: ({ row: { original: x } }) =>
          x.result ? <bdi className="font-bold">{x.result.overall}%</bdi> : '—',
      },
    ],
    [t, locale],
  );

  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const counts = summary.data?.counts;
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const title = teacherView ? t('titleTeacher') : t('title');

  return (
    <>
      <PageHeader
        title={title}
        description={t('description')}
        actions={
          canSchedule && (
            <Button onClick={() => setScheduling(true)}>
              <PlusIcon />
              {t('scheduleAction')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-lg"
              aria-label={t('prevMonth')}
              onClick={() => setMonth(shiftMonth(month, -1))}
            >
              <ChevronRightIcon className="ltr:rotate-180" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('prevMonth')}</TooltipContent>
        </Tooltip>
        <h2 className="min-w-32 text-center text-lg font-bold" aria-live="polite">
          {monthLabel}
        </h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-lg"
              aria-label={t('nextMonth')}
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              <ChevronLeftIcon className="ltr:rotate-180" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('nextMonth')}</TooltipContent>
        </Tooltip>
        {month !== thisMonth && (
          <Button variant="outline" className="h-10" onClick={() => setMonth(thisMonth)}>
            {t('thisMonth')}
          </Button>
        )}
      </div>
      <nav aria-label={t('tilesLabel')} className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {TILES.map((k) => {
          const n = counts?.[k] ?? 0;
          const active = tab === TILE_TAB[k];
          return (
            <Toggle
              key={k}
              variant="outline"
              pressed={active}
              onPressedChange={() => setTab(TILE_TAB[k])}
              className="h-14 justify-start gap-2 bg-card px-4 data-[state=on]:border-primary data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
            >
              {summary.isPending ? (
                <Skeleton className="h-6 w-8" />
              ) : (
                <span className={cn('text-xl font-bold tabular-nums', n > 0 && TILE_TEXT[k])}>
                  <bdi>{n}</bdi>
                </span>
              )}
              <span className="text-sm font-medium text-muted-foreground">
                {TEST_SUMMARY_LABELS[k][locale]}
              </span>
            </Toggle>
          );
        })}
      </nav>
      <Card className="gap-0 py-0 shadow-none">
        <div className="flex flex-col gap-3 border-b p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
              <StatusTabs
                label={t('statusFilter')}
                value={tab === 'all' ? '' : tab}
                onChange={(v) => setTab((v || 'all') as Tab)}
                options={tabs.map((x) => ({
                  value: x === 'all' ? '' : x,
                  label:
                    x === 'all'
                      ? t('tabs.all')
                      : x === 'byTeacher'
                        ? t('tabs.byTeacher')
                        : TEST_STATUS_LABELS[x][locale],
                  count: x === 'byTeacher' ? undefined : meta?.counts[x === 'all' ? 'all' : x],
                }))}
              />
            </div>
            {tab !== 'byTeacher' && (
              <FilterSelect
                label={t('track')}
                value={track ?? ''}
                allLabel={t('allTracks')}
                onChange={(v) => params.set({ track: v || null })}
                options={TEST_TRACKS.map((x) => ({
                  value: x,
                  label: TEST_TRACK_LABELS[x][locale],
                }))}
              />
            )}
          </div>
        </div>
        {tab === 'byTeacher' ? (
          summary.isError ? (
            <div className="p-4">
              <ErrorState onRetry={() => void summary.refetch()} />
            </div>
          ) : (
            <ByTeacher summary={summary.data} loading={summary.isPending} />
          )
        ) : list.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : !list.isPending && rows.length === 0 ? (
          <div className="p-4">
            {track ? (
              <EmptyState
                icon={SearchXIcon}
                role="status"
                title={t('noResults')}
                description={t('noResultsHint')}
                action={
                  <Button variant="outline" onClick={() => params.set({ track: null })}>
                    {t('clearAll')}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={ClipboardListIcon}
                title={teacherView ? t('emptyTeacher') : t('empty')}
                description={t('emptyHint')}
                action={
                  canSchedule ? (
                    <Button onClick={() => setScheduling(true)}>{t('scheduleAction')}</Button>
                  ) : undefined
                }
              />
            )}
          </div>
        ) : (
          <ResponsiveList
            columns={columns}
            rows={rows}
            loading={list.isPending}
            label={title}
            emptyText={t('empty')}
            getRowId={(x) => x.id}
            getRowHref={(x) => `/tests/${x.id}`}
            renderCard={(x) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold text-primary">{x.student.name}</span>
                  {x.result && <bdi className="text-lg font-bold">{x.result.overall}%</bdi>}
                </div>
                <TestWhen test={x} />
                <span className="text-sm text-muted-foreground">
                  {TEST_TRACK_LABELS[x.track][locale]} · {x.teacher.name}
                </span>
                <TestStatusBadge status={x.status} />
              </div>
            )}
          />
        )}
        {tab !== 'byTeacher' && meta && rows.length > 0 && (
          <ListPagination
            meta={meta}
            onPage={(page) => params.set({ page: page === 1 ? null : page }, { resetPage: false })}
            onPerPage={(perPage) => params.set({ perPage: perPage === 25 ? null : perPage })}
          />
        )}
      </Card>
      {scheduling && (
        <ScheduleTestDialog open onOpenChange={setScheduling} canPickExaminer={staff} />
      )}
    </>
  );
}

function ByTeacher({ summary, loading }: { summary?: TestSummaryDto; loading: boolean }) {
  const t = useTranslations('tests');
  const locale = useUiLocale();
  type Row = TestSummaryDto['byTeacher'][number];
  const columns: ColumnDef<Row, unknown>[] = [
    { id: 'teacher', header: t('columns.examiner'), cell: ({ row }) => row.original.teacher.name },
    ...(['created', 'taken', 'remaining', 'refused'] as const).map(
      (k): ColumnDef<Row, unknown> => ({
        id: k,
        header: TEST_SUMMARY_LABELS[k][locale],
        meta: { numeric: true },
        cell: ({ row }) => <bdi>{row.original[k]}</bdi>,
      }),
    ),
  ];
  return (
    <DataTable
      bare
      columns={columns}
      data={summary?.byTeacher ?? []}
      label={t('tabs.byTeacher')}
      emptyText={t('empty')}
      loading={loading}
    />
  );
}
