'use client';

import type { ParentHomeChildDto, ParentHomeReportDto, SessionDto } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Separator } from '@qarabic/ui/components/separator';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeftIcon, UsersRoundIcon, VideoIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { KeyFacts } from '@/components/people/detail';
import { ParentDueCard } from '@/components/billing/parent-due-card';
import { ReferralSection } from '@/components/crm/referral-section';
import { PageHeader } from '@/components/page-header';
import { HifzLine, RatingStars } from '@/components/reports/report-bits';
import { StageBadge } from '@/components/sessions/badges';
import { SessionSheet, useOpenSession } from '@/components/sessions/session-sheet';
import { BothClassTimes, OtherTime, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useSessionActions } from '@/components/sessions/use-session-actions';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState } from '@/components/states';
import { fetchParentHome, supportKeys } from '@/lib/api/support';
import { clock, dateKeyIn, dayAndClock, dayLabel } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';
import { SessionActionsMenu } from './session-actions-menu';

/**
 * «ادخل الحصة» (docs/15 §2.6 P1, the old «Join To Classroom»): one tap opens the meeting, shown
 * only inside the join window (`zoom.joinAvailable`); the link comes from `/zoom/join`.
 */
export function JoinClassButton({ session, compact }: { session: SessionDto; compact?: boolean }) {
  const t = useTranslations('support.parentHome');
  const actions = useSessionActions(session);
  if (!session.zoom.joinAvailable) return null;
  return (
    <Button
      className={compact ? 'h-10' : 'h-12 px-6 text-base'}
      onClick={() => actions.openMeeting('join')}
    >
      <VideoIcon />
      {t('join')}
      <span className="sr-only">: {session.student.name}</span>
    </Button>
  );
}

function ChildCard({
  child,
  next,
}: {
  child: ParentHomeChildDto;
  /** The child's next class as a full class (when it is in the coming week). */
  next: SessionDto | null;
}) {
  const t = useTranslations('support.parentHome');
  const locale = useUiLocale();
  return (
    <Card className="gap-3 shadow-none" aria-labelledby={`child-${child.id}`}>
      <CardHeader className="border-b">
        <CardTitle className="text-lg font-bold">
          <h3 id={`child-${child.id}`}>{child.name}</h3>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {child.course ? (locale === 'en' ? child.course.nameEn : child.course.nameAr) : null}
          {child.course && ' · '}
          {child.teacher ? t('teacher', { name: child.teacher.name }) : t('noTeacher')}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <section aria-label={`${t('nextClass')} · ${child.name}`} className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold text-muted-foreground">{t('nextClass')}</h4>
          {child.nextClass ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <BothClassTimes
                at={child.nextClass.startsAt}
                otherTz={child.teacher?.timezone ?? ''}
                party="teacher"
              />
              {next && (
                <div className="flex flex-wrap items-center gap-2">
                  <JoinClassButton session={next} />
                  <SessionActionsMenu session={next} />
                </div>
              )}
            </div>
          ) : (
            <p>{t('noNext')}</p>
          )}
        </section>
        <div className="flex flex-wrap gap-x-4">
          <Button variant="ghost" asChild className="h-10 px-0 text-primary">
            <Link href={`/students/${child.id}`}>
              {t('childProfile', { name: child.name })}
              <ChevronLeftIcon className="ltr:rotate-180" />
            </Link>
          </Button>
          <Button variant="ghost" asChild className="h-10 px-0 text-primary">
            <Link href="/my-classes">
              {t('openClasses', { name: child.name })}
              <ChevronLeftIcon className="ltr:rotate-180" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function WeekList({ rows }: { rows: SessionDto[] }) {
  const t = useTranslations('support.parentHome');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const { open } = useOpenSession();
  if (rows.length === 0) return <p className="text-muted-foreground">{t('noWeek')}</p>;
  const days = [...new Set(rows.map((s) => dateKeyIn(tz, new Date(s.startsAt))))];
  return (
    <div className="flex flex-col gap-4">
      {days.map((day) => (
        <section key={day} aria-labelledby={`day-${day}`} className="flex flex-col gap-2">
          <h3 id={`day-${day}`} className="font-semibold">
            {dayLabel(day, locale, true)}
          </h3>
          <ul className="flex flex-col divide-y rounded-lg border bg-card">
            {rows
              .filter((s) => dateKeyIn(tz, new Date(s.startsAt)) === day)
              .map((s) => (
                <li
                  key={s.id}
                  className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <bdi className="font-semibold tabular-nums">
                        {clock(s.startsAt, tz, locale)}
                      </bdi>
                      <button
                        type="button"
                        onClick={() => open(s.id)}
                        className="font-semibold text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {s.student.name}
                      </button>
                      <StageBadge session={s} />
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {locale === 'en' ? s.course.nameEn : s.course.nameAr} · {s.teacher.name}
                      {s.teacher.timezone !== tz && (
                        <>
                          {' · '}
                          <OtherTime at={s.startsAt} tz={s.teacher.timezone} party="teacher" />
                        </>
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <JoinClassButton session={s} compact />
                    <SessionActionsMenu session={s} />
                  </div>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ReportItem({ r }: { r: ParentHomeReportDto }) {
  const t = useTranslations('support.parentHome');
  const locale = useUiLocale();
  const tz = useViewerTz();
  return (
    <li className="flex flex-col gap-1.5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">{r.student.name}</span>
        <span className="text-sm text-muted-foreground">
          {t('reportBy', {
            teacher: r.teacher?.name ?? '—',
            when: dayAndClock(r.startsAt, tz, locale),
          })}
        </span>
      </div>
      <p className="break-words whitespace-pre-wrap">{r.summary}</p>
      {r.hifz.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-sm" aria-label={t('hifz')}>
          {r.hifz.map((h, i) => (
            <li key={i}>
              <HifzLine h={h} />
            </li>
          ))}
        </ul>
      )}
      {r.homework && (
        <p className="text-sm">
          <span className="font-semibold">{t('homework')}:</span> {r.homework}
        </p>
      )}
      {r.tajweedNotes && (
        <p className="text-sm">
          <span className="font-semibold">{t('tajweed')}:</span> {r.tajweedNotes}
        </p>
      )}
      {typeof r.rating === 'number' && (
        <span className="flex items-center gap-2 text-sm">
          <RatingStars value={r.rating} />
          <span className="sr-only">{t('rating', { n: r.rating })}</span>
        </span>
      )}
    </li>
  );
}

/**
 * Parent home (M4, D138; `GET /parent/home`): the open-request counters, one card per child with
 * the teacher and the next class (both zones, D30) and its «⋯ إجراءات», the coming seven days and
 * the latest lesson reports (no internal notes; the rating unless the academy hides it). One
 * column on phones, large touch targets.
 */
export function ParentHomeView() {
  const t = useTranslations('support.parentHome');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const home = useQuery({
    queryKey: supportKeys.parentHome,
    queryFn: ({ signal }) => fetchParentHome(signal),
    refetchInterval: 60_000,
  });
  const header = (
    <PageHeader
      title={t('title', { name: me.name })}
      description={t('timesNote', { city: cityOf(tz, locale) })}
    />
  );
  if (home.isError) {
    return (
      <>
        {header}
        <ErrorState onRetry={() => void home.refetch()} />
      </>
    );
  }
  if (!home.data) {
    return (
      <>
        {header}
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-20" />
          <Skeleton className="h-44" />
          <Skeleton className="h-60" />
        </div>
      </>
    );
  }
  const data = home.data;
  const nextOf = (child: ParentHomeChildDto) =>
    data.upcomingClasses.find((s) => s.id === child.nextClass?.id) ?? null;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      {header}
      {/* What is due comes first: one tap to pay (docs/15 §2.6 P3). */}
      <ParentDueCard />
      <section aria-labelledby="home-requests" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="home-requests" className="text-lg font-bold">
            {t('requests')}
          </h2>
          <Button variant="outline" asChild>
            <Link href="/my-requests">{t('openRequests')}</Link>
          </Button>
        </div>
        <KeyFacts
          items={[
            {
              label: t('pendingClassRequests'),
              value: data.requests.pendingClassRequests,
            },
            {
              label: t('openTickets'),
              value: data.requests.openTickets,
            },
            {
              label: t('ticketUpdates'),
              value: data.requests.ticketUpdates,
            },
          ]}
        />
      </section>
      <Separator />
      <section aria-labelledby="home-children" className="flex flex-col gap-3">
        <h2 id="home-children" className="text-lg font-bold">
          {t('children')}
        </h2>
        {data.children.length === 0 ? (
          <EmptyState
            icon={UsersRoundIcon}
            title={t('noChildren')}
            description={t('noChildrenHint')}
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {[...data.children]
              .sort((a, b) =>
                (a.nextClass?.startsAt ?? '9999').localeCompare(b.nextClass?.startsAt ?? '9999'),
              )
              .map((child) => (
                <ChildCard key={child.id} child={child} next={nextOf(child)} />
              ))}
          </div>
        )}
      </section>
      <section aria-labelledby="home-week" className="flex flex-col gap-3">
        <h2 id="home-week" className="text-lg font-bold">
          {t('week')}
        </h2>
        <WeekList rows={data.upcomingClasses} />
      </section>
      <section aria-labelledby="home-reports" className="flex flex-col gap-3">
        <h2 id="home-reports" className="text-lg font-bold">
          {t('reports')}
        </h2>
        {data.recentReports.length === 0 ? (
          <p className="text-muted-foreground">{t('noReports')}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border bg-card">
            {data.recentReports.map((r) => (
              <ReportItem key={r.reportId} r={r} />
            ))}
          </ul>
        )}
      </section>
      <ReferralSection />
      <SessionSheet />
    </div>
  );
}
