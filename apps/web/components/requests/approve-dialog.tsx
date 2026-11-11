'use client';

import {
  REQUEST_TYPE_LABELS,
  type ConflictResultDto,
  type SessionRequestDto,
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@qarabic/ui/components/field';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { DatePicker, TimeSelect } from '@/components/forms/date-time';
import { canSave, ConflictList } from '@/components/sessions/conflict-list';
import { OtherTime, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { approveRequest } from '@/lib/api/requests';
import { checkSchedule, scheduleKeys } from '@/lib/api/schedule';
import { can } from '@/lib/auth/use-me';
import { refreshClasses } from '@/lib/sessions/cache';
import { conflictsOf, useClassError } from '@/lib/sessions/errors';
import { dateKeyIn, hhmmIn, zonedInstant } from '@/lib/schedule-time';

/**
 * «موافقة» on a request (docs/15 §6.5): the proposed time can be changed before approving; the
 * time is checked live against the schedule (hard conflicts block, warnings need a tick), and an
 * optional note goes to the requester. A leave has no time to check.
 */
export function ApproveDialog({
  request,
  open,
  onOpenChange,
}: {
  request: SessionRequestDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('requests.approve');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = useClassError();
  const session = request.session ?? null;
  const proposed = request.proposedStartsAt;
  const [date, setDate] = useState(() => (proposed ? dateKeyIn(tz, new Date(proposed)) : ''));
  const [time, setTime] = useState(() => (proposed ? hhmmIn(proposed, tz) : ''));
  const [note, setNote] = useState('');
  const [ack, setAck] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [serverResult, setServerResult] = useState<ConflictResultDto | null>(null);
  const startsAt = proposed ? zonedInstant(date, time, tz) : null;
  const changed = !!startsAt && startsAt !== proposed;
  const canCheck = can(me, 'schedule.view');
  const input =
    startsAt && session?.enrollmentId
      ? {
          enrollmentId: session.enrollmentId,
          startsAt,
          durationMinutes: request.proposedDurationMinutes ?? session.durationMinutes,
          ...(request.type === 'extra' ? {} : { excludeSessionId: session.id }),
        }
      : null;
  const check = useQuery({
    queryKey: scheduleKeys.check(input),
    queryFn: ({ signal }) => checkSchedule(input!, signal),
    enabled: open && canCheck && !!input,
    placeholderData: keepPreviousData,
  });
  const result = serverResult ?? (input ? check.data : null);

  const approve = useMutation({
    mutationFn: () =>
      approveRequest(request.id, {
        ...(changed ? { startsAt: startsAt! } : {}),
        note: note.trim() || undefined,
        acknowledgeWarnings: ack,
      }),
    onSuccess: () => {
      refreshClasses(queryClient);
      onOpenChange(false);
      toast.success(t('done'));
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
    approve.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {t('title', {
                type: REQUEST_TYPE_LABELS[request.type][locale],
                name: request.student?.name ?? '',
              })}
            </DialogTitle>
            <DialogDescription>
              {proposed ? t('descriptionTime') : t('descriptionLeave')}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {proposed && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="approve-date">{t('date')}</FieldLabel>
                    <DatePicker
                      id="approve-date"
                      value={date}
                      onChange={(v) => {
                        reset();
                        setDate(v);
                      }}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="approve-time">{t('time')}</FieldLabel>
                    <TimeSelect
                      id="approve-time"
                      value={time}
                      onChange={(v) => {
                        reset();
                        setTime(v);
                      }}
                    />
                  </Field>
                </div>
                {session && startsAt && (
                  <FieldDescription className="flex flex-col gap-0.5">
                    <OtherTime at={startsAt} tz={session.student.timezone} party="student" />
                    <OtherTime at={startsAt} tz={session.teacher.timezone} party="teacher" />
                  </FieldDescription>
                )}
                {input && (
                  <ConflictList
                    result={result}
                    checking={canCheck && check.isFetching}
                    acknowledged={ack}
                    onAcknowledge={setAck}
                  />
                )}
              </>
            )}
            <Field>
              <FieldLabel htmlFor="approve-note">
                {t('note')}{' '}
                <span className="font-normal text-muted-foreground">({t('optional')})</span>
              </FieldLabel>
              <Textarea
                id="approve-note"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
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
              disabled={approve.isPending || (!!input && !!result && !canSave(result, ack))}
            >
              {approve.isPending && <Spinner />}
              {t('confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
