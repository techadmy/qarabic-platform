'use client';

import type { ConflictResultDto, SessionDto } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@qarabic/ui/components/field';
import { RadioGroup, RadioGroupItem } from '@qarabic/ui/components/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { DatePicker, TimeSelect } from '@/components/forms/date-time';
import { calendarKeys, moveSession } from '@/lib/api/calendar';
import { checkSchedule, scheduleKeys } from '@/lib/api/schedule';
import { upsertSession } from '@/lib/sessions/cache';
import { conflictsOf, useClassError } from '@/lib/sessions/errors';
import { dateKeyIn, hhmmIn, zonedInstant } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';
import { canSave, ConflictList } from './conflict-list';
import { OtherTime, useUiLocale, useViewerTz } from './times';

export const DURATIONS = [30, 45, 60, 90] as const;

/** What a move needs from a class: a board row or a calendar event. */
export type MovableClass = Pick<
  SessionDto,
  'id' | 'startsAt' | 'durationMinutes' | 'stage' | 'lockVersion' | 'enrollmentId'
> & {
  student: { name: string; timezone: string };
  teacher: { timezone: string };
  /** The weekly slot (calendar events): offers «هذه الحصة والحصص التالية». */
  slotId?: number | null;
};

/**
 * «تعديل الموعد» (staff, docs/15 §6.1 "shift/reschedule"): a new date and time in the viewer's
 * zone with the other parties' times beside it, checked live with `POST /schedule/check`;
 * hard conflicts block, warnings need a tick. `PATCH /sessions/:id` detaches the class.
 * From the calendar (C2, docs/42 §3.4) it opens on the dragged time, in the calendar's zone, asks
 * the Google question for a weekly class («هذه الحصة فقط» / «هذه الحصة والحصص التالية») and needs
 * a reason.
 */
export function RescheduleDialog({
  session,
  open,
  onOpenChange,
  initial,
  zone,
  requireReason = false,
}: {
  session: MovableClass;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The proposed time (a drag or resize on the calendar). */
  initial?: { startsAt: string; durationMinutes: number };
  /** The zone the date and time are typed in (default: the viewer's). */
  zone?: string;
  requireReason?: boolean;
}) {
  const t = useTranslations('classes.reschedule');
  const locale = useUiLocale();
  const viewerTz = useViewerTz();
  const tz = zone ?? viewerTz;
  const queryClient = useQueryClient();
  const message = useClassError();
  const start0 = initial?.startsAt ?? session.startsAt;
  const [date, setDate] = useState(() => dateKeyIn(tz, new Date(start0)));
  const [time, setTime] = useState(() => hhmmIn(start0, tz));
  const [duration, setDuration] = useState(initial?.durationMinutes ?? session.durationMinutes);
  const [reason, setReason] = useState('');
  const series = !!session.slotId;
  const [scope, setScope] = useState<'this' | 'following'>('this');
  const [triedSave, setTriedSave] = useState(false);
  const reasonMissing = requireReason && reason.trim().length < 3;
  const [ack, setAck] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [serverResult, setServerResult] = useState<ConflictResultDto | null>(null);
  const startsAt = zonedInstant(date, time, tz);
  const unchanged = startsAt === session.startsAt && duration === session.durationMinutes;

  const input = session.enrollmentId
    ? {
        enrollmentId: session.enrollmentId,
        startsAt,
        durationMinutes: duration,
        excludeSessionId: session.id,
      }
    : null;
  const check = useQuery({
    queryKey: scheduleKeys.check(input),
    queryFn: ({ signal }) => checkSchedule(input!, signal),
    enabled: open && !!input && !unchanged,
    placeholderData: keepPreviousData,
  });
  const result = serverResult ?? (unchanged ? undefined : check.data);

  const save = useMutation({
    mutationFn: () =>
      moveSession(session.id, {
        startsAt,
        durationMinutes: duration,
        expectedStage: session.stage,
        lockVersion: session.lockVersion,
        reason: reason.trim() || undefined,
        acknowledgeWarnings: ack,
        ...(series ? { scope } : {}),
      }),
    onSuccess: ({ session: s, series: change }) => {
      upsertSession(queryClient, s);
      void queryClient.invalidateQueries({ queryKey: calendarKeys.all });
      if (change) void queryClient.invalidateQueries({ queryKey: scheduleKeys.all });
      onOpenChange(false);
      toast.success(
        change
          ? t('doneSeries', {
              name: session.student.name,
              count: change.movedSessionIds.length + 1,
            })
          : t('done', { name: session.student.name }),
      );
    },
    onError: (e) => {
      const conflicts = conflictsOf(e);
      if (conflicts) setServerResult(conflicts);
      else setError(message(e));
    },
  });

  const reset = () => {
    setServerResult(null);
    setAck([]);
    setError(null);
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    setTriedSave(true);
    if (reasonMissing) return;
    save.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('title', { name: session.student.name })}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field className="sm:col-span-1">
                <FieldLabel htmlFor="shift-date">{t('date')}</FieldLabel>
                <DatePicker
                  id="shift-date"
                  value={date}
                  onChange={(v) => {
                    reset();
                    setDate(v);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="shift-time">
                  {t('time', { city: cityOf(tz, locale) })}
                </FieldLabel>
                <TimeSelect
                  id="shift-time"
                  value={time}
                  onChange={(v) => {
                    reset();
                    setTime(v);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="shift-duration">{t('duration')}</FieldLabel>
                <Select
                  value={String(duration)}
                  onValueChange={(v) => {
                    reset();
                    setDuration(Number(v));
                  }}
                >
                  <SelectTrigger id="shift-duration" className="h-10! w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {[...new Set([...DURATIONS, session.durationMinutes])].map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {t('minutes', { count: m })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <FieldDescription className="flex flex-col gap-0.5">
              <OtherTime at={startsAt} tz={session.student.timezone} party="student" />
              <OtherTime at={startsAt} tz={session.teacher.timezone} party="teacher" />
            </FieldDescription>
            {!unchanged && (
              <ConflictList
                result={result}
                checking={check.isFetching}
                acknowledged={ack}
                onAcknowledge={setAck}
              />
            )}
            {series && (
              <FieldSet>
                <FieldLegend variant="label">{t('scope.legend')}</FieldLegend>
                <RadioGroup
                  value={scope}
                  onValueChange={(v) => {
                    reset();
                    setScope(v as 'this' | 'following');
                  }}
                >
                  {(['this', 'following'] as const).map((v) => (
                    <Field key={v} orientation="horizontal">
                      <RadioGroupItem value={v} id={`shift-scope-${v}`} />
                      <FieldLabel htmlFor={`shift-scope-${v}`} className="font-normal">
                        {t(`scope.${v}`)}
                      </FieldLabel>
                    </Field>
                  ))}
                </RadioGroup>
                {scope === 'following' && (
                  <FieldDescription>{t('scope.followingHint')}</FieldDescription>
                )}
              </FieldSet>
            )}
            <Field data-invalid={triedSave && reasonMissing}>
              <FieldLabel htmlFor="shift-reason">
                {t('reason')}{' '}
                {!requireReason && (
                  <span className="font-normal text-muted-foreground">({t('optional')})</span>
                )}
              </FieldLabel>
              <Textarea
                id="shift-reason"
                rows={2}
                value={reason}
                aria-invalid={triedSave && reasonMissing}
                aria-describedby={triedSave && reasonMissing ? 'shift-reason-error' : undefined}
                onChange={(e) => setReason(e.target.value)}
              />
              {triedSave && reasonMissing && (
                <FieldError id="shift-reason-error">{t('reasonRequired')}</FieldError>
              )}
            </Field>
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertCircleIcon />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t('back')}
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={
                unchanged ||
                save.isPending ||
                (!!input && (check.isFetching || !canSave(result, ack)))
              }
            >
              {save.isPending && <Spinner />}
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
