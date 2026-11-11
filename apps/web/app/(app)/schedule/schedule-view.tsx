'use client';

import {
  ENROLLMENT_KIND_LABELS,
  ENROLLMENT_STATUS_LABELS,
  ENROLLMENT_STATUSES,
  type EnrollmentDto,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { CalendarPlusIcon, CalendarRangeIcon, SearchXIcon, UserSearchIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ListPagination } from '@/components/list/list-pagination';
import { ClearFiltersButton, ListToolbar, StatusTabs } from '@/components/list/list-toolbar';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { Highlight, RecordCell } from '@/components/people/people-list';
import { useSlotsText } from '@/components/schedule/use-slots-text';
import { EnrollmentStatusBadge } from '@/components/sessions/badges';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchEnrollments, scheduleKeys } from '@/lib/api/schedule';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { cityOf } from '@/lib/time';

/**
 * «الجدول» — enrollments (student × course × teacher) with their weekly times (docs/15 §6.3; the
 * current app's `EnrollmentsPage`): the list standard of N1 — header with the count, «ابحث عن
 * معلم متاح» and the one primary «اشتراك جديد», search, status tabs with counts, the table or
 * phone cards, server pagination. State in the URL.
 */
export function ScheduleView() {
  const t = useTranslations('schedule');
  const tl = useTranslations('list');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const slotsText = useSlotsText();
  const status = params.get('status');
  const allowed = can(me, 'schedule.view') || can(me, 'sessions.conduct');
  const canManage = can(me, 'schedule.manage');
  const query = {
    q: params.q || undefined,
    status: (ENROLLMENT_STATUSES as readonly string[]).includes(status)
      ? (status as EnrollmentDto['status'])
      : undefined,
    teacherId: Number(params.get('teacherId')) || undefined,
    studentId: Number(params.get('studentId')) || undefined,
    page: params.page,
    perPage: params.perPage,
  };
  const list = useQuery({
    queryKey: scheduleKeys.enrollments(query),
    queryFn: ({ signal }) => fetchEnrollments(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const meta = list.data?.meta;
  const rows = list.data?.data ?? [];
  const filtered = !!params.q || !!status || !!query.teacherId || !!query.studentId;
  const course = (e: EnrollmentDto) => (locale === 'ar' ? e.course.nameAr : e.course.nameEn);
  const href = (e: EnrollmentDto) => `/schedule/${e.id}`;

  const columns: ColumnDef<EnrollmentDto, unknown>[] = [
    {
      id: 'student',
      header: t('columns.student'),
      cell: ({ row }) => (
        <RecordCell
          href={href(row.original)}
          name={<Highlight text={row.original.student.name} query={params.q} />}
          secondary={cityOf(row.original.timezone, locale)}
        />
      ),
    },
    { id: 'course', header: t('columns.course'), cell: ({ row }) => course(row.original) },
    {
      id: 'teacher',
      header: t('columns.teacher'),
      cell: ({ row }) => <Highlight text={row.original.teacher.name} query={params.q} />,
    },
    {
      id: 'slots',
      header: t('columns.slots'),
      cell: ({ row }) =>
        slotsText(row.original) || <span className="text-muted-foreground">—</span>,
      meta: { className: 'max-w-80 whitespace-normal' },
    },
    {
      id: 'kind',
      header: t('columns.kind'),
      cell: ({ row }) => ENROLLMENT_KIND_LABELS[row.original.kind][locale],
    },
    {
      id: 'status',
      header: t('columns.status'),
      cell: ({ row }) => <EnrollmentStatusBadge status={row.original.status} />,
    },
  ];

  let body: ReactNode;
  if (list.isError) {
    body = (
      <div className="p-4">
        <ErrorState onRetry={() => void list.refetch()} />
      </div>
    );
  } else if (!list.isPending && rows.length === 0 && !filtered) {
    body = (
      <div className="p-4">
        <EmptyState
          icon={CalendarRangeIcon}
          title={t('empty')}
          description={t('emptyHint')}
          action={
            canManage ? (
              <Button asChild>
                <Link href="/schedule/new">
                  <CalendarPlusIcon />
                  {t('newEnrollment')}
                </Link>
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  } else if (!list.isPending && rows.length === 0) {
    body = (
      <div className="p-4">
        <EmptyState
          icon={SearchXIcon}
          role="status"
          title={params.q ? tl('noResultsFor', { q: params.q }) : tl('noResults')}
          description={tl('noResultsHint')}
          action={<ClearFiltersButton onClick={() => params.clear(['teacherId', 'studentId'])} />}
        />
      </div>
    );
  } else {
    body = (
      <ResponsiveList
        columns={columns}
        rows={rows}
        loading={list.isPending}
        label={t('tableLabel')}
        emptyText={tl('noResults')}
        getRowId={(e) => e.id}
        getRowHref={href}
        renderCard={(e) => (
          <div className="flex flex-col gap-1">
            <div className="flex items-start justify-between gap-2">
              <span className="font-semibold text-primary">{e.student.name}</span>
              <EnrollmentStatusBadge status={e.status} />
            </div>
            <span className="text-sm">
              {course(e)} · {e.teacher.name}
            </span>
            <span className="text-sm text-muted-foreground">
              {slotsText(e) || '—'} ({cityOf(e.timezone, locale)})
            </span>
          </div>
        )}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={t('title')}
        meta={meta ? tl('results', { count: meta.total }) : t('description')}
        actions={
          canManage ? (
            <>
              <Button variant="outline" className="h-10" asChild>
                <Link href="/schedule/availability">
                  <UserSearchIcon />
                  {t('availability')}
                </Link>
              </Button>
              <Button className="h-10 px-4" asChild>
                <Link href="/schedule/new">
                  <CalendarPlusIcon />
                  {t('newEnrollment')}
                </Link>
              </Button>
            </>
          ) : undefined
        }
      />
      <Card className="gap-0 py-0 shadow-none">
        <ListToolbar
          search={{
            label: t('search'),
            placeholder: t('searchHint'),
            value: params.searchInput,
            onChange: params.setSearchInput,
          }}
          filters={
            filtered ? (
              <ClearFiltersButton onClick={() => params.clear(['teacherId', 'studentId'])} />
            ) : undefined
          }
          tabs={
            <StatusTabs
              label={tl('statusFilter')}
              value={status}
              onChange={(v) => params.set({ status: v || null })}
              options={[
                { value: '', label: tl('all'), count: meta?.counts.all },
                ...ENROLLMENT_STATUSES.map((s) => ({
                  value: s,
                  label: ENROLLMENT_STATUS_LABELS[s][locale],
                  count: meta?.counts[s],
                })),
              ]}
            />
          }
        />
        {body}
        {meta && rows.length > 0 && (
          <ListPagination
            meta={meta}
            onPage={(page) => params.set({ page: page === 1 ? null : page }, { resetPage: false })}
            onPerPage={(perPage) => params.set({ perPage: perPage === 25 ? null : perPage })}
          />
        )}
      </Card>
    </>
  );
}
