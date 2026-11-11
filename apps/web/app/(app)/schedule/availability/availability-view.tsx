'use client';

import { GENDER_LABELS, type AvailabilityQuery } from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import { Field, FieldGroup, FieldLabel } from '@qarabic/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { useQuery } from '@tanstack/react-query';
import { InfoIcon, SearchIcon, SearchXIcon, SunMoonIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useState, type FormEvent } from 'react';
import { Combobox } from '@/components/forms/fields';
import { TimeSelect } from '@/components/forms/date-time';
import { PageHeader } from '@/components/page-header';
import { DURATIONS } from '@/components/sessions/reschedule-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { fetchPeopleList } from '@/lib/api/people';
import { fetchAvailability, scheduleKeys } from '@/lib/api/schedule';
import { can } from '@/lib/auth/use-me';
import { peopleKeys } from '@/lib/people/use-person-actions';
import { STAFF_WEEK, wallTime, weekdayName } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';

/**
 * «ابحث عن معلم متاح» (docs/15 §3.1 K9, §6.4; the current app's `AvailabilityPage`): days, a time
 * window in the student's zone, length, course and gender in one form; teachers ranked by matching
 * days, each free time a link to a new enrollment prefilled with it. Teachers without work hours
 * are listed apart; the nearest free time is suggested when nothing matches.
 */
export function AvailabilityView() {
  const t = useTranslations('schedule.availabilityPage');
  const ts = useTranslations('schedule');
  const locale = useUiLocale();
  const viewerTz = useViewerTz();
  const me = useCurrentUser();
  const [studentId, setStudentId] = useState<string | null>(null);
  const [studentSearch, setStudentSearch] = useState('');
  const [weekdays, setWeekdays] = useState<string[]>(['6', '1', '3']);
  const [fromTime, setFromTime] = useState('16:00');
  const [toTime, setToTime] = useState('21:00');
  const [duration, setDuration] = useState(30);
  const [courseId, setCourseId] = useState('');
  const [gender, setGender] = useState('');
  const [submitted, setSubmitted] = useState<AvailabilityQuery | null>(null);
  const students = useQuery({
    queryKey: peopleKeys.list('students', { q: studentSearch, status: 'active', perPage: 20 }),
    queryFn: ({ signal }) =>
      fetchPeopleList(
        'students',
        { q: studentSearch || undefined, status: 'active', perPage: 20 },
        signal,
      ),
  });
  const teachers = useQuery({
    queryKey: peopleKeys.list('teachers', { status: 'active', perPage: 100 }),
    queryFn: ({ signal }) =>
      fetchPeopleList('teachers', { status: 'active', perPage: 100 }, signal),
  });
  const courses = useMemo(
    () => [
      ...new Map(
        (teachers.data?.data ?? []).flatMap((x) => x.courses).map((c) => [c.id, c]),
      ).values(),
    ],
    [teachers.data],
  );
  const result = useQuery({
    queryKey: scheduleKeys.availability(submitted),
    queryFn: ({ signal }) => fetchAvailability(submitted!, signal),
    enabled: !!submitted,
  });
  if (!can(me, 'schedule.view')) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const student = students.data?.data.find((s) => String(s.id) === studentId);
  const zone = student?.family.timezone ?? viewerTz;
  const invalid = !weekdays.length || toTime <= fromTime;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid) return;
    setSubmitted({
      ...(studentId ? { studentId: Number(studentId) } : { timezone: zone }),
      weekdays: weekdays.map(Number),
      fromTime,
      toTime,
      durationMinutes: duration,
      ...(courseId ? { courseId: Number(courseId) } : {}),
      ...(gender ? { gender: gender as 'male' | 'female' } : {}),
    });
  }
  const prefill = (teacherId: number, weekday: number, time: string) => {
    const q = new URLSearchParams({ teacherId: String(teacherId), weekday: String(weekday), time });
    if (studentId) q.set('studentId', studentId);
    if (courseId) q.set('courseId', courseId);
    return `/schedule/new?${q}`;
  };

  return (
    <>
      <PageHeader
        back={{ href: '/schedule', label: ts('back') }}
        title={t('title')}
        description={t('description')}
      />
      <Card className="shadow-none">
        <CardContent>
          <form onSubmit={submit} noValidate>
            <FieldGroup>
              <div className="grid gap-4 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="avail-student">{t('student')}</FieldLabel>
                  <Combobox
                    id="avail-student"
                    value={studentId}
                    onChange={setStudentId}
                    options={(students.data?.data ?? []).map((s) => ({
                      value: String(s.id),
                      label: s.name,
                    }))}
                    placeholder={t('anyStudent')}
                    searchPlaceholder={t('searchStudent')}
                    shouldFilter={false}
                    onSearch={setStudentSearch}
                    loading={students.isFetching}
                    clearable
                  />
                </Field>
                <Field>
                  <FieldLabel>{t('zone')}</FieldLabel>
                  <p className="flex h-10 items-center text-muted-foreground">
                    {cityOf(zone, locale)}
                  </p>
                </Field>
              </div>
              <Field>
                <FieldLabel id="avail-days">{t('days')}</FieldLabel>
                <ToggleGroup
                  type="multiple"
                  variant="outline"
                  spacing={0}
                  aria-labelledby="avail-days"
                  value={weekdays}
                  onValueChange={setWeekdays}
                  className="flex-wrap bg-card"
                >
                  {STAFF_WEEK.map((d) => (
                    <ToggleGroupItem
                      key={d}
                      value={String(d)}
                      className="h-9 px-3 data-[state=on]:bg-accent data-[state=on]:font-semibold data-[state=on]:text-accent-foreground"
                    >
                      {weekdayName(d, locale)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <Field>
                  <FieldLabel htmlFor="avail-from">{t('from')}</FieldLabel>
                  <TimeSelect id="avail-from" value={fromTime} onChange={setFromTime} />
                </Field>
                <Field data-invalid={toTime <= fromTime}>
                  <FieldLabel htmlFor="avail-to">{t('to')}</FieldLabel>
                  <TimeSelect
                    id="avail-to"
                    value={toTime}
                    onChange={setToTime}
                    invalid={toTime <= fromTime}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="avail-duration">{t('duration')}</FieldLabel>
                  <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
                    <SelectTrigger id="avail-duration" className="h-10! w-full">
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
                <Field>
                  <FieldLabel htmlFor="avail-course">{t('course')}</FieldLabel>
                  <Select
                    value={courseId || 'any'}
                    onValueChange={(v) => setCourseId(v === 'any' ? '' : v)}
                  >
                    <SelectTrigger id="avail-course" className="h-10! w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value="any">{t('any')}</SelectItem>
                      {courses.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {locale === 'ar' ? c.nameAr : c.nameEn}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="avail-gender">{t('gender')}</FieldLabel>
                  <Select
                    value={gender || 'any'}
                    onValueChange={(v) => setGender(v === 'any' ? '' : v)}
                  >
                    <SelectTrigger id="avail-gender" className="h-10! w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value="any">{t('any')}</SelectItem>
                      {(['male', 'female'] as const).map((g) => (
                        <SelectItem key={g} value={g}>
                          {GENDER_LABELS[g][locale]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div>
                <Button type="submit" className="h-10 px-6" disabled={invalid}>
                  <SearchIcon />
                  {t('search')}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      {!submitted ? null : result.isPending ? (
        <div className="grid gap-3 md:grid-cols-2" aria-busy="true">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : result.isError ? (
        <ErrorState onRetry={() => void result.refetch()} />
      ) : (
        <>
          {result.data.workHoursNotSet.length > 0 && (
            <Alert>
              <InfoIcon />
              <AlertTitle>{t('noWorkHours')}</AlertTitle>
              <AlertDescription>
                <span className="flex flex-wrap gap-x-3">
                  {result.data.workHoursNotSet.map((x) => (
                    <Link
                      key={x.id}
                      href={`/teachers/${x.id}/timetable`}
                      className="text-primary hover:underline"
                    >
                      {x.name}
                    </Link>
                  ))}
                </span>
              </AlertDescription>
            </Alert>
          )}
          {result.data.teachers.length === 0 ? (
            <EmptyState
              icon={SearchXIcon}
              role="status"
              title={t('none')}
              description={
                result.data.nearest
                  ? t('nearest', {
                      day: weekdayName(result.data.nearest.weekday, locale),
                      time: wallTime(result.data.nearest.localStartTime, locale),
                    })
                  : t('noneHint')
              }
            />
          ) : (
            <section aria-label={t('results')} className="grid gap-3 md:grid-cols-2">
              {result.data.teachers.map((row) => (
                <Card key={row.teacher.id} className="gap-3 shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base font-bold">{row.teacher.name}</CardTitle>
                    <CardDescription>
                      {t('match', { days: row.matchingWeekdays, total: weekdays.length })} ·{' '}
                      {t('load', { hours: row.teacher.weeklyLoadHours })} ·{' '}
                      {cityOf(row.teacher.timezone, locale)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-2">
                    {STAFF_WEEK.filter((d) => row.free.some((f) => f.weekday === d)).map((d) => (
                      <div key={d} className="flex flex-wrap items-center gap-1.5">
                        <span className="w-20 shrink-0 text-sm font-semibold">
                          {weekdayName(d, locale)}
                        </span>
                        {row.free
                          .filter((f) => f.weekday === d)
                          .map((f) => (
                            <Button
                              key={f.localStartTime}
                              variant="outline"
                              size="sm"
                              asChild
                              title={`${t('teacherTime')}: ${weekdayName(f.teacherLocal.weekday, locale)} ${wallTime(f.teacherLocal.time, locale)}`}
                            >
                              <Link href={prefill(row.teacher.id, d, f.localStartTime)}>
                                <bdi>{wallTime(f.localStartTime, locale)}</bdi>
                                {f.dstNote && <SunMoonIcon aria-label={ts('dstNote')} />}
                              </Link>
                            </Button>
                          ))}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              ))}
            </section>
          )}
        </>
      )}
    </>
  );
}
