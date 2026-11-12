'use client';

import { HIFZ_TYPE_LABELS, TEACHER_PORTAL_LABELS, type SessionDto } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@qarabic/ui/components/collapsible';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { cn } from '@qarabic/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarDaysIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  FilePenLineIcon,
  PlayIcon,
  SquareIcon,
  VideoIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { KeyFacts } from '@/components/people/detail';
import { PageHeader } from '@/components/page-header';
import { TodayCard } from '@/components/payroll/attendance-view';
import { StageBadge } from '@/components/sessions/badges';
import { ClassTable } from '@/components/sessions/class-table';
import { RowActions } from '@/components/sessions/row-actions';
import { SessionSheet, useOpenSession } from '@/components/sessions/session-sheet';
import { BothClassTimes, useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useSessionActions } from '@/components/sessions/use-session-actions';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchTeacherStudents, fetchTeacherWeek, teachingKeys } from '@/lib/api/teaching';
import { can } from '@/lib/auth/use-me';
import { rangeText, shortLabel } from '@/lib/reports/format';
import { dayLabel, relativeTime } from '@/lib/schedule-time';
import {
  pickHeroClass,
  RUNNING_STAGES,
  UPCOMING_DAYS,
  upcomingDays,
  type Day,
} from '@/lib/sessions/teacher-home';
import { cityOf } from '@/lib/time';

function HeroClass({ session: s, now }: { session: SessionDto; now: Date }) {
  const t = useTranslations('teacherPortal.home');
  const tc = useTranslations('classes');
  const tp = useTranslations('teacherPortal.students');
  const locale = useUiLocale();
  const { open } = useOpenSession();
  const actions = useSessionActions(s);
  const students = useQuery({
    queryKey: teachingKeys.myStudents,
    queryFn: ({ signal }) => fetchTeacherStudents(signal),
  });
  const positions = students.data?.find((st) => st.id === s.student.id)?.lastPositions ?? [];
  const running = RUNNING_STAGES.has(s.stage);
  const allowed = s.allowedActions;
  const name = s.student.name;
  const big = 'h-12 px-6 text-base';

  return (
    <section aria-labelledby="hero-class">
      <Card className="gap-4 shadow-none">
        <CardHeader className="border-b">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base font-bold">
              <h2 id="hero-class">
                {running ? t('current') : TEACHER_PORTAL_LABELS.nextClass[locale]}
              </h2>
            </CardTitle>
            <StageBadge session={s} />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Link
              href={`/students/${s.student.id}`}
              className="self-start rounded-sm text-xl font-bold text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {name}
            </Link>
            <p className="text-muted-foreground">
              {locale === 'en' ? s.course.nameEn : s.course.nameAr} ·{' '}
              {tc('minutes', { count: s.durationMinutes })}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <BothClassTimes at={s.startsAt} otherTz={s.student.timezone} party="student" />
            {!running && (
              <p className="text-sm font-semibold text-primary">
                {t('startsIn', { when: relativeTime(s.startsAt, now, locale) })}
              </p>
            )}
          </div>
          {positions.length > 0 && (
            <div className="flex flex-col gap-1 text-sm">
              <span className="font-semibold text-muted-foreground">{tp('columns.position')}</span>
              <ul className="flex flex-col gap-0.5">
                {positions.map((p) => (
                  <li key={p.type}>
                    <span className="text-muted-foreground">
                      {shortLabel(HIFZ_TYPE_LABELS[p.type][locale])}:
                    </span>{' '}
                    <bdi>{rangeText(p, locale)}</bdi>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            {allowed.includes('activate') && (
              <Button
                className={big}
                disabled={!!actions.pending}
                onClick={() => {
                  if (s.zoom.status !== 'none') actions.openMeeting('start');
                  actions.run('activate');
                }}
              >
                <PlayIcon />
                {tc('startClass')}
                <span className="sr-only">: {name}</span>
              </Button>
            )}
            {allowed.includes('end') && (
              <Button
                className={big}
                disabled={!!actions.pending}
                onClick={() => actions.run('end')}
              >
                <SquareIcon />
                {tc('endClass')}
                <span className="sr-only">: {name}</span>
              </Button>
            )}
            {running && s.zoom.joinAvailable && (
              <Button
                variant="outline"
                className={big}
                onClick={() => actions.openMeeting('start')}
              >
                <VideoIcon />
                {tc('meeting.open')}
              </Button>
            )}
            <Button variant="outline" className={big} onClick={() => open(s.id)}>
              {t('details')}
            </Button>
            <RowActions session={s} className="justify-start" />
          </div>
          {actions.dialogs}
        </CardContent>
      </Card>
    </section>
  );
}

function UpcomingDay({ day, now }: { day: Day; now: Date }) {
  const t = useTranslations('myClasses');
  const locale = useUiLocale();
  const { open } = useOpenSession();
  const [expanded, setExpanded] = useState(false);
  if (day.sessions.length === 0) {
    // Nothing to open: plain text, not a disabled control.
    return (
      <div className="flex h-12 items-center justify-between rounded-lg border bg-card px-4">
        <h3 className="text-base font-semibold">{dayLabel(day.date, locale)}</h3>
        <span className="text-sm text-muted-foreground">{t('noClasses')}</span>
      </div>
    );
  }
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="rounded-lg border bg-card">
      <h3>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="h-12 w-full justify-between rounded-lg px-4 text-base font-semibold aria-expanded:bg-transparent hover:aria-expanded:bg-muted"
          >
            <span>{dayLabel(day.date, locale)}</span>
            <span className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
              {t('dayCount', { count: day.sessions.length })}
              <ChevronDownIcon className={cn('transition-transform', expanded && 'rotate-180')} />
            </span>
          </Button>
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent className="border-t">
        <ClassTable
          rows={day.sessions}
          now={now}
          onOpen={(s) => open(s.id)}
          label={dayLabel(day.date, locale)}
          hideTeacher
          primaryActions
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The teacher's home «يومي» (docs/15 §2.5 T1 and §6.2; the old teacher home listed today and the
 * next five days): the class running now or the next one as a large card (student, both times,
 * where the student stands in hifz, «ابدأ الحصة» / «أنهِ الحصة» / «اكتب التقرير»), reports still
 * due, today's check-in, the rest of today, then the next five days collapsed. From
 * `GET /teacher-portal/week` (this week, and the next one when the five days cross into it).
 */
export function TeacherHomeView() {
  const t = useTranslations('teacherPortal.home');
  const tm = useTranslations('myClasses');
  const tw = useTranslations('teacherPortal');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const now = useNow(30_000);
  const { open, openReport } = useOpenSession();
  const week = useQuery({
    queryKey: teachingKeys.week(undefined),
    queryFn: ({ signal }) => fetchTeacherWeek(undefined, signal),
    refetchInterval: 60_000,
  });
  const w = week.data;
  const daysLeft = w ? w.days.filter((d) => d.date > w.today).length : 0;
  const nextWeek = useQuery({
    queryKey: teachingKeys.week(w?.nextWeek),
    queryFn: ({ signal }) => fetchTeacherWeek(w!.nextWeek, signal),
    enabled: !!w && daysLeft < UPCOMING_DAYS,
    refetchInterval: 60_000,
  });
  const header = (
    <PageHeader
      title={t('title', { name: me.name })}
      description={tm('zoneNoteTeacher', { city: cityOf(w?.timezone ?? tz, locale) })}
    />
  );
  if (isApiError(week.error, 403)) {
    return (
      <>
        {header}
        <ForbiddenState />
      </>
    );
  }
  if (week.isError && !w) {
    return (
      <>
        {header}
        <ErrorState onRetry={() => void week.refetch()} />
      </>
    );
  }
  if (!w) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-20" />
          <Skeleton className="h-56" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }
  const days = [...w.days, ...(nextWeek.data?.days ?? [])];
  const todays = w.days.find((d) => d.date === w.today)?.sessions ?? [];
  const ahead = days.filter((d) => d.date >= w.today);
  const hero = pickHeroClass(ahead, now);
  const restOfToday = todays.filter((s) => s.id !== hero?.id);
  const upcoming = upcomingDays(days, w.today);
  // The «بلا تقرير» count (fact and alert) is the API's; `missing` only finds one to open now.
  const missing = w.days
    .flatMap((d) => d.sessions)
    .filter((s) => s.stage === 'ended' && s.allowedActions.includes('submit_report'));
  const count = (pred: (s: SessionDto) => boolean) => todays.filter(pred).length;

  return (
    <div className="flex flex-col gap-5">
      {header}
      <KeyFacts
        items={[
          { label: t('facts.today'), value: count((s) => s.stage !== 'moved_out') },
          { label: tm('facts.taken'), value: count((s) => s.stage === 'taken') },
          { label: tm('facts.remaining'), value: count((s) => s.stage === 'scheduled') },
          { label: TEACHER_PORTAL_LABELS.needsReport[locale], value: w.summary.needsReport },
        ]}
      />
      {w.summary.needsReport > 0 && (
        <Alert variant="warning">
          <FilePenLineIcon />
          <AlertDescription className="flex flex-wrap items-center gap-2 text-inherit">
            {tw('reportsDue', { count: w.summary.needsReport })}
            {missing[0] ? (
              <Button size="sm" onClick={() => openReport(missing[0]!.id)}>
                {tw('writeFirst', { name: missing[0].student.name })}
              </Button>
            ) : (
              <Button size="sm" asChild>
                <Link href="/lesson-reports?state=missing">{t('openMissing')}</Link>
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {hero ? (
        <HeroClass key={hero.id} session={hero} now={now} />
      ) : (
        <EmptyState icon={CalendarDaysIcon} title={t('noNext')} description={t('noNextHint')} />
      )}
      {can(me, 'attendance.request') && <TodayCard />}
      <section aria-labelledby="home-today" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="home-today" className="text-lg font-bold">
            {t('restOfToday')}
          </h2>
          <Button variant="ghost" asChild className="px-0 text-primary">
            <Link href="/my-classes">
              {t('openWeek')}
              <ChevronLeftIcon className="ltr:rotate-180" />
            </Link>
          </Button>
        </div>
        {restOfToday.length === 0 ? (
          <p className="text-muted-foreground">{t('noMoreToday')}</p>
        ) : (
          <Card className="gap-0 py-0 shadow-none">
            <ClassTable
              rows={restOfToday}
              now={now}
              onOpen={(s) => open(s.id)}
              label={t('restOfToday')}
              hideTeacher
              primaryActions
            />
          </Card>
        )}
      </section>
      <section aria-labelledby="home-upcoming" className="flex flex-col gap-2">
        <h2 id="home-upcoming" className="text-lg font-bold">
          {t('upcoming')}
        </h2>
        {nextWeek.isPending && daysLeft < UPCOMING_DAYS ? (
          <Skeleton className="h-40" aria-busy="true" />
        ) : (
          <div className="flex flex-col gap-2">
            {upcoming.map((day) => (
              <UpcomingDay key={day.date} day={day} now={now} />
            ))}
          </div>
        )}
      </section>
      <SessionSheet />
    </div>
  );
}
