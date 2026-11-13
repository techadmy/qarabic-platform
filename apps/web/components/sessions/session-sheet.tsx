'use client';

import {
  SESSION_STAGE_LABELS,
  type RequestStatus,
  type RequestType,
  type SessionDetailDto,
  type TrialReportDto,
  type SessionStage,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Separator } from '@qarabic/ui/components/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@qarabic/ui/components/sheet';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { cn } from '@qarabic/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { CalendarRangeIcon, FilePenLineIcon, LockIcon, PencilIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ReportForm } from '@/components/reports/report-form';
import { TrialReportForm, TrialReportView } from '@/components/reports/trial-report-form';
import { ReportView } from '@/components/reports/report-view';
import { ErrorState } from '@/components/states';
import { fetchSession, fetchTrialReport, sessionKeys } from '@/lib/api/sessions';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { useDirection } from '@/lib/use-direction';
import { clock, dayAndClock, relativeTime } from '@/lib/schedule-time';
import {
  AttentionBadge,
  KindBadge,
  RequestStatusBadge,
  RequestTypeBadge,
  StageBadge,
} from './badges';
import { RowActions } from './row-actions';
import { BothClassTimes, OtherTime, useNow, useUiLocale, useViewerTz } from './times';

/**
 * The class open in the sheet lives in the URL (`?session=12`, `&report=1` for its report form),
 * so Back and links work.
 */
export function useOpenSession() {
  const params = useListParams();
  const id = Number(params.get('session')) || null;
  return {
    id,
    reportMode: params.get('report') === '1',
    open: (sessionId: number) =>
      params.set({ session: sessionId, report: null }, { resetPage: false }),
    openReport: (sessionId: number) =>
      params.set({ session: sessionId, report: 1 }, { resetPage: false }),
    closeReport: () => params.set({ report: null }, { resetPage: false }),
    close: () => params.set({ session: null, report: null }, { resetPage: false }),
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className="text-sm font-bold">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Class detail (docs/15 §6.1, the current app's `SessionDrawer`): a shadcn `Sheet` from the
 * inline end with the class, both parties' times, the actions this user may do now, the join
 * evidence, its requests and the `session_events` timeline (newest first).
 */
export function SessionSheet() {
  const t = useTranslations('classes');
  const { id, close, reportMode } = useOpenSession();
  const dir = useDirection();
  const query = useQuery({
    queryKey: sessionKeys.detail(id ?? 0),
    queryFn: ({ signal }) => fetchSession(id!, signal),
    enabled: !!id,
  });
  return (
    <Sheet open={!!id} onOpenChange={(open) => !open && close()}>
      <SheetContent
        side={dir === 'rtl' ? 'left' : 'right'}
        className={cn('w-full gap-0 overflow-y-auto', reportMode ? 'sm:max-w-2xl' : 'sm:max-w-md')}
      >
        <SheetHeader className="border-b">
          <SheetTitle>{t('detail.title')}</SheetTitle>
          <SheetDescription>{query.data?.student.name ?? t('detail.loading')}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 p-4">
          {!id ? null : query.isPending ? (
            <div className="flex flex-col gap-3" aria-busy="true">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-20" />
              <Skeleton className="h-40" />
            </div>
          ) : query.isError ? (
            <ErrorState onRetry={() => void query.refetch()} />
          ) : (
            <SessionDetail session={query.data} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SessionDetail({ session: s }: { session: SessionDetailDto }) {
  const { reportMode, openReport, closeReport } = useOpenSession();
  const canReport = s.allowedActions.includes('submit_report');
  const me = useCurrentUser();
  const trial = s.kind === 'trial';
  // T4 (B85): a trial class closes through the teacher's trial report, not the lesson report.
  // Only the people the API lets read it (teachers, class managers) ask for it; a family never
  // sees it (it is notes for customer service).
  const readsTrialReport = can(me, 'sessions.conduct') || can(me, 'sessions.manage');
  const trialReport = useQuery({
    queryKey: sessionKeys.trialReport(s.id),
    queryFn: ({ signal }) => fetchTrialReport(s.id, signal),
    enabled: trial && readsTrialReport && (s.stage === 'ended' || s.stage === 'taken'),
  });
  if (reportMode && canReport && trial) {
    if (trialReport.isPending) return <Skeleton className="h-64" />;
    return (
      <TrialReportForm
        key={`${s.id}-${s.lockVersion}`}
        session={s}
        report={trialReport.data ?? null}
        onDone={closeReport}
        onCancel={closeReport}
      />
    );
  }
  if (reportMode && canReport) {
    return (
      <ReportForm
        key={`${s.id}-${s.lockVersion}`}
        session={s}
        report={s.lessonReport}
        onDone={closeReport}
        onCancel={closeReport}
      />
    );
  }
  return (
    <SessionInfo
      session={s}
      canReport={canReport}
      onReport={() => openReport(s.id)}
      trialReport={
        !trial
          ? undefined
          : !readsTrialReport
            ? 'hidden'
            : trialReport.isError
              ? 'error'
              : (trialReport.data ?? null)
      }
      onRetryTrialReport={() => void trialReport.refetch()}
    />
  );
}

function SessionInfo({
  session: s,
  canReport,
  onReport,
  trialReport,
  onRetryTrialReport,
}: {
  session: SessionDetailDto;
  canReport: boolean;
  onReport: () => void;
  /**
   * A trial class: its trial report (null until written), `'error'` when it could not load,
   * `'hidden'` for viewers who don't read it (a family); undefined for other classes.
   */
  trialReport?: TrialReportDto | null | 'error' | 'hidden';
  onRetryTrialReport?: () => void;
}) {
  const t = useTranslations('classes');
  const trep = useTranslations('reports');
  const ttrial = useTranslations('reports.trial');
  const tr = useTranslations('requests');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const now = useNow();
  const ownTeacher = can(me, 'sessions.conduct') && !can(me, 'sessions.manage');
  const course = locale === 'ar' ? s.course.nameAr : s.course.nameEn;
  const stageName = (stage: string | null) =>
    stage ? (SESSION_STAGE_LABELS[stage as SessionStage]?.[locale] ?? stage) : '';
  const joined = (at: string | null) =>
    at ? (
      <bdi>{clock(at, tz, locale)}</bdi>
    ) : (
      <span className="text-muted-foreground">{t('detail.notJoined')}</span>
    );

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1.5">
          <StageBadge session={s} />
          <KindBadge kind={s.kind} showRegular />
          {s.attention
            .filter((a) => a !== 'late')
            .map((a) => (
              <AttentionBadge key={a} code={a} />
            ))}
        </div>
        <p className="text-lg font-bold">{s.student.name}</p>
        <p className="text-muted-foreground">
          {course} · {t('minutes', { count: s.durationMinutes })}
        </p>
        <BothClassTimes at={s.startsAt} otherTz={s.student.timezone} party="student" />
        <p>
          {t('party.teacher')}: <span className="font-medium">{s.teacher.name}</span>
        </p>
        {s.teacher.timezone !== tz && (
          <OtherTime at={s.startsAt} tz={s.teacher.timezone} party="teacher" />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <RowActions session={s} primary className="justify-start" />
        {s.enrollmentId && can(me, 'schedule.view') && me.role?.kind !== 'parent' && (
          <Button variant="link" asChild className="px-0">
            <Link href={`/schedule/${s.enrollmentId}`}>
              <CalendarRangeIcon />
              {t('detail.enrollment')}
            </Link>
          </Button>
        )}
      </div>
      {s.upcomingActions.length > 0 && (
        <ul className="text-sm text-muted-foreground">
          {s.upcomingActions.map((u) => (
            <li key={u.action}>
              {t('detail.opensAt', {
                action: t(`actionNames.${u.action}`),
                time: clock(u.availableAt, tz, locale),
              })}
            </li>
          ))}
        </ul>
      )}
      {trialReport !== undefined &&
        trialReport !== 'hidden' &&
        (s.stage === 'ended' || s.stage === 'taken') && (
          <>
            <Separator />
            <Section title={ttrial('title')}>
              {trialReport === 'error' ? (
                <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{ttrial('loadError')}</span>
                  <Button variant="outline" size="sm" onClick={onRetryTrialReport}>
                    {ttrial('retry')}
                  </Button>
                </div>
              ) : trialReport ? (
                <TrialReportView report={trialReport} />
              ) : (
                <p className="text-sm text-muted-foreground">{ttrial('notSent')}</p>
              )}
              {trialReport !== 'error' && trialReport && s.report.editableUntil && canReport && (
                <p className="text-sm text-muted-foreground">
                  {ttrial('editableUntil', {
                    when: dayAndClock(s.report.editableUntil, tz, locale),
                  })}
                </p>
              )}
              {trialReport !== 'error' && !canReport && trialReport && ownTeacher && (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <LockIcon aria-hidden className="size-3.5" />
                  {ttrial('locked')}
                </p>
              )}
              {trialReport !== 'error' && canReport && (
                <Button
                  variant={trialReport ? 'outline' : 'default'}
                  className="self-start"
                  onClick={onReport}
                >
                  {trialReport ? <PencilIcon /> : <FilePenLineIcon />}
                  {trialReport ? ttrial('editTitle') : ttrial('write')}
                </Button>
              )}
            </Section>
          </>
        )}
      {trialReport === undefined &&
        (s.stage === 'ended' || s.stage === 'taken' || s.lessonReport) && (
          <>
            <Separator />
            <Section title={trep('title')}>
              {s.lessonReport ? (
                <ReportView report={s.lessonReport} />
              ) : (
                <p className="text-sm text-muted-foreground">{trep('notSent')}</p>
              )}
              {canReport ? (
                <Button
                  variant={s.lessonReport ? 'outline' : 'default'}
                  className="self-start"
                  onClick={onReport}
                >
                  {s.lessonReport ? <PencilIcon /> : <FilePenLineIcon />}
                  {s.lessonReport ? trep('edit') : trep('write')}
                </Button>
              ) : (
                s.stage === 'taken' &&
                ownTeacher && (
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <LockIcon aria-hidden className="size-3.5" />
                    {trep('locked')}
                  </p>
                )
              )}
            </Section>
          </>
        )}
      <Separator />
      <Section title={t('detail.evidence')}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t('detail.teacherJoined')}</dt>
          <dd>{joined(s.evidence.teacherJoinedAt)}</dd>
          <dt className="text-muted-foreground">{t('detail.studentJoined')}</dt>
          <dd>{joined(s.evidence.studentJoinedAt)}</dd>
          {s.latenessMinutes > 0 && (
            <>
              <dt className="text-muted-foreground">{t('detail.lateness')}</dt>
              <dd>{t('minutes', { count: s.latenessMinutes })}</dd>
            </>
          )}
        </dl>
      </Section>
      {s.requests.length > 0 && (
        <>
          <Separator />
          <Section title={t('detail.requests')}>
            <ul className="flex flex-col gap-2">
              {s.requests.map((r) => (
                <li key={r.id} className="flex flex-col gap-1 text-sm">
                  <span className="flex flex-wrap gap-1.5">
                    <RequestTypeBadge type={r.type as RequestType} />
                    <RequestStatusBadge status={r.status as RequestStatus} />
                  </span>
                  <span>
                    <bdi>{r.reason}</bdi>
                  </span>
                  {r.proposedStartsAt && (
                    <span className="text-muted-foreground">
                      {tr('proposed')}: <bdi>{dayAndClock(r.proposedStartsAt, tz, locale)}</bdi>
                    </span>
                  )}
                  {r.decisionNote && (
                    <span className="text-muted-foreground">
                      {tr('decisionNote')}: <bdi>{r.decisionNote}</bdi>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
      <Separator />
      <Section title={t('detail.timeline')}>
        <ol className="flex flex-col gap-3 border-s ps-4">
          {[...s.events].reverse().map((e) => {
            const note = e.payload?.note ?? e.payload?.reason;
            return (
              <li key={e.id} className="flex flex-col gap-0.5 text-sm">
                <span className="font-semibold">
                  {t.has(`events.${e.type}`) ? t(`events.${e.type}`) : e.type}
                  {e.type === 'marked' && e.toStage ? ` — ${stageName(e.toStage)}` : ''}
                </span>
                <span
                  className="text-muted-foreground"
                  title={dayAndClock(e.occurredAt, tz, locale)}
                >
                  {e.actor?.name ?? t('detail.system')} · {relativeTime(e.occurredAt, now, locale)}
                </span>
                {typeof note === 'string' && note && (
                  <span>
                    <bdi>{note}</bdi>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </Section>
    </>
  );
}
