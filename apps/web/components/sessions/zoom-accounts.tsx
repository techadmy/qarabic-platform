'use client';

import type { ZoomAccountHostDto, ZoomHostsSyncResultDto } from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Field, FieldDescription, FieldLabel } from '@qarabic/ui/components/field';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { LinkIcon, RefreshCwIcon, TriangleAlertIcon, UnlinkIcon, VideoOffIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { DataTable } from '@/components/data-table';
import { Combobox, type Option } from '@/components/forms/fields';
import { ToneBadge } from '@/components/sessions/badges';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchPeopleList } from '@/lib/api/people';
import { assignZoomHost, fetchZoomAccount, sessionKeys, syncZoomHosts } from '@/lib/api/sessions';
import { peopleKeys } from '@/lib/people/use-person-actions';
import { formatInstant } from '@/lib/time';

/*
| D151 (b) «حسابات Zoom»: the academy's licensed Zoom users (synced daily and on «مزامنة الآن»),
| one per teacher. Assigning a user sets the teacher's Zoom link and PMI; freeing it clears the
| teacher's link. With Zoom not connected the API answers `{ enabled: false }`.
*/

/** The account query, shared by the settings tab, the teacher form and the profile. */
export function useZoomAccount(enabled = true) {
  return useQuery({
    queryKey: sessionKeys.zoomAccount,
    queryFn: ({ signal }) => fetchZoomAccount(signal),
    enabled,
  });
}

/** «Name · email» for a host. */
export function hostName(h: Pick<ZoomAccountHostDto, 'displayName' | 'email'>): string {
  return h.displayName ?? h.email;
}

/** Assign or free a Zoom user; refreshes the account, the teacher and their classes. */
export function useAssignZoomHost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { hostId: number; teacherId: number | null }) =>
      assignZoomHost(v.hostId, v.teacherId),
    onSuccess: (account) => {
      queryClient.setQueryData(sessionKeys.zoomAccount, account);
      // The teacher's link (and their classes' link) changed.
      void queryClient.invalidateQueries({ queryKey: peopleKeys.all });
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    },
  });
}

/** The 409s of an assignment, in words. */
function useAssignError() {
  const t = useTranslations('zoomAccounts');
  return (e: unknown) =>
    isApiError(e, 409) && e.code === 'zoom_host_taken'
      ? t('errors.taken')
      : isApiError(e, 409) && e.code === 'zoom_host_inactive'
        ? t('errors.inactive')
        : isApiError(e, 503)
          ? t('errors.off')
          : t('errors.failed');
}

export function ZoomAccounts() {
  const t = useTranslations('zoomAccounts');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const query = useZoomAccount();
  const assign = useAssignZoomHost();
  const assignError = useAssignError();
  const [linking, setLinking] = useState<ZoomAccountHostDto | null>(null);
  const [unlinking, setUnlinking] = useState<ZoomAccountHostDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<ZoomHostsSyncResultDto | null>(null);

  const sync = useMutation({
    mutationFn: syncZoomHosts,
    onSuccess: (result) => {
      setLastSync(result);
      void queryClient.invalidateQueries({ queryKey: sessionKeys.zoomAccount });
      toast.success(t('synced', { synced: result.synced, deactivated: result.deactivated }));
    },
    onError: (e) => toast.error(isApiError(e, 503) ? t('errors.off') : t('errors.syncFailed')),
  });

  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />;
  if (!query.isPending && !query.data.enabled) {
    return (
      <Card className="p-4 shadow-none">
        <EmptyState icon={VideoOffIcon} title={t('off.title')} description={t('off.body')} />
      </Card>
    );
  }
  const account = query.data?.enabled ? query.data : null;
  const syncedAt = account?.lastSyncedAt ?? null;

  const columns: ColumnDef<ZoomAccountHostDto, unknown>[] = [
    {
      id: 'name',
      header: t('columns.name'),
      cell: ({ row }) => (
        <span className="flex flex-col">
          <span className="font-semibold">{row.original.displayName ?? '—'}</span>
          <bdi dir="ltr" className="text-sm text-muted-foreground">
            {row.original.email}
          </bdi>
        </span>
      ),
    },
    {
      id: 'pmi',
      header: t('columns.pmi'),
      cell: ({ row }) =>
        row.original.pmiMeetingId ? (
          <bdi dir="ltr" className="tabular-nums">
            {row.original.pmiMeetingId}
          </bdi>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'teacher',
      header: t('columns.teacher'),
      cell: ({ row }) =>
        row.original.teacher ? (
          <Link
            href={`/teachers/${row.original.teacher.id}`}
            className="text-primary hover:underline"
          >
            {row.original.teacher.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">{t('free')}</span>
        ),
    },
    {
      id: 'status',
      header: t('columns.status'),
      cell: ({ row }) =>
        row.original.isActive ? (
          <ToneBadge tone="green" label={t('active')} />
        ) : (
          <ToneBadge tone="grey" label={t('inactive')} />
        ),
    },
    {
      id: 'synced',
      header: t('columns.synced'),
      cell: ({ row }) =>
        row.original.lastSyncedAt ? (
          <span className="text-sm">
            {formatInstant(row.original.lastSyncedAt, me.timezone, locale)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">{t('columns.actions')}</span>,
      cell: ({ row }) => {
        const h = row.original;
        if (h.teacher) {
          return (
            <Button
              variant="outline"
              size="sm"
              className="max-sm:h-11"
              onClick={() => {
                setError(null);
                setUnlinking(h);
              }}
            >
              <UnlinkIcon />
              {t('unlink')}
              <span className="sr-only">: {hostName(h)}</span>
            </Button>
          );
        }
        if (!h.isActive) return null;
        return (
          <Button
            variant="outline"
            size="sm"
            className="max-sm:h-11"
            onClick={() => {
              setError(null);
              setLinking(h);
            }}
          >
            <LinkIcon />
            {t('link')}
            <span className="sr-only">: {hostName(h)}</span>
          </Button>
        );
      },
      meta: { className: 'text-end' },
    },
  ];

  return (
    <Card className="gap-0 py-0 shadow-none">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-4">
        <p className="text-sm text-muted-foreground">
          {syncedAt
            ? t('lastSync', { at: formatInstant(syncedAt, me.timezone, locale) ?? '' })
            : t('neverSynced')}
        </p>
        <Button variant="outline" disabled={sync.isPending} onClick={() => sync.mutate()}>
          {sync.isPending ? <Spinner /> : <RefreshCwIcon />}
          {t('syncNow')}
        </Button>
      </div>
      {lastSync && lastSync.conflicts.length > 0 && (
        <div className="border-b p-4">
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>{t('conflicts.title')}</AlertTitle>
            <AlertDescription>
              <p>{t('conflicts.body')}</p>
              <ul className="mt-1 list-disc ps-5">
                {lastSync.conflicts.map((c) => (
                  <li key={c.email}>
                    <bdi dir="ltr">{c.email}</bdi> · <bdi dir="ltr">{c.pmiMeetingId}</bdi>
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        </div>
      )}
      {account && account.hosts.length === 0 ? (
        <div className="p-4">
          <EmptyState icon={VideoOffIcon} title={t('empty.title')} description={t('empty.body')} />
        </div>
      ) : (
        <DataTable
          bare
          columns={columns}
          data={account?.hosts ?? []}
          label={t('title')}
          emptyText={t('empty.title')}
          loading={query.isPending}
        />
      )}
      {linking && (
        <LinkDialog
          host={linking}
          hosts={account?.hosts ?? []}
          busy={assign.isPending}
          error={error}
          onClose={() => setLinking(null)}
          onConfirm={(teacherId) =>
            assign.mutate(
              { hostId: linking.id, teacherId },
              {
                onSuccess: () => {
                  setLinking(null);
                  toast.success(t('linked'));
                },
                onError: (e) => setError(assignError(e)),
              },
            )
          }
        />
      )}
      <ReasonDialog
        open={!!unlinking}
        onOpenChange={(o) => !o && setUnlinking(null)}
        title={unlinking ? t('unlinkTitle', { name: unlinking.teacher?.name ?? '' }) : ''}
        description={t('unlinkBody')}
        confirmLabel={t('unlink')}
        destructive
        busy={assign.isPending}
        error={error}
        onConfirm={() => {
          if (!unlinking) return;
          assign.mutate(
            { hostId: unlinking.id, teacherId: null },
            {
              onSuccess: () => {
                setUnlinking(null);
                toast.success(t('unlinked'));
              },
              onError: (e) => setError(assignError(e)),
            },
          );
        }}
      />
    </Card>
  );
}

/** «ربط بمعلم»: pick an active teacher; one who already has a Zoom user is moved to this one. */
function LinkDialog({
  host,
  hosts,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  host: ZoomAccountHostDto;
  hosts: ZoomAccountHostDto[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (teacherId: number) => void;
}) {
  const t = useTranslations('zoomAccounts');
  const [teacherId, setTeacherId] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const teachers = useQuery({
    queryKey: peopleKeys.list('teachers', { status: 'active', perPage: 100 }),
    queryFn: ({ signal }) =>
      fetchPeopleList('teachers', { status: 'active', perPage: 100 }, signal),
  });
  const holder = (id: number) => hosts.find((h) => h.teacher?.id === id);
  const options: Option[] = (teachers.data?.data ?? []).map((x) => {
    const current = holder(x.id);
    return {
      value: String(x.id),
      label: x.name,
      hint: current ? t('hasHost', { name: hostName(current) }) : undefined,
    };
  });
  const moving = teacherId ? holder(Number(teacherId)) : undefined;
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('linkTitle', { name: hostName(host) })}
      description={t('linkBody')}
      confirmLabel={t('link')}
      busy={busy}
      error={error ?? (missing ? t('pickTeacher') : null)}
      extra={
        <Field data-invalid={missing}>
          <FieldLabel htmlFor="zoom-link-teacher">{t('teacher')}</FieldLabel>
          <Combobox
            id="zoom-link-teacher"
            value={teacherId}
            onChange={(v) => {
              setTeacherId(v);
              setMissing(false);
            }}
            options={options}
            placeholder={t('pickTeacher')}
            searchPlaceholder={t('searchTeacher')}
            loading={teachers.isPending}
            invalid={missing}
          />
          {moving && <FieldDescription>{t('moves', { name: hostName(moving) })}</FieldDescription>}
        </Field>
      }
      onConfirm={() => {
        if (!teacherId) {
          setMissing(true);
          return;
        }
        onConfirm(Number(teacherId));
      }}
    />
  );
}

/**
 * «حساب Zoom» in the teacher form (D151 b): with Zoom connected, pick one of the free licensed
 * users (name, email, PMI) instead of typing the link; the assignment is saved with the teacher.
 */
export function ZoomHostPicker({
  hosts,
  teacherId,
  value,
  onChange,
}: {
  hosts: ZoomAccountHostDto[];
  teacherId?: number;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const t = useTranslations('zoomAccounts');
  const options: Option[] = hosts
    .filter((h) => h.isActive && (!h.teacher || h.teacher.id === teacherId))
    .map((h) => ({
      value: String(h.id),
      label: `${hostName(h)} · ${h.email}`,
      short: hostName(h),
      keywords: [h.email, h.pmiMeetingId ?? ''],
      hint: h.pmiMeetingId ?? undefined,
    }));
  return (
    <Field>
      <FieldLabel htmlFor="teacher-zoom-host">{t('hostField')}</FieldLabel>
      <Combobox
        id="teacher-zoom-host"
        value={value}
        onChange={onChange}
        options={options}
        placeholder={t('pickHost')}
        searchPlaceholder={t('searchHost')}
        clearable
      />
      <FieldDescription>{t('hostHelp')}</FieldDescription>
    </Field>
  );
}
