'use client';

import { HIFZ_TYPE_LABELS, TEACHER_PORTAL_LABELS, type TeacherStudentDto } from '@qarabic/shared';
import { Card } from '@qarabic/ui/components/card';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { GraduationCapIcon, SearchXIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo } from 'react';
import { ListToolbar } from '@/components/list/list-toolbar';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { ToneBadge } from '@/components/sessions/badges';
import { SessionSheet, useOpenSession } from '@/components/sessions/session-sheet';
import { OtherTime, useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchTeacherStudents, teachingKeys } from '@/lib/api/teaching';
import { useListParams } from '@/lib/list-params';
import { rangeText, shortLabel } from '@/lib/reports/format';
import { dayAndClock, relativeTime } from '@/lib/schedule-time';

/**
 * «طلابي» (teacher portal, D71/D138): `GET /teacher-portal/students` — the teacher's own students
 * without contact or family data: courses, the next class (both times), the last report, classes
 * still without a report, and where each stands in hifz. The name opens the student's profile
 * (progress and tests); the next class opens in the sheet.
 */
export function MyStudentsView() {
  const t = useTranslations('teacherPortal.students');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const now = useNow(60_000);
  const params = useListParams();
  const { open } = useOpenSession();
  const query = useQuery({
    queryKey: teachingKeys.myStudents,
    queryFn: ({ signal }) => fetchTeacherStudents(signal),
  });
  const q = params.searchInput.trim().toLowerCase();
  const rows = useMemo(
    () => (query.data ?? []).filter((s) => !q || s.name.toLowerCase().includes(q)),
    [query.data, q],
  );
  const columns = useMemo<ColumnDef<TeacherStudentDto, unknown>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        cell: ({ row: { original: s } }) => (
          <span className="flex flex-col">
            <Link href={`/students/${s.id}`} className="font-semibold text-primary hover:underline">
              {s.name}
            </Link>
            {s.age !== null && (
              <span className="text-xs text-muted-foreground">{t('age', { count: s.age })}</span>
            )}
          </span>
        ),
      },
      {
        id: 'course',
        header: t('columns.course'),
        cell: ({ row: { original: s } }) =>
          s.enrollments
            .map((e) => (locale === 'ar' ? e.course.nameAr : e.course.nameEn))
            .join('، ') || '—',
      },
      {
        id: 'next',
        header: TEACHER_PORTAL_LABELS.nextClass[locale],
        cell: ({ row: { original: s } }) =>
          s.nextSession ? (
            <span className="flex flex-col">
              <button
                type="button"
                onClick={() => open(s.nextSession!.id)}
                className="self-start text-start font-medium hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
              >
                <bdi>{dayAndClock(s.nextSession.startsAt, tz, locale)}</bdi>
              </button>
              {s.timezone !== tz && (
                <OtherTime at={s.nextSession.startsAt} tz={s.timezone} party="student" />
              )}
            </span>
          ) : (
            '—'
          ),
      },
      {
        id: 'position',
        header: t('columns.position'),
        cell: ({ row: { original: s } }) => <Positions student={s} />,
      },
      {
        id: 'report',
        header: TEACHER_PORTAL_LABELS.lastReport[locale],
        cell: ({ row: { original: s } }) => (
          <span className="flex flex-col items-start gap-1">
            <span className="text-sm">
              {s.lastReport ? relativeTime(s.lastReport.submittedAt, now, locale) : '—'}
            </span>
            {s.reportsMissing > 0 && (
              <ToneBadge tone="orange" label={t('missing', { count: s.reportsMissing })} />
            )}
          </span>
        ),
      },
    ],
    [t, locale, tz, now, open],
  );

  if (isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t('title')}
        meta={query.data ? t('count', { count: query.data.length }) : undefined}
      />
      <Card className="gap-0 py-0 shadow-none">
        <ListToolbar
          search={{
            label: t('search'),
            placeholder: t('searchPlaceholder'),
            value: params.searchInput,
            onChange: params.setSearchInput,
          }}
        />
        {query.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void query.refetch()} />
          </div>
        ) : query.data && query.data.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={GraduationCapIcon} title={t('empty')} description={t('emptyHint')} />
          </div>
        ) : query.data && rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={SearchXIcon}
              role="status"
              title={t('noResults')}
              description={t('noResultsHint')}
            />
          </div>
        ) : (
          <ResponsiveList
            columns={columns}
            rows={rows}
            loading={query.isPending}
            label={t('title')}
            emptyText={t('empty')}
            getRowId={(s) => s.id}
            getRowHref={(s) => `/students/${s.id}`}
            renderCard={(s) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold text-primary">{s.name}</span>
                  {s.reportsMissing > 0 && (
                    <ToneBadge tone="orange" label={t('missing', { count: s.reportsMissing })} />
                  )}
                </div>
                <span className="text-sm text-muted-foreground">
                  {s.enrollments
                    .map((e) => (locale === 'ar' ? e.course.nameAr : e.course.nameEn))
                    .join('، ')}
                </span>
                {s.nextSession && (
                  <span className="text-sm">
                    {TEACHER_PORTAL_LABELS.nextClass[locale]}:{' '}
                    <bdi className="font-medium">
                      {dayAndClock(s.nextSession.startsAt, tz, locale)}
                    </bdi>
                  </span>
                )}
                <Positions student={s} />
              </div>
            )}
          />
        )}
      </Card>
      <SessionSheet />
    </>
  );
}

function Positions({ student: s }: { student: TeacherStudentDto }) {
  const locale = useUiLocale();
  if (!s.lastPositions.length) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <span className="flex flex-col text-sm">
      {s.lastPositions.map((p) => (
        <span key={p.type}>
          <span className="text-muted-foreground">
            {shortLabel(HIFZ_TYPE_LABELS[p.type][locale])}:
          </span>{' '}
          <bdi>{rangeText(p, locale)}</bdi>
        </span>
      ))}
    </span>
  );
}
