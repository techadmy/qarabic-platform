'use client';

import { SALARY_TYPE_LABELS, type PayProfileDto } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { IdCardIcon, PencilIcon, PlusIcon, SearchXIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import type { ColumnMeta } from '@/components/data-table';
import { Combobox } from '@/components/forms/fields';
import { ListPagination } from '@/components/list/list-pagination';
import { ListToolbar } from '@/components/list/list-toolbar';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { ToneBadge } from '@/components/sessions/badges';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchPayProfiles, payrollKeys } from '@/lib/api/payroll';
import { fetchPeopleList } from '@/lib/api/people';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { formatDate } from '@/lib/time';
import { ProfileDialog } from './dialogs';
import { FormRow, Money } from './payroll-bits';

/** The rate that drives the salary type («أجر الساعة 95.00 ج.م.»). */
function MainRate({ p }: { p: PayProfileDto }) {
  const amount =
    p.salaryType === 'monthly'
      ? p.monthlySalary
      : p.salaryType === 'per_class'
        ? p.classRate
        : p.salaryType === 'hourly'
          ? p.hourlyRate
          : (p.slotTiers[p.slotTiers.length - 1]?.amount ?? '0.00');
  return <Money amount={amount} currency={p.currency} />;
}

/**
 * «ملفات الرواتب» (docs/21 §1.1, D89; `payroll.manage`): how each person is paid: salary type,
 * currency, the main rate, allowance and tax, active or stopped. Search by name on the server;
 * a row opens the profile dialog; «ملف راتب جديد» picks a teacher or a staff member.
 */
export function ProfilesView() {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const allowed = can(me, 'payroll.manage');
  const [editing, setEditing] = useState<PayProfileDto | 'new' | null>(null);
  const query = { q: params.q || undefined, page: params.page, perPage: params.perPage };
  const list = useQuery({
    queryKey: payrollKeys.profiles(query),
    queryFn: ({ signal }) => fetchPayProfiles(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  const rows = useMemo(() => list.data?.data ?? [], [list.data]);
  const meta = list.data?.meta;
  const columns = useMemo<ColumnDef<PayProfileDto, unknown>[]>(
    () => [
      {
        id: 'person',
        header: t('person'),
        cell: ({ row: { original: p } }) => <span className="font-semibold">{p.user.name}</span>,
      },
      {
        id: 'type',
        header: t('profile.salaryType'),
        cell: ({ row: { original: p } }) => SALARY_TYPE_LABELS[p.salaryType][locale],
      },
      {
        id: 'rate',
        header: t('profiles.rate'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: p } }) => <MainRate p={p} />,
      },
      {
        id: 'allowance',
        header: t('profile.allowance'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: p } }) => <Money amount={p.allowance} currency={p.currency} />,
      },
      {
        id: 'tax',
        header: t('profile.tax'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: p } }) => <Money amount={p.tax} currency={p.currency} />,
      },
      {
        id: 'status',
        header: t('status'),
        cell: ({ row: { original: p } }) => (
          <ToneBadge
            tone={p.active ? 'green' : 'grey'}
            label={p.active ? t('profiles.active') : t('profiles.inactive')}
          />
        ),
      },
      {
        id: 'updated',
        header: t('profiles.updatedAt'),
        cell: ({ row: { original: p } }) => (
          <span className="text-muted-foreground">{formatDate(p.updatedAt, locale)}</span>
        ),
      },
      {
        id: 'actions',
        header: t('actions'),
        cell: ({ row: { original: p } }) => (
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            aria-label={t('profiles.edit', { name: p.user.name })}
            onClick={() => setEditing(p)}
          >
            <PencilIcon />
            {t('profiles.editShort')}
          </Button>
        ),
      },
    ],
    [t, locale],
  );

  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('profiles.title')} />
        <ForbiddenState />
      </>
    );
  }
  const canPick = can(me, 'staff.view') || can(me, 'users.view');
  return (
    <>
      <PageHeader
        title={t('profiles.title')}
        meta={meta ? t('profiles.count', { count: meta.total }) : undefined}
        actions={
          canPick && (
            <Button className="h-10" onClick={() => setEditing('new')}>
              <PlusIcon />
              {t('profiles.add')}
            </Button>
          )
        }
      />
      <Card className="gap-0 py-0 shadow-none">
        <ListToolbar
          search={{
            label: t('profiles.searchLabel'),
            placeholder: t('profiles.search'),
            value: params.searchInput,
            onChange: params.setSearchInput,
          }}
        />
        {list.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : !list.isPending && rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={params.q ? SearchXIcon : IdCardIcon}
              role={params.q ? 'status' : undefined}
              title={params.q ? t('profiles.noMatch') : t('profiles.none')}
              description={params.q ? t('profiles.noMatchHint') : t('profiles.noneHint')}
            />
          </div>
        ) : (
          <ResponsiveList
            columns={columns}
            rows={rows}
            loading={list.isPending}
            label={t('profiles.table')}
            emptyText={t('profiles.none')}
            getRowId={(p) => p.id}
            renderCard={(p) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-semibold">{p.user.name}</span>
                  <ToneBadge
                    tone={p.active ? 'green' : 'grey'}
                    label={p.active ? t('profiles.active') : t('profiles.inactive')}
                  />
                </div>
                <span className="text-sm text-muted-foreground">
                  {SALARY_TYPE_LABELS[p.salaryType][locale]} · <MainRate p={p} />
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 self-start"
                  aria-label={t('profiles.edit', { name: p.user.name })}
                  onClick={() => setEditing(p)}
                >
                  <PencilIcon />
                  {t('profiles.editShort')}
                </Button>
              </div>
            )}
          />
        )}
        {meta && rows.length > 0 && (
          <ListPagination
            meta={meta}
            onPage={(page) => params.set({ page: page === 1 ? null : page }, { resetPage: false })}
            onPerPage={(perPage) => params.set({ perPage: perPage === 25 ? null : perPage })}
          />
        )}
      </Card>
      {editing === 'new' ? (
        <NewProfile onClose={() => setEditing(null)} />
      ) : (
        editing && (
          <ProfileDialog
            open
            onOpenChange={(o) => !o && setEditing(null)}
            person={editing.user}
            profile={editing}
          />
        )
      )}
    </>
  );
}

/** A new profile: pick a teacher or a staff member (People lists), then the profile form. */
function NewProfile({ onClose }: { onClose: () => void }) {
  const t = useTranslations('payroll.profile');
  const me = useCurrentUser();
  const id = useId();
  const [q, setQ] = useState('');
  const [person, setPerson] = useState<{ id: number; name: string } | null>(null);
  const teachers = useQuery({
    queryKey: ['payroll', 'pick', 'teachers', q],
    queryFn: ({ signal }) => fetchPeopleList('teachers', { q, perPage: 20 }, signal),
    enabled: can(me, 'staff.view'),
  });
  const staff = useQuery({
    queryKey: ['payroll', 'pick', 'staff', q],
    queryFn: ({ signal }) => fetchPeopleList('staff', { q, perPage: 20 }, signal),
    enabled: can(me, 'users.view'),
  });
  const options = [
    ...(teachers.data?.data ?? []).map((x) => ({ id: x.userId, name: x.name })),
    ...(staff.data?.data ?? []).map((x) => ({ id: x.id, name: x.name })),
  ];
  const all = person && !options.some((o) => o.id === person.id) ? [person, ...options] : options;
  return (
    <ProfileDialog
      open
      onOpenChange={(o) => !o && onClose()}
      person={person}
      profile={null}
      pickPerson={
        <FormRow id={id} label={t('person')} required>
          <Combobox
            id={id}
            value={person ? String(person.id) : null}
            onChange={(v) => setPerson(all.find((o) => String(o.id) === v) ?? null)}
            options={all.map((o) => ({ value: String(o.id), label: o.name }))}
            placeholder={t('personPlaceholder')}
            searchPlaceholder={t('personSearch')}
            shouldFilter={false}
            onSearch={setQ}
            loading={teachers.isFetching || staff.isFetching}
          />
        </FormRow>
      }
    />
  );
}
