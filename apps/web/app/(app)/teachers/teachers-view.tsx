'use client';

import type { TeacherDto } from '@qarabic/shared';
import type { ColumnDef } from '@tanstack/react-table';
import { BadgeCheckIcon, GraduationCapIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { FilterSelect } from '@/components/list/list-toolbar';
import {
  Highlight,
  PeopleList,
  RecordCell,
  RestoreButton,
  RowShortcut,
} from '@/components/people/people-list';
import { useLookups } from '@/components/people/person-sheet';
import { useCurrentUser } from '@/components/shell/app-shell';
import { StatusBadge } from '@/components/status-badge';
import { can } from '@/lib/auth/use-me';
import type { ListParams } from '@/lib/list-params';
import { TeacherProfile } from './[id]/teacher-profile';

export function TeachersView() {
  const t = useTranslations('teachers');
  const tp = useTranslations('people');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const me = useCurrentUser();
  const canManage = can(me, 'staff.manage');
  const canSeeStudents = can(me, 'families.view');
  const lookups = useLookups(canManage);
  const courses = (x: TeacherDto) =>
    x.courses.map((c) => (locale === 'ar' ? c.nameAr : c.nameEn)).join('، ') || '—';

  const columns = (params: ListParams): ColumnDef<TeacherDto, unknown>[] => [
    {
      id: 'name',
      header: tp('fields.name'),
      cell: ({ row }) => (
        <RecordCell
          href={`/teachers/${row.original.id}`}
          name={<Highlight text={row.original.name} query={params.q} />}
          secondary={<bdi dir="ltr">{row.original.email}</bdi>}
        />
      ),
    },
    {
      id: 'phone',
      header: tp('fields.phone'),
      cell: ({ row }) => (row.original.phone ? <bdi dir="ltr">{row.original.phone}</bdi> : '—'),
    },
    { id: 'courses', header: tp('fields.courses'), cell: ({ row }) => courses(row.original) },
    {
      id: 'students',
      header: tp('fields.activeStudents'),
      meta: { numeric: true },
      cell: ({ row }) =>
        canSeeStudents ? (
          <Link
            href={`/students?teacherId=${row.original.id}`}
            className="font-semibold text-primary hover:underline"
          >
            {row.original.activeStudents}
          </Link>
        ) : (
          row.original.activeStudents
        ),
    },
    {
      id: 'status',
      header: tp('fields.status'),
      cell: ({ row }) => <StatusBadge kind="teachers" status={row.original.status.value} />,
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">{tp('actions')}</span>,
      meta: { className: 'w-0 text-end' },
      cell: ({ row }) =>
        row.original.archive ? (
          canManage && (
            <RestoreButton
              kind="teachers"
              record={{
                id: row.original.id,
                name: row.original.name,
                reason: row.original.archive.reason,
              }}
            />
          )
        ) : canSeeStudents ? (
          <div className="flex justify-end">
            <RowShortcut
              href={`/students?teacherId=${row.original.id}`}
              label={t('studentsOf')}
              icon={GraduationCapIcon}
            />
          </div>
        ) : null,
    },
  ];

  return (
    <PeopleList
      kind="teachers"
      allowed={can(me, 'staff.view')}
      canManage={canManage}
      canSeeArchived={canManage}
      icon={BadgeCheckIcon}
      text={{
        title: t('title'),
        description: t('description'),
        add: t('add'),
        search: t('search'),
        searchHint: t('searchHint'),
        tableLabel: t('tableLabel'),
        empty: t('empty'),
        emptyDescription: t('emptyDescription'),
      }}
      sortOptions={[
        { value: 'id', label: tp('sort.newest') },
        { value: 'name', label: tp('sort.name') },
      ]}
      filterKeys={['courseId']}
      filters={(params) =>
        canManage &&
        lookups.data && (
          <FilterSelect
            label={tp('fields.course')}
            value={params.get('courseId')}
            onChange={(v) => params.set({ courseId: v || null })}
            allLabel={tp('allCourses')}
            options={lookups.data.courses.map((c) => ({
              value: String(c.id),
              label: locale === 'ar' ? c.nameAr : c.nameEn,
            }))}
          />
        )
      }
      columns={columns}
      renderDetail={(id) => <TeacherProfile key={id} id={id} />}
      renderSplitItem={(x) => (
        <span className="flex flex-col gap-1">
          <span className="flex items-start justify-between gap-2">
            <span className="font-semibold">{x.name}</span>
            <StatusBadge kind="teachers" status={x.status.value} />
          </span>
          <span className="line-clamp-1 text-sm text-muted-foreground">{courses(x)}</span>
        </span>
      )}
      renderCard={(x) => (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <span className="font-semibold">{x.name}</span>
            <StatusBadge kind="teachers" status={x.status.value} />
          </div>
          <span className="text-sm text-muted-foreground">{courses(x)}</span>
          <span className="text-sm">{t('activeStudents', { count: x.activeStudents })}</span>
        </div>
      )}
    />
  );
}
