'use client';

import { TRIAL_CHECK_ALERT_LABELS, type TrialChecklistItemDto } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@qarabic/ui/components/tooltip';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ChevronLeftIcon, ChevronRightIcon, UserCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { DatePicker } from '@/components/forms/date-time';
import { StatusTabs } from '@/components/list/list-toolbar';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { ToneBadge } from '@/components/sessions/badges';
import { SessionSheet } from '@/components/sessions/session-sheet';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { crmKeys, fetchTrialsToday } from '@/lib/api/crm';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { addDays, clock, dateKeyIn } from '@/lib/schedule-time';

const isDateKey = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * «الحصص التجريبية اليوم» (T4, docs/33 §3.5): the day's trial classes for monitors and customer
 * service — did the teacher start (and how late), did the student join, is the teacher's trial
 * report in. «تحتاج متابعة» lists the ones with an alert first. A row opens the class sheet; the
 * day is in the viewer's zone.
 */
export function TrialsTodayView() {
  const t = useTranslations('crm.trialsToday');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const params = useListParams();
  const search = useSearchParams();
  const allowed = can(me, 'sessions.manage') || can(me, 'leads.manage');
  const today = dateKeyIn(tz);
  const date = isDateKey(params.get('date')) ? params.get('date') : today;
  const view = params.get('view') === 'all' ? 'all' : 'attention';
  const setDate = (key: string) =>
    params.set({ date: key === today ? null : key, session: null }, { resetPage: false });
  const query = { date, tz };
  const list = useQuery({
    queryKey: crmKeys.trialsToday(query),
    queryFn: ({ signal }) => fetchTrialsToday(query, signal),
    enabled: allowed,
    refetchInterval: 60_000,
  });

  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const all = list.data ?? [];
  const attention = all.filter((x) => x.alerts.length > 0);
  const rows = view === 'all' ? all : attention;
  const hrefFor = (x: TrialChecklistItemDto) => {
    const next = new URLSearchParams(search.toString());
    next.set('session', String(x.sessionId));
    return `/trials?${next.toString()}`;
  };

  const started = (x: TrialChecklistItemDto) =>
    x.teacherStarted ? (
      x.lateMinutes ? (
        <ToneBadge tone="brown" label={t('startedLate', { minutes: x.lateMinutes })} />
      ) : (
        <ToneBadge tone="green" label={t('startedOnTime')} />
      )
    ) : x.lateMinutes ? (
      <ToneBadge tone="red" label={t('notStartedFor', { minutes: x.lateMinutes })} />
    ) : (
      <span className="text-muted-foreground">{t('notYet')}</span>
    );
  const joined = (x: TrialChecklistItemDto) =>
    x.studentJoined === null ? (
      <span className="text-muted-foreground">{t('unknown')}</span>
    ) : x.studentJoined ? (
      t('yes')
    ) : (
      t('no')
    );
  const report = (x: TrialChecklistItemDto) =>
    x.reportSubmitted ? (
      <ToneBadge tone="green" label={t('reportIn')} />
    ) : (
      <span className="text-muted-foreground">{t('reportMissing')}</span>
    );
  const alerts = (x: TrialChecklistItemDto) =>
    x.alerts.length ? (
      <span className="flex flex-wrap gap-1">
        {x.alerts.map((a) => (
          <ToneBadge key={a} tone="red" label={TRIAL_CHECK_ALERT_LABELS[a][locale]} />
        ))}
      </span>
    ) : null;
  const course = (x: TrialChecklistItemDto) =>
    x.course ? (locale === 'ar' ? x.course.nameAr : x.course.nameEn) : '—';

  const columns: ColumnDef<TrialChecklistItemDto, unknown>[] = [
    {
      id: 'time',
      header: t('time'),
      enableHiding: false,
      cell: ({ row: { original: x } }) => (
        <bdi className="font-semibold tabular-nums">{clock(x.startsAt, tz, locale)}</bdi>
      ),
    },
    {
      id: 'student',
      header: t('student'),
      cell: ({ row: { original: x } }) => (
        <span className="flex flex-col">
          <bdi className="font-medium">{x.student.name}</bdi>
          <span className="text-sm text-muted-foreground">{course(x)}</span>
        </span>
      ),
    },
    {
      id: 'teacher',
      header: t('teacher'),
      cell: ({ row: { original: x } }) => <bdi>{x.teacher.name}</bdi>,
    },
    { id: 'started', header: t('started'), cell: ({ row: { original: x } }) => started(x) },
    { id: 'joined', header: t('joined'), cell: ({ row: { original: x } }) => joined(x) },
    { id: 'report', header: t('report'), cell: ({ row: { original: x } }) => report(x) },
    { id: 'alerts', header: t('alerts'), cell: ({ row: { original: x } }) => alerts(x) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        description={t('description')}
        meta={list.data ? t('count', { count: all.length }) : undefined}
        actions={
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-lg"
                  aria-label={t('prevDay')}
                  onClick={() => setDate(addDays(date, -1))}
                >
                  <ChevronRightIcon className="ltr:rotate-180" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('prevDay')}</TooltipContent>
            </Tooltip>
            <DatePicker value={date} onChange={setDate} label={t('pickDate')} className="w-44" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-lg"
                  aria-label={t('nextDay')}
                  onClick={() => setDate(addDays(date, 1))}
                >
                  <ChevronLeftIcon className="ltr:rotate-180" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('nextDay')}</TooltipContent>
            </Tooltip>
            {date !== today && (
              <Button variant="outline" className="h-10" onClick={() => setDate(today)}>
                {t('today')}
              </Button>
            )}
          </div>
        }
      />
      <Card className="gap-0 py-0 shadow-none">
        <div className="border-b p-4">
          <StatusTabs
            label={t('viewLabel')}
            value={view}
            onChange={(v) => params.set({ view: v === 'all' ? 'all' : null }, { resetPage: false })}
            options={[
              {
                value: 'attention',
                label: t('attention'),
                count: list.data ? attention.length : undefined,
              },
              { value: 'all', label: t('all'), count: list.data ? all.length : undefined },
            ]}
          />
        </div>
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
            emptyText={view === 'all' ? t('none') : t('noneNeedAttention')}
            getRowId={(x) => x.sessionId}
            getRowHref={hrefFor}
            renderCard={(x) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <UserCheckIcon aria-hidden className="size-4 text-muted-foreground" />
                    <bdi className="font-semibold tabular-nums">
                      {clock(x.startsAt, tz, locale)}
                    </bdi>
                    <bdi className="font-medium">{x.student.name}</bdi>
                  </span>
                  {report(x)}
                </div>
                <span className="text-sm text-muted-foreground">
                  <bdi>{x.teacher.name}</bdi> · {course(x)}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  {started(x)}
                  <span>
                    {t('joined')}: {joined(x)}
                  </span>
                </span>
                {alerts(x)}
              </div>
            )}
          />
        )}
      </Card>
      <SessionSheet />
    </div>
  );
}
