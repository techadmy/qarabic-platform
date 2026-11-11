'use client';

import { countryName, type FamilyDto } from '@qarabic/shared';
import { Label } from '@qarabic/ui/components/label';
import type { ColumnDef } from '@tanstack/react-table';
import { FolderOpenIcon, GraduationCapIcon, HouseIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Combobox } from '@/components/forms/fields';
import { useCountryOptions } from '@/components/forms/people-fields';
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
import { can } from '@/lib/auth/use-me';
import type { ListParams } from '@/lib/list-params';

export function FamiliesView() {
  const t = useTranslations('families');
  const tp = useTranslations('people');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const me = useCurrentUser();
  const canManage = can(me, 'families.manage');
  const lookups = useLookups(canManage);
  const countries = useCountryOptions();

  const columns = (params: ListParams): ColumnDef<FamilyDto, unknown>[] => [
    {
      id: 'parent',
      header: tp('fields.parent'),
      cell: ({ row }) => (
        <RecordCell
          href={`/families/${row.original.id}`}
          name={<Highlight text={row.original.parentName} query={params.q} />}
          secondary={<bdi dir="ltr">{row.original.email}</bdi>}
        />
      ),
    },
    {
      id: 'country',
      header: tp('fields.country'),
      cell: ({ row }) =>
        row.original.countryCode ? countryName(row.original.countryCode, locale) : '—',
    },
    {
      id: 'localTime',
      header: tp('fields.localTime'),
      cell: ({ row }) => <LocalTime timeZone={row.original.timezone} />,
    },
    {
      id: 'students',
      header: tp('fields.students'),
      meta: { numeric: true },
      cell: ({ row }) => row.original.students.length,
    },
    {
      id: 'manager',
      header: tp('fields.manager'),
      cell: ({ row }) => row.original.manager?.name ?? '—',
    },
    {
      id: 'status',
      header: tp('fields.status'),
      cell: ({ row }) => <StatusBadge kind="families" status={row.original.status.value} />,
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">{tp('actions')}</span>,
      meta: { className: 'w-0 text-end' },
      cell: ({ row }) =>
        row.original.archive ? (
          canManage && (
            <RestoreButton
              kind="families"
              record={{
                id: row.original.id,
                name: row.original.parentName,
                reason: row.original.archive.reason,
              }}
            />
          )
        ) : (
          <div className="flex justify-end gap-0.5">
            <RowShortcut
              href={`/families/${row.original.id}`}
              label={tp('open')}
              icon={FolderOpenIcon}
            />
            <RowShortcut
              href={`/students?familyId=${row.original.id}`}
              label={t('studentsOf')}
              icon={GraduationCapIcon}
            />
          </div>
        ),
    },
  ];

  return (
    <PeopleList
      kind="families"
      allowed={can(me, 'families.view')}
      canManage={canManage}
      canSeeArchived={canManage}
      icon={HouseIcon}
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
        { value: 'parentName', label: tp('sort.name') },
        { value: 'startDate', label: tp('sort.startDate') },
      ]}
      filterKeys={['countryCode', 'managerId']}
      filters={(params) => (
        <>
          <div className="flex min-w-48 flex-col gap-1.5">
            <Label htmlFor="filter-country" className="text-[0.8125rem] text-muted-foreground">
              {tp('fields.country')}
            </Label>
            <Combobox
              id="filter-country"
              value={params.get('countryCode') || null}
              onChange={(v) => params.set({ countryCode: v })}
              options={countries}
              placeholder={tp('allCountries')}
              searchPlaceholder={tp('searchCountry')}
              clearable
            />
          </div>
          {canManage && lookups.data && (
            <FilterSelect
              label={tp('fields.manager')}
              value={params.get('managerId')}
              onChange={(v) => params.set({ managerId: v || null })}
              allLabel={tp('allManagers')}
              options={lookups.data.managers.map((m) => ({ value: String(m.id), label: m.name }))}
            />
          )}
        </>
      )}
      columns={columns}
      renderCard={(f) => (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <span className="font-semibold">{f.parentName}</span>
            <StatusBadge kind="families" status={f.status.value} />
          </div>
          <span className="text-sm text-muted-foreground">
            {f.countryCode ? countryName(f.countryCode, locale) : '—'} ·{' '}
            <LocalTime timeZone={f.timezone} />
          </span>
          <span className="text-sm">{t('childrenCount', { count: f.students.length })}</span>
        </div>
      )}
    />
  );
}
