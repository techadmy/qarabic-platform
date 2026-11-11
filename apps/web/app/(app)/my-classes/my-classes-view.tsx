'use client';

import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarXIcon, ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { KeyFacts } from '@/components/people/detail';
import { PageHeader } from '@/components/page-header';
import { ClassTable } from '@/components/sessions/class-table';
import { SessionSheet, useOpenSession } from '@/components/sessions/session-sheet';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchSessions, sessionKeys } from '@/lib/api/sessions';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import {
  addDays,
  dateKeyIn,
  dayLabel,
  isDateKey,
  relativeTime,
  weekStart,
  zonedInstant,
} from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';

/**
 * «حصصي» (teacher) and «حصص أبنائي» (parent) — the own week (docs/15 §6.2; the current app's
 * «أسبوعي» and the parent's classes): the week from Saturday with prev/next, its counters, then
 * each day's classes in the viewer's zone with the other party's time beside them. The teacher's
 * rows carry «ابدأ الحصة» / «إنهاء الحصة»; every row opens the class sheet.
 */
export function MyClassesView() {
  const t = useTranslations('myClasses');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const params = useListParams();
  const { open } = useOpenSession();
  const now = useNow(30_000);
  const isTeacher = me.role?.kind === 'teacher';
  const today = dateKeyIn(tz, now);
  const from = isDateKey(params.get('week')) ? weekStart(params.get('week')) : weekStart(today);
  const to = addDays(from, 6);
  const range = {
    from: zonedInstant(from, '00:00', tz),
    to: zonedInstant(addDays(to, 1), '00:00', tz),
    perPage: 300,
  };
  const allowed = can(me, 'sessions.view');
  const query = useQuery({
    queryKey: sessionKeys.list(range),
    queryFn: ({ signal }) => fetchSessions(range, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    enabled: allowed,
  });
  const rows = useMemo(() => query.data?.data ?? [], [query.data]);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((key) => ({
    key,
    rows: rows.filter((s) => dateKeyIn(tz, new Date(s.startsAt)) === key),
  }));
  const title = isTeacher ? t('titleTeacher') : t('titleParent');
  if (!allowed || isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={title} />
        <ForbiddenState />
      </>
    );
  }
  const count = (pred: (stage: string) => boolean) => rows.filter((s) => pred(s.stage)).length;
  const goWeek = (key: string | null) => params.set({ week: key, session: null });

  return (
    <>
      <PageHeader
        title={title}
        meta={t('range', { from: dayLabel(from, locale), to: dayLabel(to, locale, true) })}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" className="h-10" onClick={() => goWeek(addDays(from, -7))}>
              <ChevronRightIcon className="ltr:rotate-180" />
              {t('prevWeek')}
            </Button>
            {from !== weekStart(today) && (
              <Button variant="outline" className="h-10" onClick={() => goWeek(null)}>
                {t('thisWeek')}
              </Button>
            )}
            <Button variant="outline" className="h-10" onClick={() => goWeek(addDays(from, 7))}>
              {t('nextWeek')}
              <ChevronLeftIcon className="ltr:rotate-180" />
            </Button>
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
        {t(isTeacher ? 'zoneNoteTeacher' : 'zoneNoteParent', { city: cityOf(tz, locale) })}
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
          { label: t('facts.total'), value: count((s) => s !== 'moved_out') },
          { label: t('facts.taken'), value: count((s) => s === 'taken') },
          { label: t('facts.remaining'), value: count((s) => s === 'scheduled') },
          isTeacher
            ? { label: t('facts.reportMissing'), value: count((s) => s === 'ended') }
            : { label: t('facts.leave'), value: count((s) => s === 'leave') },
        ]}
      />
      {query.isError && !query.data ? (
        <ErrorState onRetry={() => void query.refetch()} />
      ) : !query.isPending && rows.length === 0 ? (
        <EmptyState icon={CalendarXIcon} title={t('empty')} description={t('emptyHint')} />
      ) : (
        days.map((day) => (
          <section key={day.key} aria-labelledby={`day-${day.key}`} className="flex flex-col gap-2">
            <h2 id={`day-${day.key}`} className="flex items-baseline gap-2 text-lg font-bold">
              {dayLabel(day.key, locale, true)}
              {day.key === today && (
                <span className="text-sm font-medium text-primary">({t('today')})</span>
              )}
              {day.rows.length > 0 && (
                <span className="text-sm font-normal text-muted-foreground">
                  {t('dayCount', { count: day.rows.length })}
                </span>
              )}
            </h2>
            {query.isPending ? (
              <Card className="gap-0 py-0 shadow-none">
                <ClassTable rows={[]} loading now={now} onOpen={() => undefined} label={day.key} />
              </Card>
            ) : day.rows.length === 0 ? (
              <p className="text-muted-foreground">{t('noClasses')}</p>
            ) : (
              <Card className="gap-0 py-0 shadow-none">
                <ClassTable
                  rows={day.rows}
                  now={now}
                  onOpen={(s) => open(s.id)}
                  label={dayLabel(day.key, locale)}
                  hideTeacher={isTeacher}
                  primaryActions={isTeacher}
                />
              </Card>
            )}
          </section>
        ))
      )}
      <SessionSheet />
    </>
  );
}
