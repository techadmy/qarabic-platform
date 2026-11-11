'use client';

import {
  ENROLLMENT_KIND_LABELS,
  MEETING_MODE_LABELS,
  type ConflictResultDto,
  type EnrollmentKind,
  type MeetingMode,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Badge } from '@qarabic/ui/components/badge';
import { Button } from '@qarabic/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { cn } from '@qarabic/ui/lib/utils';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, PlusIcon, Trash2Icon, UserSearchIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Combobox } from '@/components/forms/fields';
import { DatePicker, TimeSelect } from '@/components/forms/date-time';
import { PageHeader } from '@/components/page-header';
import { TeacherSide } from '@/components/schedule/teacher-side';
import { canSave, ConflictList } from '@/components/sessions/conflict-list';
import { DURATIONS } from '@/components/sessions/reschedule-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ForbiddenState } from '@/components/states';
import { fetchPeopleList, fetchPerson } from '@/lib/api/people';
import { checkSchedule, createEnrollment, fetchTimetable, scheduleKeys } from '@/lib/api/schedule';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { peopleKeys } from '@/lib/people/use-person-actions';
import { refreshClasses } from '@/lib/sessions/cache';
import { conflictsOf, useClassError } from '@/lib/sessions/errors';
import { dateKeyIn, otherSideOf, STAFF_WEEK, wallTime, weekdayName } from '@/lib/schedule-time';
import { cityOf, formatDate } from '@/lib/time';

type DraftSlot = { weekday: number; localStartTime: string; durationMinutes: number };
const STEPS = ['who', 'times', 'review'] as const;

/**
 * «اشتراك جديد» (docs/15 §6.3; the current app's three-step `EnrollmentWizardPage`): 1) student,
 * course, teacher, kind, start date, length and meeting; 2) weekly times in the family's zone with
 * the teacher's side, the teacher's busy times and a live conflict check per time; 3) review and
 * create. Prefilled from the availability search (`?studentId=&teacherId=&weekday=&time=`).
 */
export function NewEnrollmentView() {
  const t = useTranslations('schedule.new');
  const ts = useTranslations('schedule');
  const locale = useUiLocale();
  const viewerTz = useViewerTz();
  const me = useCurrentUser();
  const router = useRouter();
  const params = useListParams();
  const queryClient = useQueryClient();
  const message = useClassError();
  const [step, setStep] = useState(0);
  const [studentId, setStudentId] = useState<string | null>(params.get('studentId') || null);
  const [studentSearch, setStudentSearch] = useState('');
  const [teacherId, setTeacherId] = useState<string | null>(params.get('teacherId') || null);
  const [courseId, setCourseId] = useState<string | null>(params.get('courseId') || null);
  const [kind, setKind] = useState<EnrollmentKind>(
    params.get('kind') === 'trial' ? 'trial' : 'regular',
  );
  const [startsOn, setStartsOn] = useState(() => dateKeyIn(viewerTz));
  const [minutes, setMinutes] = useState(30);
  const [meeting, setMeeting] = useState<MeetingMode>('external');
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [slots, setSlots] = useState<DraftSlot[]>(() => {
    const wd = Number(params.get('weekday'));
    const time = params.get('time');
    return wd && time ? [{ weekday: wd, localStartTime: time, durationMinutes: 30 }] : [];
  });
  const [formDay, setFormDay] = useState(6);
  const [formTime, setFormTime] = useState('17:00');
  const [ack, setAck] = useState<string[]>([]);
  const [serverResult, setServerResult] = useState<ConflictResultDto | null>(null);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const students = useQuery({
    queryKey: peopleKeys.list('students', { q: studentSearch, status: 'active', perPage: 20 }),
    queryFn: ({ signal }) =>
      fetchPeopleList(
        'students',
        { q: studentSearch || undefined, status: 'active', perPage: 20 },
        signal,
      ),
  });
  const chosenStudent = useQuery({
    queryKey: peopleKeys.detail('students', Number(studentId)),
    queryFn: ({ signal }) => fetchPerson('students', Number(studentId), signal),
    enabled: !!studentId,
  });
  const teachers = useQuery({
    queryKey: peopleKeys.list('teachers', { status: 'active', perPage: 100 }),
    queryFn: ({ signal }) =>
      fetchPeopleList('teachers', { status: 'active', perPage: 100 }, signal),
  });
  const teacher = teachers.data?.data.find((x) => String(x.id) === teacherId);
  const student = chosenStudent.data;
  const familyTz = student?.family.timezone ?? viewerTz;
  const courses = useMemo(() => {
    const list = teacher ? teacher.courses : (teachers.data?.data ?? []).flatMap((x) => x.courses);
    return [...new Map(list.map((c) => [c.id, c])).values()];
  }, [teacher, teachers.data]);
  const timetable = useQuery({
    queryKey: scheduleKeys.timetable(Number(teacherId), {}),
    queryFn: ({ signal }) => fetchTimetable(Number(teacherId), {}, signal),
    enabled: !!teacherId && step >= 1,
  });
  const checks = useQueries({
    queries: slots.map((s) => {
      const input = {
        studentId: Number(studentId),
        teacherId: Number(teacherId),
        weekday: s.weekday,
        localStartTime: s.localStartTime,
        durationMinutes: s.durationMinutes,
        timezone: familyTz,
        validFrom: startsOn,
      };
      return {
        queryKey: scheduleKeys.check(input),
        queryFn: ({ signal }: { signal: AbortSignal }) => checkSchedule(input, signal),
        enabled: !!studentId && !!teacherId && !!student,
      };
    }),
  });
  const combined: ConflictResultDto | undefined =
    serverResult ??
    (slots.length && checks.every((c) => c.data)
      ? {
          conflicts: checks.flatMap((c) => c.data!.conflicts),
          warnings: checks
            .flatMap((c) => c.data!.warnings)
            .filter((w, i, all) => all.findIndex((x) => x.code === w.code) === i),
        }
      : undefined);
  const checking = checks.some((c) => c.isFetching);

  const create = useMutation({
    mutationFn: () =>
      createEnrollment({
        studentId: Number(studentId),
        courseId: Number(courseId),
        teacherId: Number(teacherId),
        kind,
        startsOn,
        sessionMinutes: minutes,
        meetingMode: meeting,
        externalMeetingUrl: meeting === 'external' ? url.trim() : null,
        notes: notes.trim() || null,
        slots,
        acknowledgeWarnings: ack,
      }),
    onSuccess: (e) => {
      refreshClasses(queryClient);
      toast.success(t('created'));
      router.push(`/schedule/${e.id}`);
    },
    onError: (err) => {
      const conflicts = conflictsOf(err);
      if (conflicts) {
        setServerResult(conflicts);
        setStep(1);
      } else setError(message(err));
    },
  });

  if (!can(me, 'schedule.manage')) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }

  const urlOk = meeting === 'zoom' || /^https:\/\/\S+\.\S+/.test(url.trim());
  const step1Valid = !!studentId && !!courseId && !!teacherId && !!startsOn && urlOk;
  const step2Valid = slots.length > 0 && !checking && canSave(combined, ack);
  const next = () => {
    setTouched(true);
    setError(null);
    if (step === 0 && !step1Valid) return;
    if (step === 1 && !step2Valid) return;
    setTouched(false);
    setStep((s) => Math.min(2, s + 1));
  };
  const addSlot = () => {
    setServerResult(null);
    setSlots((prev) =>
      prev.some((p) => p.weekday === formDay && p.localStartTime === formTime)
        ? prev
        : [...prev, { weekday: formDay, localStartTime: formTime, durationMinutes: minutes }],
    );
  };
  const req = (
    <span aria-hidden className="text-destructive">
      *
    </span>
  );
  const studentOptions = [
    ...(student && !students.data?.data.some((s) => s.id === student.id)
      ? [{ value: String(student.id), label: student.name }]
      : []),
    ...(students.data?.data ?? []).map((s) => ({
      value: String(s.id),
      label: s.name,
      hint: cityOf(s.family.timezone, 'en'),
    })),
  ];

  return (
    <>
      <PageHeader back={{ href: '/schedule', label: ts('back') }} title={t('title')} />
      <ol className="flex flex-wrap items-center gap-x-6 gap-y-2" aria-label={t('steps')}>
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === step ? 'step' : undefined}
            className={cn(
              'flex items-center gap-2 text-sm',
              i === step ? 'font-bold' : 'text-muted-foreground',
            )}
          >
            <Badge
              variant={i <= step ? 'default' : 'outline'}
              className="size-7 justify-center rounded-full p-0 text-sm tabular-nums"
            >
              {i + 1}
            </Badge>
            {t(`step.${s}`)}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card className="shadow-none">
          <CardContent>
            <FieldGroup className="max-w-2xl">
              <Field data-invalid={touched && !studentId}>
                <FieldLabel htmlFor="new-student">
                  {t('student')}
                  {req}
                </FieldLabel>
                <Combobox
                  id="new-student"
                  value={studentId}
                  onChange={(v) => {
                    setStudentId(v);
                    setServerResult(null);
                  }}
                  options={studentOptions}
                  placeholder={t('chooseStudent')}
                  searchPlaceholder={t('searchStudent')}
                  shouldFilter={false}
                  onSearch={setStudentSearch}
                  loading={students.isFetching}
                  invalid={touched && !studentId}
                />
                {student && (
                  <FieldDescription>
                    {t('familyZone', { city: cityOf(student.family.timezone, locale) })}
                  </FieldDescription>
                )}
                {touched && !studentId && <FieldError>{t('required')}</FieldError>}
              </Field>
              <Field data-invalid={touched && !teacherId}>
                <FieldLabel htmlFor="new-teacher">
                  {t('teacher')}
                  {req}
                </FieldLabel>
                <Combobox
                  id="new-teacher"
                  value={teacherId}
                  onChange={(v) => {
                    setTeacherId(v);
                    setServerResult(null);
                  }}
                  options={(teachers.data?.data ?? []).map((x) => ({
                    value: String(x.id),
                    label: x.name,
                    hint: cityOf(x.timezone, 'en'),
                  }))}
                  placeholder={t('chooseTeacher')}
                  searchPlaceholder={t('searchTeacher')}
                  loading={teachers.isPending}
                  invalid={touched && !teacherId}
                />
                <FieldDescription>
                  <Link
                    href="/schedule/availability"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    <UserSearchIcon className="size-4" />
                    {ts('availability')}
                  </Link>
                </FieldDescription>
                {touched && !teacherId && <FieldError>{t('required')}</FieldError>}
              </Field>
              <Field data-invalid={touched && !courseId}>
                <FieldLabel htmlFor="new-course">
                  {t('course')}
                  {req}
                </FieldLabel>
                <Select value={courseId ?? ''} onValueChange={setCourseId}>
                  <SelectTrigger
                    id="new-course"
                    className="h-10! w-full"
                    aria-invalid={touched && !courseId}
                  >
                    <SelectValue placeholder={t('chooseCourse')} />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {courses.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {locale === 'ar' ? c.nameAr : c.nameEn}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {touched && !courseId && <FieldError>{t('required')}</FieldError>}
              </Field>
              <FieldSet>
                <FieldLegend variant="label">{t('kind')}</FieldLegend>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  spacing={0}
                  value={kind}
                  onValueChange={(v) => v && setKind(v as EnrollmentKind)}
                  className="bg-card"
                >
                  {(['regular', 'trial'] as const).map((k) => (
                    <ToggleGroupItem
                      key={k}
                      value={k}
                      className="h-9 px-4 data-[state=on]:bg-accent data-[state=on]:font-semibold data-[state=on]:text-accent-foreground"
                    >
                      {ENROLLMENT_KIND_LABELS[k][locale]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </FieldSet>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="new-starts">
                    {t('startsOn')}
                    {req}
                  </FieldLabel>
                  <DatePicker
                    id="new-starts"
                    value={startsOn}
                    onChange={setStartsOn}
                    min={dateKeyIn(viewerTz)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-minutes">{t('minutes')}</FieldLabel>
                  <Select value={String(minutes)} onValueChange={(v) => setMinutes(Number(v))}>
                    <SelectTrigger id="new-minutes" className="h-10! w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {DURATIONS.map((m) => (
                        <SelectItem key={m} value={String(m)}>
                          {ts('minutes', { count: m })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="new-meeting">{t('meeting')}</FieldLabel>
                <Select value={meeting} onValueChange={(v) => setMeeting(v as MeetingMode)}>
                  <SelectTrigger id="new-meeting" className="h-10! w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {(['external', 'zoom'] as const).map((m) => (
                      <SelectItem key={m} value={m}>
                        {MEETING_MODE_LABELS[m][locale]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {meeting === 'external' && (
                <Field data-invalid={touched && !urlOk}>
                  <FieldLabel htmlFor="new-url">
                    {t('url')}
                    {req}
                  </FieldLabel>
                  <Input
                    id="new-url"
                    type="url"
                    dir="ltr"
                    className="h-10"
                    placeholder="https://"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    aria-invalid={touched && !urlOk}
                  />
                  <FieldDescription>{ts('urlHelp')}</FieldDescription>
                  {touched && !urlOk && <FieldError>{ts('urlInvalid')}</FieldError>}
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="new-notes">
                  {t('notes')}{' '}
                  <span className="font-normal text-muted-foreground">({t('optional')})</span>
                </FieldLabel>
                <Textarea
                  id="new-notes"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>
      )}

      {step === 1 && (
        <div className="grid items-start gap-4 lg:grid-cols-[1fr_20rem]">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base font-bold">{t('timesTitle')}</CardTitle>
              <CardDescription>
                {t('timesHint', { city: cityOf(familyTz, locale) })}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end gap-3">
                <Field className="w-40">
                  <FieldLabel htmlFor="draft-day">{ts('slot.day')}</FieldLabel>
                  <Select value={String(formDay)} onValueChange={(v) => setFormDay(Number(v))}>
                    <SelectTrigger id="draft-day" className="h-10! w-full">
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
                <Field className="w-40">
                  <FieldLabel htmlFor="draft-time">
                    {ts('slot.time', { city: cityOf(familyTz, locale) })}
                  </FieldLabel>
                  <TimeSelect id="draft-time" value={formTime} onChange={setFormTime} />
                </Field>
                <Button variant="outline" className="h-10" onClick={addSlot}>
                  <PlusIcon />
                  {t('addTime')}
                </Button>
              </div>
              {slots.length === 0 ? (
                <p className="text-muted-foreground">{t('noTimes')}</p>
              ) : (
                <ul className="divide-y rounded-lg border" aria-label={t('timesTitle')}>
                  {slots.map((s, i) => {
                    const c = checks[i];
                    const hard = c?.data?.conflicts.length;
                    return (
                      <li
                        key={`${s.weekday}-${s.localStartTime}`}
                        className="flex items-center justify-between gap-3 px-3 py-2"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="font-semibold">
                            {weekdayName(s.weekday, locale)}{' '}
                            <bdi>{wallTime(s.localStartTime, locale)}</bdi> ·{' '}
                            {ts('minutes', { count: s.durationMinutes })}
                          </span>
                          {teacher && (
                            <TeacherSide
                              slot={{ ...s, timezone: familyTz }}
                              teacher={teacher}
                              from={startsOn}
                            />
                          )}
                          <span
                            className={cn(
                              'text-sm',
                              hard ? 'text-destructive' : 'text-muted-foreground',
                            )}
                          >
                            {c?.isFetching
                              ? t('checking')
                              : hard
                                ? t('slotConflict')
                                : c?.data?.warnings.length
                                  ? t('slotWarning')
                                  : c?.data
                                    ? t('slotFree')
                                    : ''}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('removeTime', {
                            slot: `${weekdayName(s.weekday, locale)} ${wallTime(s.localStartTime, locale)}`,
                          })}
                          onClick={() => {
                            setServerResult(null);
                            setSlots((prev) => prev.filter((_, j) => j !== i));
                          }}
                        >
                          <Trash2Icon />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {slots.length > 0 && (
                <ConflictList
                  result={combined}
                  checking={checking}
                  acknowledged={ack}
                  onAcknowledge={setAck}
                />
              )}
              {touched && slots.length === 0 && (
                <p className="text-sm text-destructive">{t('needTime')}</p>
              )}
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base font-bold">{t('busyTitle')}</CardTitle>
              <CardDescription>{t('busyHint', { city: cityOf(familyTz, locale) })}</CardDescription>
            </CardHeader>
            <CardContent>
              {timetable.isPending ? (
                <Spinner />
              ) : !timetable.data?.slots.length ? (
                <p className="text-muted-foreground">{t('busyNone')}</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {[...timetable.data.slots]
                    .map((s) => ({ s, side: otherSideOf(s, familyTz, startsOn) }))
                    .sort(
                      (a, b) =>
                        STAFF_WEEK.indexOf(a.side.weekday as never) -
                          STAFF_WEEK.indexOf(b.side.weekday as never) ||
                        a.side.time.localeCompare(b.side.time),
                    )
                    .map(({ s, side }) => (
                      <li key={s.id} className="flex justify-between gap-2">
                        <span>
                          {weekdayName(side.weekday, locale)}{' '}
                          <bdi>{wallTime(side.time, locale)}</bdi>
                        </span>
                        <span className="truncate text-muted-foreground">{s.label}</span>
                      </li>
                    ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {step === 2 && (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base font-bold">{t('reviewTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted-foreground">{t('student')}</dt>
              <dd>
                {student?.name} ({cityOf(familyTz, locale)})
              </dd>
              <dt className="text-muted-foreground">{t('teacher')}</dt>
              <dd>{teacher?.name}</dd>
              <dt className="text-muted-foreground">{t('course')}</dt>
              <dd>
                {
                  courses.find((c) => String(c.id) === courseId)?.[
                    locale === 'ar' ? 'nameAr' : 'nameEn'
                  ]
                }
              </dd>
              <dt className="text-muted-foreground">{t('kind')}</dt>
              <dd>
                {ENROLLMENT_KIND_LABELS[kind][locale]} · {ts('minutes', { count: minutes })}
              </dd>
              <dt className="text-muted-foreground">{t('startsOn')}</dt>
              <dd>{formatDate(startsOn, locale)}</dd>
              <dt className="text-muted-foreground">{t('meeting')}</dt>
              <dd>
                {MEETING_MODE_LABELS[meeting][locale]}
                {meeting === 'external' && (
                  <>
                    {' '}
                    ·{' '}
                    <bdi dir="ltr" className="break-all">
                      {url}
                    </bdi>
                  </>
                )}
              </dd>
              <dt className="text-muted-foreground">{t('timesTitle')}</dt>
              <dd>
                <ul>
                  {slots.map((s) => (
                    <li key={`${s.weekday}-${s.localStartTime}`}>
                      {weekdayName(s.weekday, locale)}{' '}
                      <bdi>{wallTime(s.localStartTime, locale)}</bdi> ({cityOf(familyTz, locale)})
                    </li>
                  ))}
                </ul>
              </dd>
            </dl>
          </CardContent>
        </Card>
      )}

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-between gap-2">
        <Button
          variant="outline"
          className="h-10"
          disabled={step === 0}
          onClick={() => setStep((s) => s - 1)}
        >
          {t('previous')}
        </Button>
        {step < 2 ? (
          <Button className="h-10 px-6" onClick={next}>
            {t('next')}
          </Button>
        ) : (
          <Button className="h-10 px-6" disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending && <Spinner />}
            {t('create')}
          </Button>
        )}
      </div>
    </>
  );
}
