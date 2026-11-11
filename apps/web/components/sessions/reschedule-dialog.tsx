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
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@qarabic/ui/components/field';
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
import { checkSchedule, scheduleKeys } from '@/lib/api/schedule';
import { updateSession } from '@/lib/api/sessions';
import { upsertSession } from '@/lib/sessions/cache';
import { conflictsOf, useClassError } from '@/lib/sessions/errors';
import { dateKeyIn, hhmmIn, zonedInstant } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';
import { canSave, ConflictList } from './conflict-list';
import { OtherTime, useUiLocale, useViewerTz } from './times';

export const DURATIONS = [30, 45, 60, 90] as const;

/**
 * «تعديل الموعد» (staff, docs/15 §6.1 "shift/reschedule"): a new date and time in the viewer's
 * zone with the other parties' times beside it, checked live with `POST /schedule/check`;
 * hard conflicts block, warnings need a tick. `PATCH /sessions/:id` detaches the class.
 */
export function RescheduleDialog({
  session,
  open,
  onOpenChange,
}: {
  session: SessionDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('classes.reschedule');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const queryClient = useQueryClient();
  const message = useClassError();
  const [date, setDate] = useState(() => dateKeyIn(tz, new Date(session.startsAt)));
  const [time, setTime] = useState(() => hhmmIn(session.startsAt, tz));
  const [duration, setDuration] = useState(session.durationMinutes);
  const [reason, setReason] = useState('');
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
      updateSession(session.id, {
        startsAt,
        durationMinutes: duration,
        expectedStage: session.stage,
        lockVersion: session.lockVersion,
        reason: reason.trim() || undefined,
        acknowledgeWarnings: ack,
      }),
    onSuccess: (s) => {
      upsertSession(queryClient, s);
      onOpenChange(false);
      toast.success(t('done', { name: session.student.name }));
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
            <Field>
              <FieldLabel htmlFor="shift-reason">
                {t('reason')}{' '}
                <span className="font-normal text-muted-foreground">({t('optional')})</span>
              </FieldLabel>
              <Textarea
                id="shift-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
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
