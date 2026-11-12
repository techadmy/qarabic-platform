'use client';

import type { StudentDto } from '@qarabic/shared';
import { Badge } from '@qarabic/ui/components/badge';
import { Button } from '@qarabic/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { GraduationCapIcon, HouseIcon, XIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { FilterSelect } from '@/components/list/list-toolbar';
import { LocalTime } from '@/components/people/local-time';
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
import { fetchPerson } from '@/lib/api/people';
import { can } from '@/lib/auth/use-me';
import type { ListParams } from '@/lib/list-params';
import { peopleKeys } from '@/lib/people/use-person-actions';
import { StudentProfile } from './[id]/student-profile';

/** Removable chip for the family filter (`?familyId=`) set from a family's row or profile. */
function FamilyChip({ params }: { params: ListParams }) {
  const t = useTranslations('students');
  const familyId = Number(params.get('familyId'));
  const family = useQuery({
    queryKey: peopleKeys.detail('families', familyId),
    queryFn: ({ signal }) => fetchPerson('families', familyId, signal),
    enabled: familyId > 0,
  });
  if (!familyId) return null;
  return (
    <div className="flex h-10 items-center">
      <Badge variant="secondary" className="h-8 gap-1 rounded-md ps-2.5 pe-1 text-sm">
        {t('familyFilter', { name: family.data?.parentName ?? `#${familyId}` })}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('clearFamily')}
          onClick={() => params.set({ familyId: null })}
        >
          <XIcon />
        </Button>
      </Badge>
    </div>
  );
}

/**
 * Students; for a teacher (sessions.conduct without families.view) this is «طلابي»: own students
 * only, no parent data, no add/archive (D138).
 */
export function StudentsView() {
  const t = useTranslations('students');
  const tp = useTranslations('people');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const me = useCurrentUser();
  const staffView = can(me, 'families.view');
  const teacherView = !staffView && can(me, 'sessions.conduct');
  const parentView = me.role?.kind === 'parent';
  const canManage = can(me, 'families.manage');
  const lookups = useLookups(canManage);
  const course = (c: StudentDto['regularCourse']) =>
    c ? (locale === 'ar' ? c.nameAr : c.nameEn) : '—';

  const columns = (params: ListParams): ColumnDef<StudentDto, unknown>[] => [
    {
      id: 'name',
      header: tp('fields.name'),
      cell: ({ row }) => (
        <RecordCell
          href={`/students/${row.original.id}`}
          name={<Highlight text={row.original.name} query={params.q} />}
          secondary={row.original.family.parentName}
        />
      ),
    },
    {
      id: 'course',
      header: tp('fields.course'),
      cell: ({ row }) => course(row.original.regularCourse),
    },
    ...(teacherView
      ? []
      : [
          {
            id: 'teacher',
            header: tp('fields.teacher'),
            cell: ({ row }) => row.original.teacher?.name ?? '—',
          } satisfies ColumnDef<StudentDto, unknown>,
        ]),
    {
      id: 'localTime',
      header: tp('fields.familyTime'),
      cell: ({ row }) => <LocalTime timeZone={row.original.family.timezone} />,
    },
    {
      id: 'status',
      header: tp('fields.status'),
      cell: ({ row }) => <StatusBadge kind="students" status={row.original.status.value} />,
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">{tp('actions')}</span>,
      meta: { className: 'w-0 text-end' },
      cell: ({ row }) =>
        row.original.archive ? (
          canManage && (
            <RestoreButton
              kind="students"
              record={{
                id: row.original.id,
                name: row.original.name,
                reason: row.original.archive.reason,
              }}
            />
          )
        ) : staffView && !parentView ? (
          <div className="flex justify-end">
            <RowShortcut
              href={`/families/${row.original.familyId}`}
              label={t('openFamily')}
              icon={HouseIcon}
            />
          </div>
        ) : null,
    },
  ];

  return (
    <PeopleList
      kind="students"
      allowed={staffView || teacherView}
      canManage={canManage}
      canSeeArchived={canManage}
      icon={GraduationCapIcon}
      text={{
        title: teacherView ? t('titleMine') : t('title'),
        description: teacherView ? t('descriptionMine') : t('description'),
        add: t('add'),
        search: t('search'),
        searchHint: teacherView ? t('searchHintMine') : t('searchHint'),
        tableLabel: teacherView ? t('titleMine') : t('tableLabel'),
        empty: teacherView ? t('emptyMine') : t('empty'),
        emptyDescription: teacherView ? t('emptyMineDescription') : t('emptyDescription'),
      }}
      sortOptions={[
        { value: 'id', label: tp('sort.newest') },
        { value: 'name', label: tp('sort.name') },
      ]}
      filterKeys={['familyId', 'teacherId', 'courseId']}
      filters={(params) => (
        <>
          <FamilyChip params={params} />
          {canManage && lookups.data && (
            <>
              <FilterSelect
                label={tp('fields.teacher')}
                value={params.get('teacherId')}
                onChange={(v) => params.set({ teacherId: v || null })}
                allLabel={tp('allTeachers')}
                options={lookups.data.teachers.map((x) => ({ value: String(x.id), label: x.name }))}
              />
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
            </>
          )}
        </>
      )}
      columns={columns}
      renderDetail={(id) => <StudentProfile key={id} id={id} />}
      renderSplitItem={(s) => (
        <span className="flex flex-col gap-1">
          <span className="flex items-start justify-between gap-2">
            <span className="font-semibold">{s.name}</span>
            <StatusBadge kind="students" status={s.status.value} />
          </span>
          <span className="line-clamp-1 text-sm text-muted-foreground">
            {course(s.regularCourse)}
          </span>
        </span>
      )}
      renderCard={(s) => (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <span className="font-semibold">{s.name}</span>
            <StatusBadge kind="students" status={s.status.value} />
          </div>
          <span className="text-sm text-muted-foreground">
            {course(s.regularCourse)}
            {!teacherView && s.teacher ? ` · ${s.teacher.name}` : ''}
          </span>
          <span className="text-sm">
            <LocalTime timeZone={s.family.timezone} />
          </span>
        </div>
      )}
    />
  );
}
