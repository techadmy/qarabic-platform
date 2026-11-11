'use client';

import { countryName, GENDER_LABELS } from '@qarabic/shared';
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
import { formatInstant, zoneLabel } from '@/lib/time';

/** Teacher profile: Contact · Work · Background (docs/28 §5). */
export function TeacherProfile({ id }: { id: number }) {
  const t = useTranslations('teachers');
  const tp = useTranslations('people');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const me = useCurrentUser();
  const canManage = can(me, 'staff.manage');
  const query = useQuery({
    queryKey: peopleKeys.detail('teachers', id),
    queryFn: ({ signal }) => fetchPerson('teachers', id, signal),
    enabled: Number.isInteger(id) && id > 0,
  });
  const x = query.data;
  const editable = canManage && !x?.archive;
  const money = (amount: string | null, currency: string) =>
    amount === null
      ? null
      : new Intl.NumberFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
          style: 'currency',
          currency,
        }).format(Number(amount));

  return (
    <ProfileShell
      kind="teachers"
      backHref="/teachers"
      backLabel={t('back')}
      query={query}
      canManage={canManage}
      record={
        x && {
          id: x.id,
          name: x.name,
          subtitle: <bdi dir="ltr">{x.email}</bdi>,
          status: x.status,
          archive: x.archive,
        }
      }
      sheetTarget={x && { kind: 'teachers', record: x }}
      activeStudents={x?.activeStudents}
    >
      {({ edit }) =>
        x && (
          <>
            <KeyFacts
              items={[
                {
                  label: tp('fields.activeStudents'),
                  value: can(me, 'families.view') ? (
                    <Link
                      href={`/students?teacherId=${x.id}`}
                      className="text-primary hover:underline"
                    >
                      {x.activeStudents}
                    </Link>
                  ) : (
                    x.activeStudents
                  ),
                },
                {
                  label: tp('fields.status'),
                  value: <StatusBadge kind="teachers" status={x.status.value} />,
                },
                {
                  label: tp('fields.hourlyRate'),
                  value: <bdi>{money(x.hourlyRate, x.hourlyRateCurrency) ?? '—'}</bdi>,
                },
                {
                  label: tp('fields.localTime'),
                  value: (
                    <span className="text-sm font-medium">
                      <BothTimes timeZone={x.timezone} party={tp('party.teacher')} />
                    </span>
                  ),
                },
              ]}
            />
            <div className="grid items-start gap-4 lg:grid-cols-2">
              <InfoSection
                title={tp('sections.contact')}
                onEdit={editable ? () => edit('contact') : undefined}
                rows={[
                  { label: tp('fields.email'), value: <bdi dir="ltr">{x.email}</bdi> },
                  { label: tp('fields.phone'), value: x.phone && <bdi dir="ltr">{x.phone}</bdi> },
                  {
                    label: tp('fields.altPhone'),
                    value: x.altPhone && <bdi dir="ltr">{x.altPhone}</bdi>,
                  },
                  {
                    label: tp('fields.skypeId'),
                    value: x.skypeId && <bdi dir="ltr">{x.skypeId}</bdi>,
                  },
                  { label: tp('fields.address'), value: x.address },
                ]}
              />
              <InfoSection
                title={tp('sections.work')}
                onEdit={editable ? () => edit('work') : undefined}
                rows={[
                  {
                    label: tp('fields.courses'),
                    value: x.courses.map((c) => (locale === 'ar' ? c.nameAr : c.nameEn)).join('، '),
                  },
                  {
                    label: tp('fields.hourlyRate'),
                    value: money(x.hourlyRate, x.hourlyRateCurrency),
                  },
                  {
                    label: tp('fields.createdAt'),
                    value: formatInstant(x.createdAt, me.timezone, locale),
                  },
                ]}
              />
              <InfoSection
                title={tp('sections.personal')}
                onEdit={editable ? () => edit('personal') : undefined}
                rows={[
                  {
                    label: tp('fields.gender'),
                    value: x.gender && GENDER_LABELS[x.gender][locale],
                  },
                  { label: tp('fields.age'), value: x.age },
                  { label: tp('fields.nationality'), value: x.nationality },
                  {
                    label: tp('fields.country'),
                    value: x.countryCode && countryName(x.countryCode, locale),
                  },
                  { label: tp('fields.timezone'), value: zoneLabel(x.timezone, locale) },
                ]}
              />
              <InfoSection
                title={tp('sections.background')}
                onEdit={editable ? () => edit('background') : undefined}
                rows={[
                  { label: tp('fields.qualification'), value: x.qualification, wide: true },
                  { label: tp('fields.experience'), value: x.experience, wide: true },
                  { label: tp('fields.description'), value: x.description, wide: true },
                ]}
              />
              <StatusHistory kind="teachers" entries={x.statusHistory} />
            </div>
          </>
        )
      }
    </ProfileShell>
  );
}
