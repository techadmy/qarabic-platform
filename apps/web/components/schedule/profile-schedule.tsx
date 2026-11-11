'use client';

import type { EnrollmentDto } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { useQueries, useQuery } from '@tanstack/react-query';
import { CalendarPlusIcon, CalendarRangeIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useSlotsText } from '@/components/schedule/use-slots-text';
import { EnrollmentStatusBadge } from '@/components/sessions/badges';
import { ClassTable } from '@/components/sessions/class-table';
import { SessionSheet, useOpenSession } from '@/components/sessions/session-sheet';
import { useNow, useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { fetchEnrollments, scheduleKeys } from '@/lib/api/schedule';
import { fetchSessions, sessionKeys } from '@/lib/api/sessions';
import { can } from '@/lib/auth/use-me';
import { cityOf } from '@/lib/time';

const DAY = 86_400_000;

/**
 * The schedule sections of a profile (K6, profile = workbench): the enrollments with their weekly
 * times (each opens its page) and the next classes (each opens the class sheet). A student or a
 * teacher by id; a family by its children's ids.
 */
export function ProfileSchedule({
  studentId,
  teacherId,
  studentIds,
}: {
  studentId?: number;
  teacherId?: number;
  studentIds?: number[];
}) {
  const me = useCurrentUser();
  const visible = can(me, 'schedule.view') || can(me, 'sessions.conduct');
  if (!visible) return null;
  return (
    <>
      <Enrollments studentId={studentId} teacherId={teacherId} studentIds={studentIds} />
      {(studentId || teacherId) && can(me, 'sessions.view') && (
        <Upcoming studentId={studentId} teacherId={teacherId} />
      )}
      <SessionSheet />
    </>
  );
}

function Enrollments({
  studentId,
  teacherId,
  studentIds,
}: {
  studentId?: number;
  teacherId?: number;
  studentIds?: number[];
}) {
  const t = useTranslations('schedule.profile');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const slotsText = useSlotsText();
  const queries = (studentIds ?? [undefined]).map((id) => ({
    studentId: id ?? studentId,
    teacherId,
    perPage: 50,
  }));
  const results = useQueries({
    queries: queries.map((q) => ({
      queryKey: scheduleKeys.enrollments(q),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchEnrollments(q, signal),
      enabled: !studentIds || studentIds.length > 0,
    })),
  });
  const rows: EnrollmentDto[] = results.flatMap((r) => r.data?.data ?? []);
  const pending = results.some((r) => r.isPending) && (!studentIds || studentIds.length > 0);
  const staff = me.role?.kind !== 'teacher' && me.role?.kind !== 'parent';
  const newHref = studentId
    ? `/schedule/new?studentId=${studentId}`
    : teacherId
      ? `/schedule/new?teacherId=${teacherId}`
      : '/schedule/new';
  return (
    <Card className="gap-2 shadow-none lg:col-span-2">
      <CardHeader className="border-b">
        <CardTitle className="text-base font-bold">{t('enrollments')}</CardTitle>
        <CardAction className="flex gap-1">
          {teacherId && can(me, 'schedule.view') && staff && (
            <Button variant="ghost" size="sm" className="text-primary" asChild>
              <Link href={`/teachers/${teacherId}/timetable`}>
                <CalendarRangeIcon />
                {t('timetable')}
              </Link>
            </Button>
          )}
          {can(me, 'schedule.manage') && !studentIds && (
            <Button variant="ghost" size="sm" className="text-primary" asChild>
              <Link href={newHref}>
                <CalendarPlusIcon />
                {t('new')}
              </Link>
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent>
        {pending ? (
          <Skeleton className="h-16" />
        ) : rows.length === 0 ? (
          <p className="py-2 text-muted-foreground">{t('noEnrollments')}</p>
        ) : (
          <ul className="divide-y" aria-label={t('enrollments')}>
            {rows.map((e) => (
              <li
                key={e.id}
                className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="flex flex-col">
                  {staff ? (
                    <Link
                      href={`/schedule/${e.id}`}
                      className="font-semibold text-primary hover:underline"
                    >
                      {teacherId
                        ? e.student.name
                        : locale === 'ar'
                          ? e.course.nameAr
                          : e.course.nameEn}
                    </Link>
                  ) : (
                    <span className="font-semibold">
                      {studentIds || teacherId ? e.student.name : ''}{' '}
                      {locale === 'ar' ? e.course.nameAr : e.course.nameEn}
                    </span>
                  )}
                  <span className="text-sm text-muted-foreground">
                    {teacherId
                      ? locale === 'ar'
                        ? e.course.nameAr
                        : e.course.nameEn
                      : e.teacher.name}{' '}
                    · {slotsText(e) || '—'} ({cityOf(e.timezone, locale)})
                  </span>
                </span>
                <EnrollmentStatusBadge status={e.status} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Upcoming({ studentId, teacherId }: { studentId?: number; teacherId?: number }) {
  const t = useTranslations('schedule.profile');
  const now = useNow(60_000);
  const { open } = useOpenSession();
  // Two weeks ahead from the start of this hour (a stable key while the page is open).
  const [hour] = useState(() => Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const range = useMemo(() => {
    const from = hour;
    return {
      from: new Date(from).toISOString().replace('.000Z', 'Z'),
      to: new Date(from + 14 * DAY).toISOString().replace('.000Z', 'Z'),
      studentId,
      teacherId,
      perPage: 10,
    };
  }, [hour, studentId, teacherId]);
  const query = useQuery({
    queryKey: sessionKeys.list(range),
    queryFn: ({ signal }) => fetchSessions(range, signal),
  });
  const rows = query.data?.data ?? [];
  return (
    <section aria-labelledby="upcoming-classes" className="flex flex-col gap-2 lg:col-span-2">
      <h2 id="upcoming-classes" className="text-base font-bold">
        {t('upcoming')}
      </h2>
      {!query.isPending && rows.length === 0 ? (
        <p className="text-muted-foreground">{t('noUpcoming')}</p>
      ) : (
        <Card className="gap-0 py-0 shadow-none">
          <ClassTable
            rows={rows}
            loading={query.isPending}
            now={now}
            onOpen={(s) => open(s.id)}
            label={t('upcoming')}
            showDate
            hideTeacher={!!teacherId}
          />
        </Card>
      )}
    </section>
  );
}
