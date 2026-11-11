'use client';

import {
  countryName,
  GENDER_LABELS,
  STUDENT_LANGUAGE_LABELS,
  type StudentDetailDto,
} from '@qarabic/shared';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { InfoSection, KeyFacts, StatusHistory } from '@/components/people/detail';
import { BothTimes } from '@/components/people/local-time';
import { ProfileShell } from '@/components/people/profile-shell';
import { useCurrentUser } from '@/components/shell/app-shell';
import { StatusBadge } from '@/components/status-badge';
import { fetchPerson } from '@/lib/api/people';
import { can } from '@/lib/auth/use-me';
import { peopleKeys } from '@/lib/people/use-person-actions';
import { formatDate, zoneLabel } from '@/lib/time';

/** Student profile: Student · Study plan · Family · Remarks (docs/28 §5). */
export function StudentProfile({ id }: { id: number }) {
  const t = useTranslations('students');
  const tp = useTranslations('people');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const me = useCurrentUser();
  const canManage = can(me, 'families.manage');
  const staffView = can(me, 'families.view') && me.role?.kind !== 'parent';
  const query = useQuery({
    queryKey: peopleKeys.detail('students', id),
    queryFn: ({ signal }) => fetchPerson('students', id, signal),
    enabled: Number.isInteger(id) && id > 0,
  });
  const s = query.data;
  const course = (c: StudentDetailDto['regularCourse']) =>
    c ? (locale === 'ar' ? c.nameAr : c.nameEn) : null;
  const editable = canManage && !s?.archive;

  return (
    <ProfileShell
      kind="students"
      backHref={me.role?.kind === 'parent' ? '/my-family' : '/students'}
      backLabel={t('back')}
      query={query}
      canManage={canManage}
      record={
        s && {
          id: s.id,
          name: s.name,
          subtitle: s.family.parentName,
          status: s.status,
          archive: s.archive,
        }
      }
      sheetTarget={s && { kind: 'students', record: s }}
    >
      {({ edit }) =>
        s && (
          <>
            <KeyFacts
              items={[
                {
                  label: tp('fields.status'),
                  value: <StatusBadge kind="students" status={s.status.value} />,
                },
                { label: tp('fields.teacher'), value: s.teacher?.name ?? '—' },
                { label: tp('fields.course'), value: course(s.regularCourse) ?? '—' },
                {
                  label: tp('fields.familyTime'),
                  value: (
                    <span className="text-sm font-medium">
                      <BothTimes timeZone={s.family.timezone} party={tp('party.family')} />
                    </span>
                  ),
                },
              ]}
            />
            <div className="grid items-start gap-4 lg:grid-cols-2">
              <InfoSection
                title={tp('sections.student')}
                onEdit={editable ? () => edit('profile') : undefined}
                rows={[
                  { label: tp('fields.name'), value: s.name },
                  {
                    label: tp('fields.gender'),
                    value: s.gender && GENDER_LABELS[s.gender][locale],
                  },
                  { label: tp('fields.age'), value: s.age },
                  {
                    label: tp('fields.language'),
                    value: s.language && STUDENT_LANGUAGE_LABELS[s.language][locale],
                  },
                  ...(s.email !== undefined
                    ? [
                        {
                          label: tp('fields.email'),
                          value: s.email && <bdi dir="ltr">{s.email}</bdi>,
                        },
                      ]
                    : []),
                ]}
              />
              <InfoSection
                title={tp('sections.study')}
                onEdit={editable ? () => edit('study') : undefined}
                rows={[
                  { label: tp('fields.course'), value: course(s.regularCourse) },
                  { label: tp('fields.additionalCourse'), value: course(s.additionalCourse) },
                  { label: tp('fields.teacher'), value: s.teacher?.name },
                  { label: tp('fields.startDate'), value: formatDate(s.startDate, locale) },
                  {
                    label: tp('fields.zoomId'),
                    value: s.zoomId && <bdi dir="ltr">{s.zoomId}</bdi>,
                  },
                ]}
              />
              <InfoSection
                title={tp('sections.family')}
                rows={[
                  ...(s.family.parentName !== undefined
                    ? [
                        {
                          label: tp('fields.parent'),
                          value: staffView ? (
                            <Link
                              href={`/families/${s.familyId}`}
                              className="font-semibold text-primary hover:underline"
                            >
                              {s.family.parentName}
                            </Link>
                          ) : (
                            s.family.parentName
                          ),
                        },
                      ]
                    : []),
                  {
                    label: tp('fields.country'),
                    value: s.family.countryCode && countryName(s.family.countryCode, locale),
                  },
                  { label: tp('fields.timezone'), value: zoneLabel(s.family.timezone, locale) },
                ]}
              />
              <InfoSection
                title={tp('sections.remarks')}
                onEdit={editable ? () => edit('remarks') : undefined}
                rows={[
                  { label: tp('fields.remarkParent'), value: s.remarkParent, wide: true },
                  { label: tp('fields.remarkTeacher'), value: s.remarkTeacher, wide: true },
                ]}
              />
              {staffView && <StatusHistory kind="students" entries={s.statusHistory} />}
            </div>
          </>
        )
      }
    </ProfileShell>
  );
}
