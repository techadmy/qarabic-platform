'use client';

import {
  REQUEST_TYPE_LABELS,
  REQUEST_TYPES,
  type RequestType,
  type SessionRequestDto,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, InboxIcon, SearchXIcon, Undo2Icon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ListPagination } from '@/components/list/list-pagination';
import { FilterSelect, StatusTabs } from '@/components/list/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { ApproveDialog } from '@/components/requests/approve-dialog';
import {
  RequestStatusBadge,
  RequestTypeBadge,
  StageBadge,
  ToneBadge,
} from '@/components/sessions/badges';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { SessionSheet, useOpenSession } from '@/components/sessions/session-sheet';
import { OtherTime, useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import {
  cancelRequest,
  fetchRequestCounts,
  fetchRequests,
  rejectRequest,
  requestKeys,
} from '@/lib/api/requests';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { refreshClasses } from '@/lib/sessions/cache';
import { useClassError } from '@/lib/sessions/errors';
import { dayAndClock, relativeTime } from '@/lib/schedule-time';

/** «قيد المراجعة» is the default (no `status` in the URL); `any` lists every status. */
const TABS = ['pending', 'decided', 'any'] as const;
type Tab = (typeof TABS)[number];

/**
 * «طلبات الحصص» (staff) and «طلباتي» (teacher, parent) — the requests inbox (docs/15 §6.5; the
 * current app's `RequestsInboxPage`): tabs by status with counts, a type filter with the pending
 * counts, one card per request (who asked and when, the class now → the time asked for in both
 * zones, the reason) with «موافقة» / «رفض» (reason required) for approvers and «سحب الطلب» for
 * the requester. The class opens in the sheet.
 */
export function RequestsView() {
  const t = useTranslations('requests');
  const tl = useTranslations('list');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const portal = me.role?.kind === 'teacher' || me.role?.kind === 'parent';
  const tabParam = params.get('status') as Tab;
  const tab: Tab = TABS.includes(tabParam) ? tabParam : 'pending';
  const typeParam = params.get('type') as RequestType;
  const type = REQUEST_TYPES.includes(typeParam) ? typeParam : null;
  const allowed = can(me, 'session_requests.view');
  const query = {
    status: tab === 'any' ? undefined : tab,
    type: type ?? undefined,
    page: params.page,
    perPage: params.perPage,
  };
  const list = useQuery({
    queryKey: requestKeys.list(query),
    queryFn: ({ signal }) => fetchRequests(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  const counts = useQuery({
    queryKey: requestKeys.counts,
    queryFn: ({ signal }) => fetchRequestCounts(signal),
    enabled: allowed,
  });
  const title = portal ? t('titleMine') : t('title');
  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={title} />
        <ForbiddenState />
      </>
    );
  }
  const meta = list.data?.meta;
  const rows = list.data?.data ?? [];

  return (
    <>
      <PageHeader
        title={title}
        meta={counts.data ? t('pendingCount', { count: counts.data.pending }) : undefined}
      />
      <Card className="gap-0 py-0 shadow-none">
        <div className="flex flex-col gap-3 border-b p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
              <StatusTabs
                label={t('statusFilter')}
                value={tab === 'pending' ? '' : tab}
                onChange={(v) => params.set({ status: v || null })}
                options={TABS.map((s) => ({
                  value: s === 'pending' ? '' : s,
                  label: t(`tabs.${s}`),
                  count: meta?.counts[s === 'any' ? 'all' : s],
                }))}
              />
            </div>
            <FilterSelect
              label={t('type')}
              value={type ?? ''}
              allLabel={t('allTypes')}
              onChange={(v) => params.set({ type: v || null })}
              options={REQUEST_TYPES.map((r) => ({
                value: r,
                label:
                  REQUEST_TYPE_LABELS[r][locale] +
                  (counts.data?.byType[r] ? ` (${counts.data.byType[r]})` : ''),
              }))}
            />
          </div>
        </div>
        {list.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : list.isPending ? (
          <div className="flex flex-col gap-3 p-4" aria-busy="true">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            {type || tab !== 'pending' ? (
              <EmptyState
                icon={SearchXIcon}
                role="status"
                title={tl('noResults')}
                description={tl('noResultsHint')}
                action={
                  <Button
                    variant="outline"
                    onClick={() => params.set({ type: null, status: null })}
                  >
                    {tl('clearAll')}
                  </Button>
                }
              />
            ) : (
              <EmptyState icon={InboxIcon} title={t('empty')} description={t('emptyHint')} />
            )}
          </div>
        ) : (
          <ul aria-label={title} className="flex flex-col gap-3 p-3 sm:p-4">
            {rows.map((r) => (
              <li key={r.id}>
                <RequestCard request={r} />
              </li>
            ))}
          </ul>
        )}
        {meta && rows.length > 0 && (
          <ListPagination
            meta={meta}
            onPage={(page) => params.set({ page: page === 1 ? null : page }, { resetPage: false })}
            onPerPage={(perPage) => params.set({ perPage: perPage === 25 ? null : perPage })}
          />
        )}
      </Card>
      <SessionSheet />
    </>
  );
}

export function RequestCard({
  request: r,
  extra,
}: {
  request: SessionRequestDto;
  /** A line under the card (the next step in «طلباتي», the queue and SLA in the inbox). */
  extra?: ReactNode;
}) {
  const t = useTranslations('requests');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const now = useNow(60_000);
  const queryClient = useQueryClient();
  const message = useClassError();
  const { open } = useOpenSession();
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectError, setRejectError] = useState<string | null>(null);
  const s = r.session ?? null;
  const reject = useMutation({
    mutationFn: (note: string) => rejectRequest(r.id, { note }),
    onSuccess: () => {
      refreshClasses(queryClient);
      setRejecting(false);
      toast.success(t('done.rejected'));
    },
    onError: (e) => setRejectError(message(e)),
  });
  const withdraw = useMutation({
    mutationFn: () => cancelRequest(r.id),
    onSuccess: () => {
      refreshClasses(queryClient);
      toast.success(t('done.withdrawn'));
    },
    onError: (e) => toast.error(message(e)),
  });
  const overdue =
    r.status === 'pending' && r.dueAt && Date.parse(r.dueAt) - now.getTime() < 3 * 3_600_000;
  const role =
    r.requestedBy.role && t.has(`roles.${r.requestedBy.role}`)
      ? t(`roles.${r.requestedBy.role}`)
      : null;

  return (
    <Card className="flex-col gap-3 px-4 py-3 shadow-none md:flex-row md:items-start md:justify-between">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <RequestTypeBadge type={r.type} />
          <RequestStatusBadge status={r.status} />
          {overdue && <ToneBadge tone="orange" label={t('overdue')} />}
        </div>
        {s ? (
          <button
            type="button"
            onClick={() => open(s.id)}
            className="self-start text-start text-base font-bold text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
          >
            {r.student?.name ?? s.student.name}
          </button>
        ) : (
          <span className="font-bold">{r.student?.name}</span>
        )}
        <span className="text-sm text-muted-foreground">
          {r.requestedBy.name}
          {role && <> ({role})</>} ·{' '}
          <span title={dayAndClock(r.createdAt, tz, locale)}>
            {relativeTime(r.createdAt, now, locale)}
          </span>
        </span>
        {s && (
          <div className="flex flex-col gap-0.5 text-sm">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-muted-foreground">{t('current')}:</span>
              <bdi className="font-medium">{dayAndClock(s.startsAt, tz, locale)}</bdi>
              <OtherTime at={s.startsAt} tz={s.student.timezone} party="student" />
              <StageBadge session={s} />
            </span>
            {r.proposedStartsAt && (
              <span className="flex flex-wrap items-center gap-x-2">
                <span className="text-muted-foreground">{t('proposed')}:</span>
                <bdi className="font-medium">{dayAndClock(r.proposedStartsAt, tz, locale)}</bdi>
                <OtherTime at={r.proposedStartsAt} tz={s.student.timezone} party="student" />
              </span>
            )}
          </div>
        )}
        <p className="text-sm">
          <bdi>{r.reason}</bdi>
        </p>
        {r.decisionNote && (
          <p className="text-sm text-muted-foreground">
            {t('decisionNote')}: <bdi>{r.decisionNote}</bdi>
            {r.decidedBy?.name && <> — {r.decidedBy.name}</>}
          </p>
        )}
        {extra}
      </div>
      {r.allowedActions.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-2 md:flex-col md:items-stretch">
          {r.allowedActions.includes('approve') && (
            <Button onClick={() => setApproving(true)}>
              <CheckIcon />
              {t('actions.approve')}
              <span className="sr-only">: {r.student?.name}</span>
            </Button>
          )}
          {r.allowedActions.includes('reject') && (
            <Button
              variant="outline"
              className="text-destructive"
              onClick={() => {
                setRejectError(null);
                setRejecting(true);
              }}
            >
              <XIcon />
              {t('actions.reject')}
              <span className="sr-only">: {r.student?.name}</span>
            </Button>
          )}
          {r.allowedActions.includes('cancel') && (
            <Button
              variant="outline"
              disabled={withdraw.isPending}
              onClick={() => withdraw.mutate()}
            >
              <Undo2Icon />
              {t('actions.cancel')}
            </Button>
          )}
        </div>
      )}
      {approving && <ApproveDialog request={r} open onOpenChange={setApproving} />}
      <ReasonDialog
        open={rejecting}
        onOpenChange={setRejecting}
        destructive
        title={t('reject.title', { name: r.student?.name ?? '' })}
        description={t('reject.description')}
        confirmLabel={t('actions.reject')}
        textLabel={t('reject.note')}
        textRequired
        busy={reject.isPending}
        error={rejectError}
        onConfirm={(v) => reject.mutate(v.text)}
      />
    </Card>
  );
}
