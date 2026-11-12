'use client';

import type { StaffDto } from '@qarabic/shared';
import { Badge } from '@qarabic/ui/components/badge';
import type { ColumnDef } from '@tanstack/react-table';
import { UserCogIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { FilterSelect } from '@/components/list/list-toolbar';
import { Highlight, PeopleList, RecordCell, RestoreButton } from '@/components/people/people-list';
import { useLookups } from '@/components/people/person-sheet';
import { useCurrentUser } from '@/components/shell/app-shell';
import { StatusBadge } from '@/components/status-badge';
import { can } from '@/lib/auth/use-me';
import type { ListParams } from '@/lib/list-params';

export function roleLabel(role: StaffDto['role'], locale: 'ar' | 'en') {
  return locale === 'ar' ? role.labelAr : (role.labelEn ?? role.labelAr);
}

export function StaffView() {
  const t = useTranslations('staff');
  const tp = useTranslations('people');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const me = useCurrentUser();
  const canManage = can(me, 'users.manage');
  const lookups = useLookups(canManage);

  const columns = (params: ListParams): ColumnDef<StaffDto, unknown>[] => [
    {
      id: 'name',
      header: tp('fields.name'),
      cell: ({ row }) => (
        <RecordCell
          href={`/staff/${row.original.id}`}
          name={<Highlight text={row.original.name} query={params.q} />}
          secondary={<bdi dir="ltr">{row.original.email}</bdi>}
        />
      ),
    },
    {
      id: 'role',
      header: tp('fields.role'),
      cell: ({ row }) => (
        <Badge variant="outline" className="h-6 rounded-md text-caption">
          {roleLabel(row.original.role, locale)}
        </Badge>
      ),
    },
    {
      id: 'phone',
      header: tp('fields.phone'),
      cell: ({ row }) => (row.original.phone ? <bdi dir="ltr">{row.original.phone}</bdi> : '—'),
    },
    {
      id: 'status',
      header: tp('fields.status'),
      cell: ({ row }) => <StatusBadge kind="staff" status={row.original.status.value} />,
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">{tp('actions')}</span>,
      meta: { className: 'w-0 text-end' },
      cell: ({ row }) =>
        row.original.archive && canManage ? (
          <RestoreButton
            kind="staff"
            record={{
              id: row.original.id,
              name: row.original.name,
              reason: row.original.archive.reason,
            }}
          />
        ) : null,
    },
  ];

  return (
    <PeopleList
      kind="staff"
      allowed={can(me, 'users.view')}
      canManage={canManage}
      canSeeArchived={canManage}
      icon={UserCogIcon}
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
        { value: 'name', label: tp('sort.name') },
        { value: 'id', label: tp('sort.newest') },
      ]}
      filterKeys={['role']}
      filters={(params) =>
        canManage &&
        lookups.data && (
          <FilterSelect
            label={tp('fields.role')}
            value={params.get('role')}
            onChange={(v) => params.set({ role: v || null })}
            allLabel={tp('allRoles')}
            options={lookups.data.staffRoles.map((r) => ({
              value: r.name,
              label: locale === 'ar' ? r.labelAr : (r.labelEn ?? r.labelAr),
            }))}
          />
        )
      }
      columns={columns}
      renderCard={(s) => (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <span className="font-semibold">{s.name}</span>
            <StatusBadge kind="staff" status={s.status.value} />
          </div>
          <span className="text-sm text-muted-foreground">{roleLabel(s.role, locale)}</span>
          <bdi dir="ltr" className="text-sm">
            {s.email}
          </bdi>
        </div>
      )}
    />
  );
}
