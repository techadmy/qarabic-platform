'use client';

import {
  AVAILABILITY_CHANGE_KIND_LABELS,
  AVAILABILITY_CHANGE_STATUS_LABELS,
  type AvailabilityChangeDto,
  type AvailabilityChangeStatus,
  type WorkHourDto,
} from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleXIcon,
  ClockIcon,
  TriangleAlertIcon,
  Undo2Icon,
  XIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { ToneBadge } from '@/components/sessions/badges';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { ErrorState } from '@/components/states';
import {
  approveAvailabilityChange,
  availabilityKeys,
  fetchAvailabilityChanges,
  rejectAvailabilityChange,
  withdrawAvailabilityChange,
} from '@/lib/api/availability';
import { scheduleKeys } from '@/lib/api/schedule';
import { useClassError } from '@/lib/sessions/errors';
import { dayAndClock, dayLabel, wallTime, weekdayName } from '@/lib/schedule-time';

const STATUS_LOOK: Record<
  AvailabilityChangeStatus,
  { tone: 'amber' | 'green' | 'grey' | 'red' | 'lightBlue'; icon: typeof ClockIcon }
> = {
  pending: { tone: 'amber', icon: ClockIcon },
  approved: { tone: 'lightBlue', icon: CircleDotIcon },
  applied: { tone: 'green', icon: CircleCheckIcon },
  rejected: { tone: 'red', icon: CircleXIcon },
  withdrawn: { tone: 'grey', icon: Undo2Icon },
};

/** What the change asks, in words: the new weekly hours, or the block. */
function Summary({ c }: { c: AvailabilityChangeDto }) {
  const t = useTranslations('availability');
  const locale = useUiLocale();
  if (c.kind === 'work_hours') {
    const hours = (c.payload.workHours as WorkHourDto[] | undefined) ?? [];
    if (!hours.length) return <span>{t('noHours')}</span>;
    return (
      <ul className="flex flex-col gap-0.5">
        {hours.map((h, i) => (
          <li key={i}>
            {weekdayName(h.weekday, locale)}:{' '}
            <bdi>
              {wallTime(h.localStartTime, locale)} – {wallTime(h.localEndTime, locale)}
            </bdi>
          </li>
        ))}
      </ul>
    );
  }
  const p = c.payload as {
    startsAt?: string;
    endsAt?: string;
    weekday?: number;
    localStartTime?: string;
  };
  if (c.kind === 'block_delete') return <span>{t('blockRemoved', { id: c.blockId ?? '' })}</span>;
  return (
    <span>
      {p.startsAt && p.endsAt ? (
        <bdi>
          {dayAndClock(p.startsAt, c.teacher.timezone, locale)} –{' '}
          {dayAndClock(p.endsAt, c.teacher.timezone, locale)}
        </bdi>
      ) : p.weekday ? (
        <>
          {weekdayName(p.weekday, locale)} <bdi>{wallTime(p.localStartTime ?? '', locale)}</bdi>
        </>
      ) : (
        '—'
      )}
    </span>
  );
}

/**
 * A teacher's availability requests (A1, docs/42 §4, B131): what was asked and from when, its
 * status, who decided and why; the booked classes it would leave outside the new hours. Staff with
 * `schedule.manage` approve or reject (with a reason), never their own; the teacher can withdraw
 * a pending one. `teacherId` narrows to one teacher (their timetable); without it, the queue.
 */
export function AvailabilityChanges({
  teacherId,
  status,
  title,
  description,
  showTeacher = false,
}: {
  teacherId?: number;
  status?: AvailabilityChangeStatus;
  title: string;
  description?: string;
  showTeacher?: boolean;
}) {
  const t = useTranslations('availability');
  const locale = useUiLocale();
  const viewerTz = useViewerTz();
  const queryClient = useQueryClient();
  const message = useClassError();
  const query = { ...(teacherId ? { teacherId } : {}), ...(status ? { status } : {}) };
  const list = useQuery({
    queryKey: availabilityKeys.list(query),
    queryFn: ({ signal }) => fetchAvailabilityChanges(query, signal),
  });
  const [rejecting, setRejecting] = useState<AvailabilityChangeDto | null>(null);
  const done = (msg: string) => {
    void queryClient.invalidateQueries({ queryKey: availabilityKeys.all });
    void queryClient.invalidateQueries({ queryKey: scheduleKeys.all });
    toast.success(msg);
  };
  const approve = useMutation({
    mutationFn: (c: AvailabilityChangeDto) => approveAvailabilityChange(c.id),
    onSuccess: (c) => done(t('approved', { name: c.teacher.name })),
    onError: (e) => toast.error(message(e)),
  });
  const reject = useMutation({
    mutationFn: (v: { id: number; reason: string }) => rejectAvailabilityChange(v.id, v.reason),
    onSuccess: (c) => {
      setRejecting(null);
      done(t('rejected', { name: c.teacher.name }));
    },
  });
  const withdraw = useMutation({
    mutationFn: (c: AvailabilityChangeDto) => withdrawAvailabilityChange(c.id),
    onSuccess: () => done(t('withdrawn')),
    onError: (e) => toast.error(message(e)),
  });

  const rows = list.data ?? [];
  if (teacherId && list.isSuccess && rows.length === 0) return null;

  return (
    <Card role="region" className="gap-2 shadow-none" aria-labelledby="availability-changes-title">
      <CardHeader className="border-b">
        <CardTitle className="text-base font-bold">
          <h2 id="availability-changes-title">{title}</h2>
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {list.isError ? (
          <ErrorState onRetry={() => void list.refetch()} />
        ) : list.isPending ? (
          <Skeleton className="h-24" />
        ) : rows.length === 0 ? (
          <p className="py-2 text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {rows.map((c) => {
              const look = STATUS_LOOK[c.status];
              return (
                <li key={c.id} className="flex flex-col gap-2 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">
                      {AVAILABILITY_CHANGE_KIND_LABELS[c.kind][locale]}
                    </span>
                    <ToneBadge
                      tone={look.tone}
                      icon={look.icon}
                      label={AVAILABILITY_CHANGE_STATUS_LABELS[c.status][locale]}
                    />
                    {showTeacher && (
                      <Link
                        href={`/teachers/${c.teacher.id}/timetable`}
                        className="text-primary hover:underline"
                      >
                        {c.teacher.name}
                      </Link>
                    )}
                  </div>
                  <div className="text-sm">
                    <Summary c={c} />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t('meta', {
                      from: dayLabel(c.effectiveFrom, locale, true),
                      when: dayAndClock(c.requestedAt, viewerTz, locale),
                    })}
                  </p>
                  {c.note && <p className="text-sm">{t('note', { note: c.note })}</p>}
                  {c.decisionReason && (
                    <p className="text-sm text-muted-foreground">
                      {t('decision', { reason: c.decisionReason })}
                    </p>
                  )}
                  {c.affected.length > 0 && (
                    <Alert variant="warning">
                      <TriangleAlertIcon />
                      <AlertTitle>{t('affected', { count: c.affected.length })}</AlertTitle>
                      <AlertDescription>
                        <ul className="flex flex-col gap-0.5">
                          {c.affected.slice(0, 8).map((a) => (
                            <li key={a.id}>
                              <bdi>{dayAndClock(a.startsAt, c.teacher.timezone, locale)}</bdi> ·{' '}
                              {a.student.name}
                            </li>
                          ))}
                        </ul>
                        {c.affected.length > 8 && (
                          <span>{t('affectedMore', { count: c.affected.length - 8 })}</span>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}
                  {(c.can.approve || c.can.reject || c.can.withdraw) && (
                    <div className="flex flex-wrap gap-2">
                      {c.can.approve && (
                        <Button
                          className="h-9"
                          disabled={approve.isPending}
                          onClick={() => approve.mutate(c)}
                        >
                          <CheckIcon />
                          {t('approve')}
                        </Button>
                      )}
                      {c.can.reject && (
                        <Button variant="outline" className="h-9" onClick={() => setRejecting(c)}>
                          <XIcon />
                          {t('reject')}
                        </Button>
                      )}
                      {c.can.withdraw && (
                        <Button
                          variant="outline"
                          className="h-9"
                          disabled={withdraw.isPending}
                          onClick={() => withdraw.mutate(c)}
                        >
                          <Undo2Icon />
                          {t('withdraw')}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <ReasonDialog
        open={!!rejecting}
        onOpenChange={(o) => {
          if (!o) {
            setRejecting(null);
            reject.reset();
          }
        }}
        destructive
        title={rejecting ? t('rejectTitle', { name: rejecting.teacher.name }) : ''}
        description={t('rejectHint')}
        confirmLabel={t('reject')}
        textLabel={t('reason')}
        textRequired
        textMin={3}
        busy={reject.isPending}
        error={reject.isError ? message(reject.error) : null}
        onConfirm={({ text }) => rejecting && reject.mutate({ id: rejecting.id, reason: text })}
      />
    </Card>
  );
}
