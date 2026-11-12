'use client';

import {
  REPORT_STATE_LABELS,
  REPORT_STATES,
  type ReportListItemDto,
  type ReportState,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Label } from '@qarabic/ui/components/label';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ClipboardCheckIcon, SearchXIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Combobox } from '@/components/forms/fields';
import { DatePicker } from '@/components/forms/date-time';
import { ListPagination } from '@/components/list/list-pagination';
import { ClearFiltersButton, StatusTabs } from '@/components/list/list-toolbar';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { RatingStars, ReportStateBadge } from '@/components/reports/report-bits';
import { StageBadge } from '@/components/sessions/badges';
import { SessionSheet, useOpenSession } from '@/components/sessions/session-sheet';
import { OtherTime, useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchPeopleList } from '@/lib/api/people';
import { fetchLessonReports, teachingKeys } from '@/lib/api/teaching';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { addDays, dayAndClock, isDateKey, relativeTime, zonedInstant } from '@/lib/schedule-time';

/**
 * «تقارير الحصص» (staff; a teacher sees their own): ended and taken classes with where their
 * lesson report stands — tabs with counts (بانتظار التقرير · بلا تقرير · سُلّم في موعده · سُلّم
 * متأخرًا), a teacher filter and a date range; the class opens in the sheet with its report. The
 * board's «بلا تقرير» links here with `?state=missing`. The current app had only the board tile.
 */
export function LessonReportsView() {
  const t = useTranslations('reports.list');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const now = useNow(60_000);
  const me = useCurrentUser();
  const params = useListParams();
  const pathname = usePathname();
  const search = useSearchParams();
  const { open } = useOpenSession();
  const allowed = can(me, 'sessions.view') && me.role?.kind !== 'parent';
  const stateParam = params.get('state') as ReportState;
  const state = REPORT_STATES.includes(stateParam) ? stateParam : null;
  const teacher = Number(params.get('teacher')) || null;
  const from = isDateKey(params.get('from')) ? params.get('from') : '';
  const to = isDateKey(params.get('to')) ? params.get('to') : '';
  const query = {
    state: state ? [state] : undefined,
    teacherId: teacher ?? undefined,
    from: from ? zonedInstant(from, '00:00', tz) : undefined,
    to: to ? zonedInstant(addDays(to, 1), '00:00', tz) : undefined,
    page: params.page,
    perPage: params.perPage,
  };
  const list = useQuery({
    queryKey: teachingKeys.reports(query),
    queryFn: ({ signal }) => fetchLessonReports(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  const showTeachers = can(me, 'staff.view');
  const [teacherSearch, setTeacherSearch] = useState('');
  const teachers = useQuery({
    queryKey: ['people', 'teachers', 'options', teacherSearch],
    queryFn: ({ signal }) =>
      fetchPeopleList('teachers', { q: teacherSearch, perPage: 25, status: 'active' }, signal),
    enabled: allowed && showTeachers,
  });
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const filtered = !!teacher || !!from || !!to;
  const hrefOf = (r: ReportListItemDto) => {
    const next = new URLSearchParams(search.toString());
    next.set('session', String(r.session.id));
    next.delete('report');
    return `${pathname}?${next.toString()}`;
  };

  const columns = useMemo<ColumnDef<ReportListItemDto, unknown>[]>(
    () => [
      {
        id: 'time',
        header: t('columns.time'),
        cell: ({ row: { original: r } }) => (
          <span className="flex flex-col">
            <bdi className="font-semibold">{dayAndClock(r.session.startsAt, tz, locale)}</bdi>
            <OtherTime at={r.session.startsAt} tz={r.session.student.timezone} party="student" />
          </span>
        ),
      },
      {
        id: 'student',
        header: t('columns.student'),
        cell: ({ row: { original: r } }) => (
          <button
            type="button"
            onClick={() => open(r.session.id)}
            className="text-start font-semibold text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
          >
            {r.session.student.name}
          </button>
        ),
      },
      {
        id: 'teacher',
        header: t('columns.teacher'),
        cell: ({ row: { original: r } }) => r.session.teacher.name,
      },
      {
        id: 'course',
        header: t('columns.course'),
        cell: ({ row: { original: r } }) =>
          locale === 'ar' ? r.session.course.nameAr : r.session.course.nameEn,
      },
      {
        id: 'state',
        header: t('columns.state'),
        cell: ({ row: { original: r } }) => (
          <span className="flex flex-col items-start gap-1">
            <ReportStateBadge state={r.state} />
            {r.state !== 'on_time' && r.state !== 'late' && <StageBadge session={r.session} />}
          </span>
        ),
      },
      {
        id: 'submitted',
        header: t('columns.submitted'),
        cell: ({ row: { original: r } }) => <Submitted item={r} now={now} />,
      },
      {
        id: 'rating',
        header: t('columns.rating'),
        cell: ({ row: { original: r } }) =>
          r.report?.rating ? <RatingStars value={r.report.rating} /> : '—',
      },
    ],
    [t, tz, locale, open, now],
  );

  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t('title')}
        meta={meta ? t('count', { count: meta.total }) : undefined}
        description={t('description')}
      />
      <Card className="gap-0 py-0 shadow-none">
        <div className="flex flex-col gap-3 border-b p-4">
          <div role="search" className="flex flex-wrap items-end gap-3">
            {showTeachers && (
              <div className="flex w-full flex-col gap-1.5 sm:w-60">
                <Label htmlFor="reports-teacher" className="text-[0.8125rem] text-muted-foreground">
                  {t('teacher')}
                </Label>
                <Combobox
                  id="reports-teacher"
                  value={teacher ? String(teacher) : null}
                  onChange={(v) => params.set({ teacher: v })}
                  options={(teachers.data?.data ?? []).map((x) => ({
                    value: String(x.id),
                    label: x.name,
                  }))}
                  placeholder={t('allTeachers')}
                  searchPlaceholder={t('searchTeacher')}
                  shouldFilter={false}
                  onSearch={setTeacherSearch}
                  loading={teachers.isFetching}
                  clearable
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reports-from" className="text-[0.8125rem] text-muted-foreground">
                {t('from')}
              </Label>
              <DatePicker
                id="reports-from"
                value={from}
                max={to || undefined}
                onChange={(v) => params.set({ from: v })}
                className="w-44"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reports-to" className="text-[0.8125rem] text-muted-foreground">
                {t('to')}
              </Label>
              <DatePicker
                id="reports-to"
                value={to}
                min={from || undefined}
                onChange={(v) => params.set({ to: v })}
                className="w-44"
              />
            </div>
            {filtered && (
              <ClearFiltersButton
                onClick={() => params.set({ teacher: null, from: null, to: null })}
              />
            )}
          </div>
          <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
            <StatusTabs
              label={t('stateFilter')}
              value={state ?? ''}
              onChange={(v) => params.set({ state: v || null })}
              options={[
                { value: '', label: t('all'), count: meta?.counts.all },
                ...REPORT_STATES.map((k) => ({
                  value: k,
                  label: REPORT_STATE_LABELS[k][locale],
                  count: meta?.counts[k],
                })),
              ]}
            />
          </div>
        </div>
        {list.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : !list.isPending && rows.length === 0 ? (
          <div className="p-4">
            {filtered || state ? (
              <EmptyState
                icon={SearchXIcon}
                role="status"
                title={state === 'missing' && !filtered ? t('noneMissing') : t('noResults')}
                description={
                  state === 'missing' && !filtered ? t('noneMissingHint') : t('noResultsHint')
                }
                action={
                  filtered ? (
                    <Button
                      variant="outline"
                      onClick={() => params.set({ teacher: null, from: null, to: null })}
                    >
                      {t('clearAll')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <EmptyState
                icon={ClipboardCheckIcon}
                title={t('empty')}
                description={t('emptyHint')}
              />
            )}
          </div>
        ) : (
          <ResponsiveList
            columns={columns}
            rows={rows}
            loading={list.isPending}
            label={t('title')}
            emptyText={t('noResults')}
            getRowId={(r) => r.session.id}
            getRowHref={hrefOf}
            renderCard={(r) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <bdi className="font-semibold">{dayAndClock(r.session.startsAt, tz, locale)}</bdi>
                  <ReportStateBadge state={r.state} />
                </div>
                <span className="font-semibold text-primary">{r.session.student.name}</span>
                <span className="text-sm text-muted-foreground">
                  {r.session.teacher.name} ·{' '}
                  {locale === 'ar' ? r.session.course.nameAr : r.session.course.nameEn}
                </span>
                <Submitted item={r} now={now} />
                {r.report?.rating ? <RatingStars value={r.report.rating} /> : null}
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
      <SessionSheet />
    </>
  );
}

/** When it was sent (and by whom), or when it is due / was due. */
function Submitted({ item: r, now }: { item: ReportListItemDto; now: Date }) {
  const t = useTranslations('reports.list');
  const locale = useUiLocale();
  const tz = useViewerTz();
  if (r.report) {
    return (
      <span className="flex flex-col text-sm" title={dayAndClock(r.report.submittedAt, tz, locale)}>
        <span>{relativeTime(r.report.submittedAt, now, locale)}</span>
        {r.report.submittedBy && (
          <span className="text-muted-foreground">{r.report.submittedBy.name}</span>
        )}
      </span>
    );
  }
  const overdue = Date.parse(r.dueAt) < now.getTime();
  return (
    <span
      className={overdue ? 'text-sm font-semibold text-status-red-emphasis' : 'text-sm'}
      title={dayAndClock(r.dueAt, tz, locale)}
    >
      {overdue
        ? t('dueWas', { ago: relativeTime(r.dueAt, now, locale) })
        : t('dueIn', { ago: relativeTime(r.dueAt, now, locale) })}
    </span>
  );
}
