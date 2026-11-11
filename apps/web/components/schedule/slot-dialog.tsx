'use client';

import type {
  ConflictResultDto,
  EnrollmentDto,
  ScheduleSlotDto,
  SessionDto,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Spinner } from '@qarabic/ui/components/spinner';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { DatePicker, TimeSelect } from '@/components/forms/date-time';
import { canSave, ConflictList } from '@/components/sessions/conflict-list';
import { DURATIONS } from '@/components/sessions/reschedule-dialog';
import { useUiLocale } from '@/components/sessions/times';
import { addSlot, checkSchedule, scheduleKeys, updateSlot } from '@/lib/api/schedule';
import { refreshClasses } from '@/lib/sessions/cache';
import { conflictsOf, useClassError } from '@/lib/sessions/errors';
import { dateKeyIn, nextOnWeekday, STAFF_WEEK, wallTime, weekdayName } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';
import { TeacherSide } from './teacher-side';

/**
 * Add or edit a weekly time (D38, docs/15 §6.3; the current app's `SlotDialog`): day, time in the
 * enrollment's zone, length and the date it applies from (an edit closes the old version the day
 * before). The teacher's side of the time and the DST note show as you pick; conflicts are checked
 * live before saving — hard ones block, warnings need a tick.
 */
export function SlotDialog({
  enrollment,
  slot,
  open,
  onOpenChange,
  onSaved,
}: {
  enrollment: EnrollmentDto;
  slot: ScheduleSlotDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (affected: SessionDto[]) => void;
}) {
  const t = useTranslations('schedule.slot');
  const locale = useUiLocale();
  const queryClient = useQueryClient();
  const message = useClassError();
  const today = dateKeyIn(enrollment.timezone);
  const [weekday, setWeekday] = useState(slot?.weekday ?? 6);
  const [time, setTime] = useState(slot?.localStartTime ?? '17:00');
  const [duration, setDuration] = useState(slot?.durationMinutes ?? enrollment.sessionMinutes);
  const [from, setFrom] = useState(() =>
    nextOnWeekday(today > enrollment.startsOn ? today : enrollment.startsOn, slot?.weekday ?? 6),
  );
  const [ack, setAck] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [serverResult, setServerResult] = useState<ConflictResultDto | null>(null);
  const unchanged =
    !!slot &&
    slot.weekday === weekday &&
    slot.localStartTime === time &&
    slot.durationMinutes === duration;
  const input = {
    enrollmentId: enrollment.id,
    studentId: enrollment.student.id,
    teacherId: enrollment.teacher.id,
    weekday,
    localStartTime: time,
    durationMinutes: duration,
    timezone: enrollment.timezone,
    validFrom: from,
    ...(slot ? { excludeSlotId: slot.id } : {}),
  };
  const check = useQuery({
    queryKey: scheduleKeys.check(input),
    queryFn: ({ signal }) => checkSchedule(input, signal),
    enabled: open && !unchanged,
    placeholderData: keepPreviousData,
  });
  const result = serverResult ?? check.data;
  const save = useMutation({
    mutationFn: async () => {
      if (slot) {
        return (
          await updateSlot(slot.id, {
            weekday,
            localStartTime: time,
            durationMinutes: duration,
            effectiveFrom: from,
            acknowledgeWarnings: ack,
          })
        ).affectedManualSessions;
      }
      await addSlot(enrollment.id, {
        weekday,
        localStartTime: time,
        durationMinutes: duration,
        validFrom: from,
        acknowledgeWarnings: ack,
      });
      return [];
    },
    onSuccess: (affected) => {
      refreshClasses(queryClient);
      onOpenChange(false);
      toast.success(slot ? t('updated') : t('added'));
      onSaved?.(affected);
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
            <DialogTitle>{slot ? t('editTitle') : t('addTitle')}</DialogTitle>
            <DialogDescription>
              {slot
                ? t('editHint', {
                    current: `${weekdayName(slot.weekday, locale)} ${wallTime(slot.localStartTime, locale)}`,
                  })
                : t('addHint', { name: enrollment.student.name })}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="slot-day">{t('day')}</FieldLabel>
                <Select
                  value={String(weekday)}
                  onValueChange={(v) => {
                    reset();
                    setWeekday(Number(v));
                    setFrom((f) => nextOnWeekday(f, Number(v)));
                  }}
                >
                  <SelectTrigger id="slot-day" className="h-10! w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {STAFF_WEEK.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {weekdayName(d, locale)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="slot-time">
                  {t('time', { city: cityOf(enrollment.timezone, locale) })}
                </FieldLabel>
                <TimeSelect
                  id="slot-time"
                  value={time}
                  onChange={(v) => {
                    reset();
                    setTime(v);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="slot-duration">{t('duration')}</FieldLabel>
                <Select
                  value={String(duration)}
                  onValueChange={(v) => {
                    reset();
                    setDuration(Number(v));
                  }}
                >
                  <SelectTrigger id="slot-duration" className="h-10! w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {[...new Set([...DURATIONS, duration])].map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {t('minutes', { count: m })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <TeacherSide
              slot={{ weekday, localStartTime: time, timezone: enrollment.timezone }}
              teacher={enrollment.teacher}
              from={from}
            />
            <Field>
              <FieldLabel htmlFor="slot-from">
                {slot ? t('effectiveFrom') : t('validFrom')}
              </FieldLabel>
              <DatePicker
                id="slot-from"
                value={from}
                min={today}
                onChange={(v) => {
                  reset();
                  setFrom(v);
                }}
              />
              <FieldDescription>{slot ? t('effectiveHelp') : t('validFromHelp')}</FieldDescription>
            </Field>
            {!unchanged && (
              <ConflictList
                result={result}
                checking={check.isFetching}
                acknowledged={ack}
                onAcknowledge={setAck}
              />
            )}
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
              disabled={unchanged || save.isPending || check.isFetching || !canSave(result, ack)}
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
