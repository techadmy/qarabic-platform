'use client';

import {
  SESSION_STAGE_LABELS,
  type RequestStatus,
  type RequestType,
  type SessionDetailDto,
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
import { useQuery } from '@tanstack/react-query';
import { CalendarRangeIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState } from '@/components/states';
import { fetchSession, sessionKeys } from '@/lib/api/sessions';
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

/** The class open in the sheet lives in the URL (`?session=12`), so Back and links work. */
export function useOpenSession() {
  const params = useListParams();
  const id = Number(params.get('session')) || null;
  return {
    id,
    open: (sessionId: number) => params.set({ session: sessionId }, { resetPage: false }),
    close: () => params.set({ session: null }, { resetPage: false }),
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
  const { id, close } = useOpenSession();
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
        className="w-full gap-0 overflow-y-auto sm:max-w-md"
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
  const t = useTranslations('classes');
  const tr = useTranslations('requests');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const now = useNow();
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
