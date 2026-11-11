'use client';

import {
  REQUEST_TYPE_LABELS,
  type ConflictResultDto,
  type RequestType,
  type SessionDto,
} from '@qarabic/shared';
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
} from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { DatePicker, TimeSelect } from '@/components/forms/date-time';
import { canSave, ConflictList } from '@/components/sessions/conflict-list';
import { BothClassTimes, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { createRequest } from '@/lib/api/requests';
import { checkSchedule, scheduleKeys } from '@/lib/api/schedule';
import { can } from '@/lib/auth/use-me';
import { refreshClasses } from '@/lib/sessions/cache';
import { conflictsOf, useClassError } from '@/lib/sessions/errors';
import { addDays, dateKeyIn, hhmmIn, zonedInstant } from '@/lib/schedule-time';

/** Where the proposed time starts: the class time, a day later (or the same day for advance). */
function proposedDefaults(session: SessionDto, type: RequestType, tz: string) {
  const day = dateKeyIn(tz, new Date(session.startsAt));
  return {
    date: type === 'advance' ? day : addDays(day, 1),
    time: hhmmIn(session.startsAt, tz),
  };
}

/**
 * «طلب إجازة / تأجيل / تقديم / حصة إضافية» from a class's «⋯» (docs/15 §6.5, the current app's
 * `RequestDialog`): the reason, and for a new time a date and time in the viewer's zone, checked
 * against the schedule before sending (staff and teachers; a parent's request is checked by the
 * server). Some requests are approved on the spot (apps/api requests.ts) and say so.
 */
export function RequestDialog({
  session,
  type,
  open,
  onOpenChange,
}: {
  session: SessionDto;
  type: RequestType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('requests.form');
  const tr = useTranslations('requests');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = useClassError();
  const needsTime = type !== 'leave';
  const canCheck = can(me, 'schedule.view') && me.role?.kind !== 'parent';
  const initial = proposedDefaults(session, type, tz);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [reason, setReason] = useState('');
  const [notifiedAt, setNotifiedAt] = useState('');
  const [ack, setAck] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverResult, setServerResult] = useState<ConflictResultDto | null>(null);
  const startsAt = needsTime ? zonedInstant(date, time, tz) : null;

  const checkInput =
    startsAt && session.enrollmentId
      ? {
          enrollmentId: session.enrollmentId,
          startsAt,
          durationMinutes: session.durationMinutes,
          ...(type === 'extra' ? {} : { excludeSessionId: session.id }),
        }
      : null;
  const check = useQuery({
    queryKey: scheduleKeys.check(checkInput),
    queryFn: ({ signal }) => checkSchedule(checkInput!, signal),
    enabled: open && canCheck && !!checkInput,
    placeholderData: keepPreviousData,
  });
  const result = serverResult ?? (canCheck ? check.data : undefined);

  const create = useMutation({
    mutationFn: () =>
      createRequest({
        type,
        sessionId: session.id,
        reason: reason.trim(),
        ...(type === 'leave'
          ? { notifiedAt: notifiedAt ? new Date(notifiedAt).toISOString() : undefined }
          : { proposedStartsAt: startsAt! }),
        acknowledgeWarnings: ack,
      }),
    onSuccess: (r) => {
      refreshClasses(queryClient);
      close(false);
      toast.success(
        r.status === 'auto_approved'
          ? tr('done.autoApproved')
          : r.status === 'approved'
            ? tr('done.approvedNow')
            : tr('done.sent'),
      );
    },
    onError: (e) => {
      const conflicts = conflictsOf(e);
      if (conflicts) setServerResult(conflicts);
      else setError(message(e));
    },
  });

  function close(next: boolean) {
    if (!next) {
      const d = proposedDefaults(session, type, tz);
      setDate(d.date);
      setTime(d.time);
      setReason('');
      setNotifiedAt('');
      setAck([]);
      setTouched(false);
      setError(null);
      setServerResult(null);
    }
    onOpenChange(next);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    setError(null);
    if (!reason.trim()) return;
    if (needsTime && serverResult === null && result && !canSave(result, ack)) return;
    create.mutate();
  }

  const reset = () => {
    setServerResult(null);
    setAck([]);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {REQUEST_TYPE_LABELS[type][locale]} — {session.student.name}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="text-sm">
                <BothClassTimes
                  at={session.startsAt}
                  otherTz={session.student.timezone}
                  party="student"
                />
              </div>
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {needsTime && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="request-date">{t('date')}</FieldLabel>
                  <DatePicker
                    id="request-date"
                    value={date}
                    onChange={(v) => {
                      reset();
                      setDate(v);
                    }}
                    min={dateKeyIn(tz)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="request-time">{t('time')}</FieldLabel>
                  <TimeSelect
                    id="request-time"
                    value={time}
                    onChange={(v) => {
                      reset();
                      setTime(v);
                    }}
                  />
                  <FieldDescription>{t('timeHelp')}</FieldDescription>
                </Field>
              </div>
            )}
            {needsTime && (
              <ConflictList
                result={result}
                checking={canCheck && check.isFetching}
                acknowledged={ack}
                onAcknowledge={setAck}
              />
            )}
            {type === 'leave' && (
              <Field>
                <FieldLabel htmlFor="request-notified">{t('notifiedAt')}</FieldLabel>
                <Input
                  id="request-notified"
                  type="datetime-local"
                  dir="ltr"
                  className="h-10 text-start"
                  value={notifiedAt}
                  onChange={(e) => setNotifiedAt(e.target.value)}
                />
                <FieldDescription>{t('notifiedAtHelp')}</FieldDescription>
              </Field>
            )}
            <Field data-invalid={touched && !reason.trim()}>
              <FieldLabel htmlFor="request-reason">
                {t('reason')}
                <span aria-hidden className="text-destructive">
                  *
                </span>
              </FieldLabel>
              <Textarea
                id="request-reason"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-required
                aria-invalid={touched && !reason.trim()}
              />
              {touched && !reason.trim() && <FieldError>{t('reasonRequired')}</FieldError>}
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
              disabled={create.isPending || (needsTime && !!result && !canSave(result, ack))}
            >
              {create.isPending && <Spinner />}
              {t('send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
