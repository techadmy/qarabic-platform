'use client';

import {
  ENROLLMENT_KIND_LABELS,
  MEETING_MODE_LABELS,
  PAUSE_REASON_LABELS,
  PAUSE_REASONS,
  type EnrollmentDetailDto,
  type MeetingMode,
  type ScheduleSlotDto,
  type SessionDto,
} from '@qarabic/shared';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Field, FieldDescription, FieldLabel } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import { RadioGroup, RadioGroupItem } from '@qarabic/ui/components/radio-group';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRightIcon,
  CalendarXIcon,
  CirclePauseIcon,
  CirclePlayIcon,
  PencilIcon,
  PlusIcon,
  SquareIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Combobox } from '@/components/forms/fields';
import { DatePicker } from '@/components/forms/date-time';
import { PageHeader } from '@/components/page-header';
import { InfoSection, ProfileSkeleton } from '@/components/people/detail';
import { SlotDialog } from '@/components/schedule/slot-dialog';
import { TeacherSide } from '@/components/schedule/teacher-side';
import { EnrollmentStatusBadge } from '@/components/sessions/badges';
import { ClassTable } from '@/components/sessions/class-table';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { SessionSheet, useOpenSession } from '@/components/sessions/session-sheet';
import { useNow, useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchPeopleList } from '@/lib/api/people';
import {
  endSlot,
  enrollmentLifecycle,
  fetchEnrollment,
  scheduleKeys,
  updateEnrollment,
} from '@/lib/api/schedule';
import { can } from '@/lib/auth/use-me';
import { peopleKeys } from '@/lib/people/use-person-actions';
import { refreshClasses } from '@/lib/sessions/cache';
import { conflictsOf, useClassError } from '@/lib/sessions/errors';
import { dateKeyIn, wallTime, weekdayName } from '@/lib/schedule-time';
import { cityOf, formatDate } from '@/lib/time';

type Dialog =
  | { kind: 'slot'; slot: ScheduleSlotDto | null }
  | { kind: 'endSlot'; slot: ScheduleSlotDto }
  | { kind: 'pause' | 'end' | 'teacher' | 'meeting' }
  | null;

/**
 * One enrollment (docs/15 §6.3; the current app's `EnrollmentDetailPage`), a workbench: the
 * header with «تغيير المعلم», «إيقاف مؤقت» / «استئناف» and «إنهاء الاشتراك» (reason / date,
 * confirmed); the facts; the weekly times in the family's zone with the teacher's side and the DST
 * note, add / edit (versioned from a date) / end; then the next classes.
 */
export function EnrollmentView({ id }: { id: number }) {
  const t = useTranslations('schedule');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const now = useNow(60_000);
  const queryClient = useQueryClient();
  const message = useClassError();
  const { open } = useOpenSession();
  const canManage = can(me, 'schedule.manage');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [affected, setAffected] = useState<SessionDto[]>([]);
  const query = useQuery({
    queryKey: scheduleKeys.enrollment(id),
    queryFn: ({ signal }) => fetchEnrollment(id, signal),
    enabled: Number.isInteger(id) && id > 0,
  });
  const lifecycle = useMutation({
    mutationFn: (v: { action: 'pause' | 'resume' | 'end'; body?: Record<string, string> }) =>
      enrollmentLifecycle(id, v.action, v.body as never),
    onSuccess: (_e, v) => {
      refreshClasses(queryClient);
      setDialog(null);
      toast.success(t(`done.${v.action}`));
    },
    onError: (e) => setDialogError(message(e)),
  });
  const stopSlot = useMutation({
    mutationFn: (v: { slotId: number; validTo: string }) =>
      endSlot(v.slotId, { validTo: v.validTo }),
    onSuccess: () => {
      refreshClasses(queryClient);
      setDialog(null);
      toast.success(t('done.slotEnded'));
    },
    onError: (e) => setDialogError(message(e)),
  });

  if (isApiError(query.error, 403)) return <ForbiddenState />;
  if (isApiError(query.error, 404)) {
    return (
      <EmptyState
        icon={CalendarXIcon}
        role="alert"
        title={t('notFoundTitle')}
        description={t('notFound')}
      />
    );
  }
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />;
  if (query.isPending) return <ProfileSkeleton />;
  const e = query.data;
  const course = locale === 'ar' ? e.course.nameAr : e.course.nameEn;
  const live = e.status !== 'ended';
  const manage = canManage && live;
  const today = dateKeyIn(e.timezone, now);
  const openDialog = (d: Dialog) => {
    setDialogError(null);
    setDialog(d);
  };

  return (
    <>
      <PageHeader
        back={{ href: '/schedule', label: t('back') }}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{t('detailTitle', { student: e.student.name, course })}</span>
            <EnrollmentStatusBadge status={e.status} />
          </span>
        }
        meta={
          e.status === 'paused' && e.pausedReason
            ? t('pausedBecause', {
                reason:
                  PAUSE_REASON_LABELS[e.pausedReason as keyof typeof PAUSE_REASON_LABELS]?.[
                    locale
                  ] ?? e.pausedReason,
              })
            : undefined
        }
        actions={
          manage ? (
            <>
              <Button
                variant="outline"
                className="h-10"
                onClick={() => openDialog({ kind: 'teacher' })}
              >
                <ArrowLeftRightIcon />
                {t('changeTeacher')}
              </Button>
              {e.status === 'active' ? (
                <Button
                  variant="outline"
                  className="h-10"
                  onClick={() => openDialog({ kind: 'pause' })}
                >
                  <CirclePauseIcon />
                  {t('pause')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="h-10"
                  disabled={lifecycle.isPending}
                  onClick={() =>
                    lifecycle.mutate(
                      { action: 'resume' },
                      { onError: (err) => toast.error(message(err)) },
                    )
                  }
                >
                  <CirclePlayIcon />
                  {t('resume')}
                </Button>
              )}
              <Button
                variant="outline"
                className="h-10 text-destructive"
                onClick={() => openDialog({ kind: 'end' })}
              >
                <SquareIcon />
                {t('end')}
              </Button>
            </>
          ) : undefined
        }
      />

      {affected.length > 0 && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <TriangleAlertIcon />
          <AlertTitle>{t('affected', { count: affected.length })}</AlertTitle>
          <AlertDescription className="text-inherit">{t('affectedHint')}</AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={() => setAffected([])}>
              {t('dismiss')}
            </Button>
          </AlertAction>
        </Alert>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <InfoSection
          title={t('sections.details')}
          rows={[
            {
              label: t('fields.teacher'),
              value: (
                <span className="flex flex-wrap items-center gap-x-2">
                  {e.teacher.name} ({cityOf(e.teacher.timezone, locale)})
                  {can(me, 'schedule.view') && (
                    <Link
                      href={`/teachers/${e.teacher.id}/timetable`}
                      className="text-primary hover:underline"
                    >
                      {t('openTimetable')}
                    </Link>
                  )}
                </span>
              ),
            },
            { label: t('fields.timezone'), value: cityOf(e.timezone, locale) },
            { label: t('fields.kind'), value: ENROLLMENT_KIND_LABELS[e.kind][locale] },
            { label: t('fields.length'), value: t('minutes', { count: e.sessionMinutes }) },
            { label: t('fields.startsOn'), value: formatDate(e.startsOn, locale) },
            { label: t('fields.endsOn'), value: formatDate(e.endsOn, locale) },
          ]}
        />
        <InfoSection
          title={t('sections.meeting')}
          onEdit={manage ? () => openDialog({ kind: 'meeting' }) : undefined}
          rows={[
            { label: t('fields.meetingMode'), value: MEETING_MODE_LABELS[e.meetingMode][locale] },
            ...(e.externalMeetingUrl !== undefined
              ? [
                  {
                    label: t('fields.meetingUrl'),
                    value: e.externalMeetingUrl && (
                      <bdi dir="ltr" className="break-all">
                        {e.externalMeetingUrl}
                      </bdi>
                    ),
                  },
                ]
              : []),
            ...(e.notes !== undefined
              ? [{ label: t('fields.notes'), value: e.notes, wide: true }]
              : []),
          ]}
        />
      </div>

      <Card className="gap-2 shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-base font-bold">{t('sections.slots')}</CardTitle>
          {manage && (
            <CardAction>
              <Button
                variant="ghost"
                size="sm"
                className="text-primary"
                onClick={() => openDialog({ kind: 'slot', slot: null })}
              >
                <PlusIcon />
                {t('addSlot')}
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          {e.slots.length === 0 ? (
            <p className="py-2 text-muted-foreground">{t('noSlots')}</p>
          ) : (
            <ul className="divide-y" aria-label={t('sections.slots')}>
              {e.slots.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold">
                      {t('slotLine', {
                        day: weekdayName(s.weekday, locale),
                        time: wallTime(s.localStartTime, locale),
                        city: cityOf(s.timezone, locale),
                        minutes: s.durationMinutes,
                      })}
                    </span>
                    <TeacherSide
                      slot={s}
                      teacher={e.teacher}
                      from={today}
                      variesWithDst={s.teacherLocal.variesWithDst}
                    />
                    <span className="text-sm text-muted-foreground">
                      {s.validFrom > today
                        ? t('startsFrom', { date: formatDate(s.validFrom, locale) ?? '' })
                        : t('since', { date: formatDate(s.validFrom, locale) ?? '' })}
                      {s.validTo && (
                        <> · {t('until', { date: formatDate(s.validTo, locale) ?? '' })}</>
                      )}
                    </span>
                  </div>
                  {manage && !s.validTo && (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openDialog({ kind: 'slot', slot: s })}
                      >
                        <PencilIcon />
                        {t('editSlot')}
                        <span className="sr-only">: {weekdayName(s.weekday, locale)}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => openDialog({ kind: 'endSlot', slot: s })}
                      >
                        {t('endSlot')}
                        <span className="sr-only">: {weekdayName(s.weekday, locale)}</span>
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <section aria-labelledby="upcoming-title" className="flex flex-col gap-2">
        <h2 id="upcoming-title" className="text-lg font-bold">
          {t('sections.upcoming')}
        </h2>
        {e.upcomingSessions.length === 0 ? (
          <p className="text-muted-foreground">{t('noUpcoming')}</p>
        ) : (
          <Card className="gap-0 py-0 shadow-none">
            <ClassTable
              rows={e.upcomingSessions}
              now={now}
              onOpen={(s) => open(s.id)}
              label={t('sections.upcoming')}
              showDate
            />
          </Card>
        )}
      </section>

      {dialog?.kind === 'slot' && (
        <SlotDialog
          enrollment={e}
          slot={dialog.slot}
          open
          onOpenChange={(o) => !o && setDialog(null)}
          onSaved={setAffected}
        />
      )}
      <ReasonDialog
        open={dialog?.kind === 'pause'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t('pauseTitle', { name: e.student.name })}
        description={t('pauseBody')}
        confirmLabel={t('pause')}
        choices={PAUSE_REASONS.map((r) => ({ value: r, label: PAUSE_REASON_LABELS[r][locale] }))}
        choiceLabel={t('pauseReason')}
        busy={lifecycle.isPending}
        error={dialogError}
        onConfirm={(r) => lifecycle.mutate({ action: 'pause', body: { reason: r.choice } })}
      />
      <DateConfirm
        open={dialog?.kind === 'end'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={t('endTitle', { name: e.student.name })}
        description={t('endBody')}
        label={t('fields.endsOn')}
        confirmLabel={t('end')}
        initial={today}
        min={e.startsOn}
        busy={lifecycle.isPending}
        error={dialogError}
        onConfirm={(date) => lifecycle.mutate({ action: 'end', body: { endsOn: date } })}
      />
      {dialog?.kind === 'endSlot' && (
        <DateConfirm
          open
          onOpenChange={(o) => !o && setDialog(null)}
          title={t('endSlotTitle', {
            slot: `${weekdayName(dialog.slot.weekday, locale)} ${wallTime(dialog.slot.localStartTime, locale)}`,
          })}
          description={t('endSlotBody')}
          label={t('lastDay')}
          confirmLabel={t('endSlot')}
          initial={today}
          min={dialog.slot.validFrom}
          busy={stopSlot.isPending}
          error={dialogError}
          onConfirm={(date) => stopSlot.mutate({ slotId: dialog.slot.id, validTo: date })}
        />
      )}
      {dialog?.kind === 'teacher' && (
        <ChangeTeacherDialog
          enrollment={e}
          onClose={() => setDialog(null)}
          onAffected={setAffected}
        />
      )}
      {dialog?.kind === 'meeting' && (
        <MeetingDialog enrollment={e} onClose={() => setDialog(null)} />
      )}
      <SessionSheet />
    </>
  );
}

/** A destructive confirm with a date (end an enrollment or a weekly time). */
function DateConfirm({
  open,
  onOpenChange,
  title,
  description,
  label,
  confirmLabel,
  initial,
  min,
  busy,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  confirmLabel: string;
  initial: string;
  min?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (date: string) => void;
}) {
  const [date, setDate] = useState(initial);
  return (
    <ReasonDialog
      open={open}
      onOpenChange={onOpenChange}
      destructive
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      busy={busy}
      error={error}
      extra={
        <Field>
          <FieldLabel htmlFor="confirm-date">{label}</FieldLabel>
          <DatePicker id="confirm-date" value={date} onChange={setDate} min={min} />
        </Field>
      }
      onConfirm={() => onConfirm(date)}
    />
  );
}

function ChangeTeacherDialog({
  enrollment: e,
  onClose,
  onAffected,
}: {
  enrollment: EnrollmentDetailDto;
  onClose: () => void;
  onAffected: (s: SessionDto[]) => void;
}) {
  const t = useTranslations('schedule');
  const locale = useUiLocale();
  const queryClient = useQueryClient();
  const message = useClassError();
  const [teacherId, setTeacherId] = useState<string | null>(null);
  const [from, setFrom] = useState(() => dateKeyIn(e.timezone));
  const [ack, setAck] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const teachers = useQuery({
    queryKey: peopleKeys.list('teachers', { status: 'active', perPage: 100 }),
    queryFn: ({ signal }) =>
      fetchPeopleList('teachers', { status: 'active', perPage: 100 }, signal),
  });
  const save = useMutation({
    mutationFn: () =>
      updateEnrollment(e.id, {
        teacherId: Number(teacherId),
        effectiveFrom: from,
        acknowledgeWarnings: ack,
      }),
    onSuccess: (r) => {
      refreshClasses(queryClient);
      onAffected(r.affectedManualSessions);
      onClose();
      toast.success(t('done.teacherChanged'));
    },
    onError: (err) => {
      const conflicts = conflictsOf(err);
      if (conflicts?.conflicts.length) setError(t('teacherConflict'));
      else if (conflicts) {
        setAck(conflicts.warnings.map((w) => w.code));
        setError(t('teacherWarnings'));
      } else setError(message(err));
    },
  });
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('changeTeacherTitle', { name: e.student.name })}
      description={t('changeTeacherBody')}
      confirmLabel={ack.length ? t('confirmAnyway') : t('save')}
      busy={save.isPending}
      error={error}
      extra={
        <>
          <Field>
            <FieldLabel htmlFor="new-teacher">{t('fields.newTeacher')}</FieldLabel>
            <Combobox
              id="new-teacher"
              value={teacherId}
              onChange={(v) => {
                setAck([]);
                setError(null);
                setTeacherId(v);
              }}
              options={(teachers.data?.data ?? [])
                .filter((x) => x.id !== e.teacher.id)
                .map((x) => ({
                  value: String(x.id),
                  label: `${x.name} · ${cityOf(x.timezone, locale)}`,
                }))}
              placeholder={t('chooseTeacher')}
              searchPlaceholder={t('searchTeacher')}
              loading={teachers.isPending}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="teacher-from">{t('effectiveFrom')}</FieldLabel>
            <DatePicker
              id="teacher-from"
              value={from}
              onChange={setFrom}
              min={dateKeyIn(e.timezone)}
            />
            <FieldDescription>{t('effectiveFromHelp')}</FieldDescription>
          </Field>
        </>
      }
      onConfirm={() => {
        if (!teacherId) {
          setError(t('chooseTeacher'));
          return;
        }
        save.mutate();
      }}
    />
  );
}

function MeetingDialog({
  enrollment: e,
  onClose,
}: {
  enrollment: EnrollmentDetailDto;
  onClose: () => void;
}) {
  const t = useTranslations('schedule');
  const locale = useUiLocale();
  const queryClient = useQueryClient();
  const message = useClassError();
  const [mode, setMode] = useState<MeetingMode>(e.meetingMode);
  const [url, setUrl] = useState(e.externalMeetingUrl ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      updateEnrollment(e.id, {
        meetingMode: mode,
        externalMeetingUrl: mode === 'external' ? url.trim() : null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scheduleKeys.all });
      onClose();
      toast.success(t('done.meeting'));
    },
    onError: (err) => setError(isApiError(err, 422) ? t('urlInvalid') : message(err)),
  });
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('meetingTitle')}
      description={t('meetingBody')}
      confirmLabel={t('save')}
      busy={save.isPending}
      error={error}
      extra={
        <>
          <Field>
            <FieldLabel>{t('fields.meetingMode')}</FieldLabel>
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as MeetingMode)}>
              {(['zoom', 'external'] as const).map((m) => (
                <Field key={m} orientation="horizontal">
                  <RadioGroupItem value={m} id={`meeting-${m}`} />
                  <FieldLabel htmlFor={`meeting-${m}`} className="font-normal">
                    {MEETING_MODE_LABELS[m][locale]}
                  </FieldLabel>
                </Field>
              ))}
            </RadioGroup>
          </Field>
          {mode === 'external' && (
            <Field>
              <FieldLabel htmlFor="meeting-url">{t('fields.meetingUrl')}</FieldLabel>
              <Input
                id="meeting-url"
                type="url"
                dir="ltr"
                className="h-10"
                placeholder="https://"
                value={url}
                onChange={(ev) => setUrl(ev.target.value)}
              />
              <FieldDescription>{t('urlHelp')}</FieldDescription>
            </Field>
          )}
        </>
      }
      onConfirm={() => {
        if (mode === 'external' && !/^https:\/\/\S+\.\S+/.test(url.trim())) {
          setError(t('urlInvalid'));
          return;
        }
        save.mutate();
      }}
    />
  );
}
