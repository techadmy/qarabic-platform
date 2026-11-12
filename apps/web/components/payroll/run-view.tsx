'use client';

import { SALARY_TYPE_LABELS, isLockedRun, type PayslipDto } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import {
  BadgeCheckIcon,
  ClipboardCheckIcon,
  FileXIcon,
  LockIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  Undo2Icon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { ColumnMeta } from '@/components/data-table';
import { StatusTabs } from '@/components/list/list-toolbar';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { KeyFacts } from '@/components/people/detail';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchRun, payrollKeys, runAction, type RunAction } from '@/lib/api/payroll';
import { can } from '@/lib/auth/use-me';
import { monthLabel } from '@/lib/billing/labels';
import { formatInstant } from '@/lib/time';
import { Hours, Money, PayslipStatusBadge, RunStatusBadge, usePayrollError } from './payroll-bits';

type Filter = '' | 'issues' | 'unpaid';
export const payslipHref = (s: Pick<PayslipDto, 'id'>) => `/payroll/payslips/${s.id}`;

/**
 * One month's run (docs/21 §7, §13; the current app's `RunPage`): status and who did what, the
 * actions the API allows this viewer (`can`: recompute, review, approve, reopen with a reason),
 * the KPI strip (people, net and paid per currency, issues) and the payslips (filter: with
 * warnings, not paid), each opening its payslip. Approve and reopen confirm with a named button.
 */
export function RunView({ id }: { id: number }) {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = usePayrollError();
  const allowed =
    can(me, 'payroll.manage') || can(me, 'payroll.review') || can(me, 'payroll.approve');
  const [open, setOpen] = useState<RunAction | null>(null);
  const [filter, setFilter] = useState<Filter>('');
  const query = useQuery({
    queryKey: payrollKeys.run(id),
    queryFn: ({ signal }) => fetchRun(id, signal),
    enabled: allowed && Number.isInteger(id) && id > 0,
  });
  const act = useMutation({
    mutationFn: (v: { action: RunAction; note?: string }) => runAction(id, v.action, v.note),
    onSuccess: (_, v) => {
      void queryClient.invalidateQueries({ queryKey: payrollKeys.all });
      setOpen(null);
      toast.success(
        t(
          `run.${v.action === 'recompute' ? 'recomputed' : v.action === 'review' ? 'reviewed' : v.action === 'approve' ? 'approved' : 'reopened'}`,
        ),
      );
    },
    onError: (e, v) => {
      if (v.action === 'recompute') toast.error(message(e));
    },
  });

  const slips = useMemo(() => query.data?.payslips ?? [], [query.data]);
  const shown = useMemo(
    () =>
      slips.filter((s) =>
        filter === 'issues'
          ? s.errors.length + s.warnings.length > 0
          : filter === 'unpaid'
            ? s.status !== 'paid'
            : true,
      ),
    [slips, filter],
  );
  const num = { numeric: true } satisfies ColumnMeta;
  const columns = useMemo<ColumnDef<PayslipDto, unknown>[]>(
    () => [
      {
        id: 'person',
        header: t('person'),
        cell: ({ row: { original: s } }) => (
          <Link href={payslipHref(s)} className="font-semibold text-primary hover:underline">
            {s.user.name}
          </Link>
        ),
      },
      {
        id: 'type',
        header: t('run.type'),
        cell: ({ row: { original: s } }) => SALARY_TYPE_LABELS[s.salaryType][locale],
      },
      {
        id: 'hours',
        header: t('run.hours'),
        meta: num,
        cell: ({ row: { original: s } }) => <Hours value={s.paidHours} />,
      },
      {
        id: 'earnings',
        header: t('run.earnings'),
        meta: num,
        cell: ({ row: { original: s } }) => <Money amount={s.earnings} currency={s.currency} />,
      },
      {
        id: 'deductions',
        header: t('run.deductions'),
        meta: num,
        cell: ({ row: { original: s } }) => <Money amount={s.deductions} currency={s.currency} />,
      },
      {
        id: 'net',
        header: t('run.net'),
        meta: num,
        cell: ({ row: { original: s } }) => <Money amount={s.net} currency={s.currency} strong />,
      },
      {
        id: 'status',
        header: t('status'),
        cell: ({ row: { original: s } }) => <PayslipStatusBadge status={s.status} />,
      },
      {
        id: 'issues',
        header: t('run.warnings'),
        meta: num,
        cell: ({ row: { original: s } }) => <IssueCount slip={s} />,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `num` is a constant
    [t, locale],
  );

  const back = { href: '/payroll', label: t('run.back') };
  if (!allowed || isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={t('runs.title')} back={back} />
        <ForbiddenState />
      </>
    );
  }
  if (isApiError(query.error, 404)) {
    return (
      <>
        <PageHeader title={t('run.notFoundTitle')} back={back} />
        <EmptyState
          icon={FileXIcon}
          role="alert"
          title={t('run.notFoundTitle')}
          description={t('run.notFound')}
        />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title={t('runs.title')} back={back} />
        <ErrorState onRetry={() => void query.refetch()} />
      </>
    );
  }
  const run = query.data;
  if (!run) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  const month = monthLabel(run.period, locale);
  const c = run.can;
  const busy = act.isPending;
  const metaBits = [
    run.computedAt &&
      t('run.computedAt', { time: formatInstant(run.computedAt, tz, locale) ?? '' }),
    run.reviewedBy && t('run.reviewedBy', { name: run.reviewedBy.name }),
    run.approvedBy && t('run.approvedBy', { name: run.approvedBy.name }),
  ].filter(Boolean);

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {t('run.title', { month })}
            <RunStatusBadge status={run.status} />
          </span>
        }
        meta={metaBits.join(' · ')}
        actions={
          <>
            {c.recompute && (
              <Button
                variant="outline"
                className="h-10"
                disabled={busy}
                onClick={() => act.mutate({ action: 'recompute' })}
              >
                <RefreshCwIcon />
                {t('run.recompute')}
              </Button>
            )}
            {c.review && (
              <Button className="h-10" disabled={busy} onClick={() => setOpen('review')}>
                <ClipboardCheckIcon />
                {t('run.review')}
              </Button>
            )}
            {c.approve && (
              <Button className="h-10" disabled={busy} onClick={() => setOpen('approve')}>
                <BadgeCheckIcon />
                {t('run.approve')}
              </Button>
            )}
            {c.reopen && (
              <Button
                variant="outline"
                className="h-10"
                disabled={busy}
                onClick={() => setOpen('reopen')}
              >
                <Undo2Icon />
                {t('run.reopen')}
              </Button>
            )}
          </>
        }
      />
      {isLockedRun(run.status) && (
        <Alert>
          <LockIcon />
          <AlertDescription>{t('run.lockedHint')}</AlertDescription>
        </Alert>
      )}
      {run.errorCount > 0 && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertDescription>{t('run.blocked')}</AlertDescription>
        </Alert>
      )}
      <KeyFacts
        items={[
          { label: t('run.kpiPeople'), value: <bdi>{run.people}</bdi> },
          ...run.totals.flatMap((x) => [
            {
              label: t('run.kpiNet', { currency: x.currency }),
              value: <Money amount={x.net} currency={x.currency} />,
            },
          ]),
          ...(isLockedRun(run.status)
            ? run.totals.map((x) => ({
                label: t('run.kpiPaid', { currency: x.currency }),
                value: <Money amount={x.paid} currency={x.currency} />,
              }))
            : []),
          {
            label: t('run.kpiIssues'),
            value: (
              <bdi className={run.errorCount ? 'text-destructive' : undefined}>
                {run.errorCount} / {run.warningCount}
              </bdi>
            ),
          },
        ]}
      />
      <Card className="gap-0 py-0 shadow-none">
        <div className="flex flex-col gap-3 border-b p-4">
          <h2 className="text-base font-bold">{t('run.slips')}</h2>
          <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
            <StatusTabs
              label={t('run.filter')}
              value={filter}
              onChange={(v) => setFilter(v as Filter)}
              options={[
                { value: '', label: t('run.filterAll'), count: slips.length },
                {
                  value: 'issues',
                  label: t('run.filterIssues'),
                  count: slips.filter((s) => s.errors.length + s.warnings.length > 0).length,
                },
                {
                  value: 'unpaid',
                  label: t('run.filterUnpaid'),
                  count: slips.filter((s) => s.status !== 'paid').length,
                },
              ]}
            />
          </div>
        </div>
        <ResponsiveList
          columns={columns}
          rows={shown}
          label={t('run.slips')}
          emptyText={t('run.noSlips')}
          getRowId={(s) => s.id}
          getRowHref={payslipHref}
          renderCard={(s) => (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 font-semibold text-primary">{s.user.name}</span>
                <PayslipStatusBadge status={s.status} />
              </div>
              <span className="text-sm text-muted-foreground">
                {SALARY_TYPE_LABELS[s.salaryType][locale]} · {t('run.hours')}:{' '}
                <Hours value={s.paidHours} />
              </span>
              <span className="text-sm">
                {t('run.net')}: <Money amount={s.net} currency={s.currency} strong />
              </span>
              {s.errors.length + s.warnings.length > 0 && <IssueCount slip={s} />}
            </div>
          )}
        />
      </Card>
      {(open === 'review' || open === 'approve') && (
        <ReasonDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setOpen(null);
              act.reset();
            }
          }}
          title={open === 'review' ? t('run.reviewTitle', { month }) : t('run.approveTitle')}
          description={
            open === 'review' ? (
              t('run.reviewBody')
            ) : (
              <>
                {t('run.approveBody', { month })}{' '}
                {run.totals.map((x, i) => (
                  <span key={x.currency}>
                    {i > 0 && ' · '}
                    <Money amount={x.net} currency={x.currency} strong />
                  </span>
                ))}
              </>
            )
          }
          confirmLabel={open === 'review' ? t('run.review') : t('run.approve')}
          busy={busy}
          error={act.isError ? message(act.error) : null}
          onConfirm={() => act.mutate({ action: open })}
        />
      )}
      {open === 'reopen' && (
        <ReasonDialog
          open
          destructive
          onOpenChange={(o) => {
            if (!o) {
              setOpen(null);
              act.reset();
            }
          }}
          title={t('run.reopenTitle', { month })}
          description={t('run.reopenBody')}
          confirmLabel={t('run.reopen')}
          textLabel={t('reason')}
          textRequired
          textMin={3}
          busy={busy}
          error={act.isError ? message(act.error) : null}
          onConfirm={({ text }) => act.mutate({ action: 'reopen', note: text })}
        />
      )}
    </>
  );
}

function IssueCount({ slip }: { slip: PayslipDto }) {
  const errors = slip.errors.length;
  const warnings = slip.warnings.length;
  if (!errors && !warnings) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={
        errors
          ? 'flex items-center gap-1 font-semibold text-destructive'
          : 'flex items-center gap-1'
      }
    >
      <TriangleAlertIcon className="size-4" aria-hidden />
      <bdi>{errors ? `${errors} / ${warnings}` : warnings}</bdi>
    </span>
  );
}
