'use client';

import { TEACHER_PORTAL_LABELS } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  CalendarXIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FilePenLineIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DatePicker } from '@/components/forms/date-time';
import { KeyFacts } from '@/components/people/detail';
import { PageHeader } from '@/components/page-header';
import { ClassTable } from '@/components/sessions/class-table';
import { SessionSheet, useOpenSession } from '@/components/sessions/session-sheet';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchTeacherWeek, teachingKeys } from '@/lib/api/teaching';
import { useListParams } from '@/lib/list-params';
import { dayLabel, isDateKey, relativeTime } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';

/**
 * «حصصي» for a teacher = «أسبوعي» (D71; the current app's `MyWeekPage`): `GET
 * /teacher-portal/week`, Saturday → Friday cut in the teacher's zone, a date switcher, the week's
 * counters («بلا تقرير» stands out), then each day's classes with start / end / «اكتب التقرير».
 * Every row opens the class sheet; the report form opens in it.
 */
export function TeacherWeekView() {
  const t = useTranslations('myClasses');
  const tw = useTranslations('teacherPortal');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const params = useListParams();
  const { open, openReport } = useOpenSession();
  const now = useNow(30_000);
  const date = isDateKey(params.get('week')) ? params.get('week') : undefined;
  const query = useQuery({
    queryKey: teachingKeys.week(date),
    queryFn: ({ signal }) => fetchTeacherWeek(date, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const title = t('titleTeacher');
  if (isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={title} />
        <ForbiddenState />
      </>
    );
  }
  const w = query.data;
  const goWeek = (key: string | null) => params.set({ week: key, session: null });
  const thisWeek = !w || (w.today >= w.weekStart && w.today <= w.weekEnd);
  const missing = w?.days
    .flatMap((d) => d.sessions)
    .filter((s) => s.stage === 'ended' && s.allowedActions.includes('submit_report'));

  return (
    <>
      <PageHeader
        title={title}
        meta={
          w
            ? t('range', {
                from: dayLabel(w.weekStart, locale),
                to: dayLabel(w.weekEnd, locale, true),
              })
            : undefined
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="h-10"
              disabled={!w}
              onClick={() => w && goWeek(w.previousWeek)}
            >
              <ChevronRightIcon className="ltr:rotate-180" />
              {t('prevWeek')}
            </Button>
            {!thisWeek && (
              <Button variant="outline" className="h-10" onClick={() => goWeek(null)}>
                {t('thisWeek')}
              </Button>
            )}
            <Button
              variant="outline"
              className="h-10"
              disabled={!w}
              onClick={() => w && goWeek(w.nextWeek)}
            >
              {t('nextWeek')}
              <ChevronLeftIcon className="ltr:rotate-180" />
            </Button>
            <DatePicker
              value={date ?? w?.today ?? ''}
              onChange={(v) => goWeek(v)}
              label={tw('pickDay')}
              className="w-44"
            />
            <Button
              variant="ghost"
              size="icon-lg"
              aria-label={t('refresh')}
              onClick={() => void query.refetch()}
            >
              <RefreshCwIcon />
            </Button>
          </div>
        }
      />
      <p className="text-sm text-muted-foreground">
        {t('zoneNoteTeacher', { city: cityOf(w?.timezone ?? tz, locale) })}
        {query.dataUpdatedAt > 0 && (
          <>
            {' '}
            ·{' '}
            {t('lastUpdated', {
              ago: relativeTime(new Date(query.dataUpdatedAt).toISOString(), now, locale),
            })}
          </>
        )}
      </p>
      <KeyFacts
        items={[
          { label: t('facts.total'), value: w?.summary.total ?? '—' },
          { label: t('facts.taken'), value: w?.summary.taken ?? '—' },
          { label: t('facts.remaining'), value: w?.summary.remaining ?? '—' },
          {
            label: TEACHER_PORTAL_LABELS.needsReport[locale],
            value: (
              <span className={w?.summary.needsReport ? 'text-status-orange-emphasis' : ''}>
                {w?.summary.needsReport ?? '—'}
              </span>
            ),
          },
        ]}
      />
      {missing && missing.length > 0 && (
        <Alert className="border-status-orange-border bg-status-orange text-status-orange-foreground">
          <FilePenLineIcon />
          <AlertDescription className="flex flex-wrap items-center gap-2 text-inherit">
            {tw('reportsDue', { count: missing.length })}
            <Button size="sm" onClick={() => openReport(missing[0]!.id)}>
              {tw('writeFirst', { name: missing[0]!.student.name })}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {query.isError && !w ? (
        <ErrorState onRetry={() => void query.refetch()} />
      ) : w && w.summary.total === 0 ? (
        <EmptyState icon={CalendarXIcon} title={t('empty')} description={t('emptyHint')} />
      ) : (
        (
          w?.days ?? Array.from({ length: 3 }, (_, i) => ({ date: `loading-${i}`, sessions: [] }))
        ).map((day) => {
          const loading = !w;
          const isToday = w?.today === day.date;
          return (
            <section
              key={day.date}
              aria-labelledby={`day-${day.date}`}
              className="flex flex-col gap-2"
            >
              {!loading && (
                <h2 id={`day-${day.date}`} className="flex items-baseline gap-2 text-lg font-bold">
                  {dayLabel(day.date, locale, true)}
                  {isToday && (
                    <span className="text-sm font-medium text-primary">({t('today')})</span>
                  )}
                  {day.sessions.length > 0 && (
                    <span className="text-sm font-normal text-muted-foreground">
                      {t('dayCount', { count: day.sessions.length })}
                    </span>
                  )}
                </h2>
              )}
              {loading ? (
                <Card className="gap-0 py-0 shadow-none">
                  <ClassTable rows={[]} loading now={now} onOpen={() => undefined} label="" />
                </Card>
              ) : day.sessions.length === 0 ? (
                <p className="text-muted-foreground">{t('noClasses')}</p>
              ) : (
                <Card className="gap-0 py-0 shadow-none">
                  <ClassTable
                    rows={day.sessions}
                    now={now}
                    onOpen={(s) => open(s.id)}
                    label={dayLabel(day.date, locale)}
                    hideTeacher
                    primaryActions
                  />
                </Card>
              )}
            </section>
          );
        })
      )}
      <SessionSheet />
    </>
  );
}
