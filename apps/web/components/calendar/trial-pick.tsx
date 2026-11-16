'use client';

import {
  TRIAL_INELIGIBLE_LABELS,
  type TrialIneligibleReason,
  type TrialTeacherOptionDto,
} from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertCircleIcon, CalendarSearchIcon, CheckIcon, SendIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ToneBadge } from '@/components/sessions/badges';
import { useUiLocale } from '@/components/sessions/times';
import { createTrialOffer, fetchLead, fetchTrialTeachers } from '@/lib/api/crm';
import { useCrmError } from '@/components/crm/crm-bits';
import { dateKeyIn, dayAndClock, hhmmIn } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';

/** Reasons that depend on the chosen time only; the others rule a teacher out for the trial. */
const TIME_REASONS: readonly TrialIneligibleReason[] = ['busy', 'on_leave', 'weekly_limit'];

export interface TrialMode {
  leadId: number;
  studentId: number;
  courseId: number;
  minutes: number;
}

/** `?trialLead&trialStudent&trialCourse&trialMinutes` (from the trial booking, docs/42 §3 C3). */
export function trialModeOf(get: (k: string) => string | null): TrialMode | null {
  const leadId = Number(get('trialLead'));
  const studentId = Number(get('trialStudent'));
  const courseId = Number(get('trialCourse'));
  if (!leadId || !studentId || !courseId) return null;
  const minutes = Number(get('trialMinutes'));
  return { leadId, studentId, courseId, minutes: [30, 45, 60].includes(minutes) ? minutes : 30 };
}

/**
 * The teachers who can take this trial at all (course, gender, age group, taking trials), from the
 * eligibility check at a reference time of the day shown: the calendar keeps only their columns.
 */
export function useTrialTeachers(mode: TrialMode | null, date: string, tz: string) {
  return useQuery({
    queryKey: ['crm', 'trial-teachers', mode?.leadId, 'calendar', mode, date, tz],
    queryFn: ({ signal }) =>
      fetchTrialTeachers(
        mode!.leadId,
        {
          studentId: mode!.studentId,
          courseId: mode!.courseId,
          localDate: date,
          localTime: '12:00',
          timezone: tz,
          durationMinutes: mode!.minutes,
        },
        signal,
      ),
    enabled: !!mode,
    select: (r) =>
      [...r.data.eligible, ...r.data.ineligible]
        .filter((o) => o.reasons.every((x) => TIME_REASONS.includes(x)))
        .map((o) => o.teacher),
  });
}

/** «اختيار معلم للحصة التجريبية»: says what is being booked, and how to leave. */
export function TrialBanner({ mode }: { mode: TrialMode }) {
  const t = useTranslations('calendar.trial');
  const lead = useQuery({
    queryKey: ['crm', 'lead', mode.leadId],
    queryFn: ({ signal }) => fetchLead(mode.leadId, signal),
  });
  const student = lead.data?.students.find((s) => s.id === mode.studentId);
  return (
    <Alert>
      <CalendarSearchIcon />
      <AlertTitle>{t('title', { name: student?.name ?? lead.data?.parentName ?? '' })}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        {t('hint', { minutes: mode.minutes })}
        <Button asChild variant="outline" size="sm">
          <Link href={`/leads/${mode.leadId}`}>{t('back')}</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * A click on a teacher's time in trial mode: the eligibility check for that exact time (ranked),
 * then «أرسل العرض» creates the trial offer to that teacher (the existing T3 offer, shortlist of
 * one). Other eligible teachers at the same time are offered as alternatives.
 */
export function TrialPickDialog({
  mode,
  at,
  tz,
  teacherId,
  onClose,
}: {
  mode: TrialMode;
  at: Date;
  tz: string;
  teacherId: number | null;
  onClose: () => void;
}) {
  const t = useTranslations('calendar.trial');
  const locale = useUiLocale();
  const router = useRouter();
  const message = useCrmError();
  const localDate = dateKeyIn(tz, at);
  const localTime = hhmmIn(at.toISOString(), tz);
  const query = {
    studentId: mode.studentId,
    courseId: mode.courseId,
    localDate,
    localTime,
    timezone: tz,
    durationMinutes: mode.minutes,
  };
  const check = useQuery({
    queryKey: ['crm', 'trial-teachers', mode.leadId, query],
    queryFn: ({ signal }) => fetchTrialTeachers(mode.leadId, query, signal),
  });
  const [chosen, setChosen] = useState<number | null>(teacherId);
  const all = check.data ? [...check.data.data.eligible, ...check.data.data.ineligible] : [];
  const option = all.find((o) => o.teacher.id === chosen);
  const others = (check.data?.data.eligible ?? []).filter((o) => o.teacher.id !== chosen);
  const send = useMutation({
    mutationFn: (id: number) =>
      createTrialOffer(mode.leadId, {
        ...query,
        audience: 'shortlist',
        teacherIds: [id],
      }),
    onSuccess: () => {
      toast.success(t('sent', { name: option?.teacher.name ?? '' }));
      router.push(`/leads/${mode.leadId}`);
    },
  });
  const reasons = (o: TrialTeacherOptionDto) =>
    o.reasons.map((r) => TRIAL_INELIGIBLE_LABELS[r][locale]).join('، ');

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('pickTitle')}</DialogTitle>
          <DialogDescription>
            <bdi>{dayAndClock(at.toISOString(), tz, locale)}</bdi> ({cityOf(tz, locale)}) ·{' '}
            {t('minutes', { count: mode.minutes })}
          </DialogDescription>
        </DialogHeader>
        {check.isPending ? (
          <Skeleton className="h-24" />
        ) : check.isError ? (
          <Alert variant="destructive" role="alert">
            <AlertCircleIcon />
            <AlertDescription>{message(check.error)}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-3">
            {option ? (
              <div className="flex flex-col gap-1 rounded-lg border p-3">
                <span className="flex flex-wrap items-center gap-2 font-semibold">
                  {option.teacher.name}
                  {option.eligible ? (
                    <ToneBadge tone="green" icon={CheckIcon} label={t('eligible')} />
                  ) : (
                    <ToneBadge tone="red" icon={AlertCircleIcon} label={t('notEligible')} />
                  )}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t('teacherTime')} <bdi>{option.teacherLocal.time}</bdi> (
                  {cityOf(option.teacher.timezone, locale)})
                </span>
                {!option.eligible && <span className="text-sm">{reasons(option)}</span>}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('chooseBelow')}</p>
            )}
            {others.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-sm font-semibold">{t('others')}</span>
                <ul className="flex flex-wrap gap-2">
                  {others.slice(0, 8).map((o) => (
                    <li key={o.teacher.id}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-6"
                        onClick={() => setChosen(o.teacher.id)}
                      >
                        {o.rank ? `${o.rank}. ` : ''}
                        {o.teacher.name}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {send.isError && (
              <Alert variant="destructive" role="alert">
                <AlertCircleIcon />
                <AlertDescription>{message(send.error)}</AlertDescription>
              </Alert>
            )}
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t('cancel')}</Button>
          </DialogClose>
          <Button
            disabled={!option?.eligible || send.isPending}
            onClick={() => option && send.mutate(option.teacher.id)}
          >
            {send.isPending ? <Spinner /> : <SendIcon />}
            {t('send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
