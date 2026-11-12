'use client';

import {
  ADJUSTMENT_STATUSES,
  ADJUSTMENT_STATUS_LABELS,
  ADJUSTMENT_TYPE_LABELS,
  ADJUSTMENT_TYPES,
  type AdjustmentDto,
  type AdjustmentStatus,
  type AdjustmentType,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { BanIcon, CheckIcon, FileWarningIcon, LockIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { ColumnMeta } from '@/components/data-table';
import { ListPagination } from '@/components/list/list-pagination';
import { FilterSelect, StatusTabs } from '@/components/list/list-toolbar';
import { fixFirstColumn, useColumnVisibility } from '@/components/list/column-chooser';
import { ListActions } from '@/components/list/list-actions';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import {
  cancelAdjustment,
  decideAdjustment,
  fetchAdjustments,
  payrollKeys,
} from '@/lib/api/payroll';
import { can } from '@/lib/auth/use-me';
import { monthLabel } from '@/lib/billing/labels';
import { useListParams } from '@/lib/list-params';
import { creatableTypes, finesNeedApproval } from '@/lib/payroll/forms';
import { formatDate } from '@/lib/time';
import { AdjustmentDialog } from './dialogs';
import { AdjustmentStatusBadge, Money, usePayrollError } from './payroll-bits';

type Act = { item: AdjustmentDto; action: 'approve' | 'reject' | 'cancel' | 'waive' };

/** A signed amount: deductions with a minus sign (docs/15 §5.13). */
function Signed({ item }: { item: AdjustmentDto }) {
  return (
    <span className={item.sign === -1 ? 'text-destructive' : undefined}>
      <Money amount={item.sign === -1 ? `-${item.amount}` : item.amount} currency={item.currency} />
    </span>
  );
}

/**
 * «الغرامات والبنود» (docs/21 §6, §13; the current app's `FinesPage`): the queue of fines (and,
 * for payroll staff, every pay item) with status tabs and counts, proposed first. Monitors propose
 * fines; managers approve, reject or waive (a fine of an approved month becomes a fine reduction
 * in the first open month); payroll staff add bonuses, advances and the rest. A reason is always
 * required. Teachers see their own decided items, read-only.
 */
export function FinesView() {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const [columnVisibility, setColumnVisibility] = useColumnVisibility(`fines:${me.id}`);
  const params = useListParams();
  const queryClient = useQueryClient();
  const message = usePayrollError();
  const allowed = can(me, 'fines.view') || can(me, 'payroll.view');
  const payrollStaff =
    can(me, 'payroll.manage') || can(me, 'payroll.review') || can(me, 'payroll.approve');
  const fineStaff = can(me, 'fines.request') || can(me, 'fines.manage') || can(me, 'fines.approve');
  const staff = payrollStaff || fineStaff;
  const types = creatableTypes(me.permissions);
  const [adding, setAdding] = useState(false);
  const [acting, setActing] = useState<Act | null>(null);
  const statusParam = params.get('status') as AdjustmentStatus;
  const status = ADJUSTMENT_STATUSES.includes(statusParam) ? statusParam : undefined;
  const typeParam = params.get('type') as AdjustmentType;
  const type = ADJUSTMENT_TYPES.includes(typeParam) ? typeParam : undefined;
  const query = { status, type, page: params.page, perPage: params.perPage };
  const list = useQuery({
    queryKey: payrollKeys.adjustments(query),
    queryFn: ({ signal }) => fetchAdjustments(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: payrollKeys.all });
  const act = useMutation({
    mutationFn: async (v: Act & { note: string | null }) => {
      if (v.action === 'approve' || v.action === 'reject') {
        await decideAdjustment(v.item.id, v.action, v.note);
        return null;
      }
      return cancelAdjustment(v.item.id, v.note ?? '');
    },
    onSuccess: (result, v) => {
      refresh();
      setActing(null);
      toast.success(
        result?.reduction
          ? t('fines.waivedLater')
          : t(
              `fines.${v.action === 'approve' ? 'approved' : v.action === 'reject' ? 'rejected' : 'cancelled'}`,
            ),
      );
    },
  });

  const title = !staff
    ? t('fines.myTitle')
    : payrollStaff
      ? t('fines.title')
      : t('fines.finesTitle');
  const rows = useMemo(() => list.data?.data ?? [], [list.data]);
  const meta = list.data?.meta;

  const columns = useMemo<ColumnDef<AdjustmentDto, unknown>[]>(
    () => [
      ...(staff
        ? [
            {
              id: 'person',
              header: t('person'),
              cell: ({ row: { original: a } }) => (
                <span className="font-semibold">{a.user.name}</span>
              ),
            } satisfies ColumnDef<AdjustmentDto, unknown>,
          ]
        : []),
      {
        id: 'type',
        header: t('fines.type'),
        cell: ({ row: { original: a } }) => ADJUSTMENT_TYPE_LABELS[a.type][locale],
      },
      {
        id: 'amount',
        header: t('amount'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: a } }) => <Signed item={a} />,
      },
      {
        id: 'date',
        header: t('date'),
        cell: ({ row: { original: a } }) => (
          <span className="whitespace-nowrap">{formatDate(a.effectiveOn, locale)}</span>
        ),
      },
      {
        id: 'reason',
        header: t('reason'),
        cell: ({ row: { original: a } }) => <ReasonCell item={a} />,
      },
      {
        id: 'status',
        header: t('status'),
        cell: ({ row: { original: a } }) => (
          <span className="flex flex-col items-start gap-1">
            <AdjustmentStatusBadge status={a.status} />
            {a.locked && (
              <span className="flex items-center gap-1 text-caption text-muted-foreground">
                <LockIcon className="size-3.5" aria-hidden />
                {t('fines.locked')}
              </span>
            )}
          </span>
        ),
      },
      ...(staff
        ? [
            {
              id: 'actions',
              header: t('actions'),
              cell: ({ row: { original: a } }) => <RowActions item={a} onAction={setActing} />,
            } satisfies ColumnDef<AdjustmentDto, unknown>,
          ]
        : []),
    ],
    [t, locale, staff],
  );

  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={title} />
        <ForbiddenState />
      </>
    );
  }

  const proposing = finesNeedApproval(me.permissions) && !can(me, 'payroll.manage');
  const addLabel =
    types.length > 1 ? t('fines.add') : proposing ? t('fines.propose') : t('fines.addFine');
  const typeOptions = (payrollStaff ? ADJUSTMENT_TYPES : (['fine', 'fine_reduction'] as const)).map(
    (x) => ({
      value: x,
      label: ADJUSTMENT_TYPE_LABELS[x][locale],
    }),
  );
  const actName = acting
    ? { type: ADJUSTMENT_TYPE_LABELS[acting.item.type][locale], name: acting.item.user.name }
    : { type: '', name: '' };

  return (
    <>
      <PageHeader
        title={title}
        actions={
          <ListActions
            create={
              types.length > 0 ? { label: addLabel, onClick: () => setAdding(true) } : undefined
            }
          />
        }
      />
      <Card className="gap-0 py-0 shadow-none">
        <div className="flex flex-col gap-3 border-b p-4">
          {staff && (
            <div className="flex flex-wrap items-end gap-3">
              <FilterSelect
                label={t('fines.type')}
                value={type ?? ''}
                onChange={(v) => params.set({ type: v || null })}
                allLabel={t('fines.allTypes')}
                options={typeOptions}
                className="flex min-w-48 flex-col gap-1.5"
              />
            </div>
          )}
          <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
            <StatusTabs
              label={t('fines.tabs')}
              value={status ?? ''}
              onChange={(v) => params.set({ status: v || null })}
              options={[
                { value: '', label: t('fines.all'), count: meta?.counts.all },
                ...ADJUSTMENT_STATUSES.map((s) => ({
                  value: s,
                  label: ADJUSTMENT_STATUS_LABELS[s][locale],
                  count: meta?.counts[s],
                })),
              ]}
            />
          </div>
        </div>
        {list.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : !list.isPending && rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={FileWarningIcon}
              title={staff ? t('fines.none') : t('fines.noneMine')}
              description={t('fines.noneHint')}
            />
          </div>
        ) : (
          <ResponsiveList
            columns={fixFirstColumn(columns)}
            rows={rows}
            loading={list.isPending}
            label={t('fines.table')}
            emptyText={t('fines.none')}
            getRowId={(a) => a.id}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={setColumnVisibility}
            renderCard={(a) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-semibold">
                    {staff ? a.user.name : ADJUSTMENT_TYPE_LABELS[a.type][locale]}
                  </span>
                  <AdjustmentStatusBadge status={a.status} />
                </div>
                <span className="text-sm">
                  {staff && `${ADJUSTMENT_TYPE_LABELS[a.type][locale]} · `}
                  <Signed item={a} /> · {formatDate(a.effectiveOn, locale)}
                </span>
                <ReasonCell item={a} />
                {staff && <RowActions item={a} onAction={setActing} />}
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
      {adding && <AdjustmentDialog open onOpenChange={setAdding} />}
      {acting && (
        <ReasonDialog
          open
          destructive={acting.action !== 'approve'}
          onOpenChange={(o) => {
            if (!o) {
              setActing(null);
              act.reset();
            }
          }}
          title={
            acting.action === 'waive'
              ? t('fines.waiveTitle', { name: actName.name })
              : t(`fines.${acting.action}Title`, actName)
          }
          description={
            acting.action === 'approve'
              ? t('fines.approveBody', {
                  month: monthLabel(acting.item.effectiveOn.slice(0, 7), locale),
                })
              : t(`fines.${acting.action}Body`)
          }
          confirmLabel={t(`fines.${acting.action}`)}
          textLabel={acting.action === 'approve' ? t('note') : t('reason')}
          textRequired={acting.action !== 'approve'}
          textMin={acting.action === 'approve' ? undefined : 3}
          busy={act.isPending}
          error={act.isError ? message(act.error) : null}
          onConfirm={({ text }) => act.mutate({ ...acting, note: text || null })}
        />
      )}
    </>
  );
}

function ReasonCell({ item: a }: { item: AdjustmentDto }) {
  const t = useTranslations('payroll.fines');
  return (
    <span className="flex max-w-80 min-w-0 flex-col text-sm whitespace-normal">
      <span className="break-words" dir="auto">
        {a.reason}
      </span>
      {(a.sessionId || (a.status === 'proposed' && a.createdBy)) && (
        <span className="text-muted-foreground">
          {a.sessionId && t('class', { id: a.sessionId })}
          {a.sessionId && a.status === 'proposed' && a.createdBy && ' · '}
          {a.status === 'proposed' && a.createdBy && t('proposedBy', { name: a.createdBy.name })}
        </span>
      )}
      {a.decisionNote && (
        <span className="break-words text-muted-foreground" dir="auto">
          {t('decisionNote')}: <bdi>{a.decisionNote}</bdi>
        </span>
      )}
    </span>
  );
}

function RowActions({ item: a, onAction }: { item: AdjustmentDto; onAction: (x: Act) => void }) {
  const t = useTranslations('payroll.fines');
  const name = a.user.name;
  if (!a.can.decide && !a.can.cancel) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {a.can.decide && (
        <>
          <Button
            size="sm"
            className="h-8"
            aria-label={`${t('approve')}: ${name}`}
            onClick={() => onAction({ item: a, action: 'approve' })}
          >
            <CheckIcon />
            {t('approve')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            aria-label={`${t('reject')}: ${name}`}
            onClick={() => onAction({ item: a, action: 'reject' })}
          >
            <XIcon />
            {t('reject')}
          </Button>
        </>
      )}
      {a.can.cancel && (
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          aria-label={`${a.locked ? t('waive') : t('cancel')}: ${name}`}
          onClick={() => onAction({ item: a, action: a.locked ? 'waive' : 'cancel' })}
        >
          <BanIcon />
          {a.locked ? t('waive') : t('cancel')}
        </Button>
      )}
    </div>
  );
}
