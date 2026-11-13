'use client';

import type { PayrollRunDto, RunPreviewDto } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Spinner } from '@qarabic/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { BanknoteIcon, InfoIcon, WalletIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { ColumnMeta } from '@/components/data-table';
import { ListPagination } from '@/components/list/list-pagination';
import { fixFirstColumn, useColumnVisibility } from '@/components/list/column-chooser';
import { ListActions } from '@/components/list/list-actions';
import { ResponsiveList } from '@/components/list/responsive-list';
import { SplitList, SplitView, useSplitView } from '@/components/list/split-view';
import { PageHeader } from '@/components/page-header';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { createRun, fetchRuns, payrollKeys, previewRun } from '@/lib/api/payroll';
import { can } from '@/lib/auth/use-me';
import { monthLabel } from '@/lib/billing/labels';
import { useListParams } from '@/lib/list-params';
import { ACADEMY_TZ, defaultRunPeriod, isPeriod, periodIn } from '@/lib/payroll/labels';
import { FormDialog, FormRow, Money, RunStatusBadge, usePayrollError } from './payroll-bits';
import { MonthPicker } from '@/components/forms/date-time';
import { RunView } from './run-view';

export const runHref = (r: Pick<PayrollRunDto, 'id'>) => `/payroll/runs/${r.id}`;

/** Net per currency on one line ("12,500.00 EGP · 400.00 US$"). */
export function TotalsInline({ totals }: { totals: PayrollRunDto['totals'] }) {
  if (!totals.length) return <span className="text-muted-foreground">—</span>;
  return (
    // Inline, so an end-aligned (numeric) cell puts it at the end.
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
      {totals.map((x) => (
        <Money key={x.currency} amount={x.net} currency={x.currency} />
      ))}
    </span>
  );
}

/**
 * «مسيّرات الرواتب» (docs/21 §13; the current app's `SalariesPage` for payroll staff): one row per
 * month with its status, people, net per currency, how many were paid and the issues; the primary
 * action creates the month's run (preview first, nothing stored until «أنشئ المسيّر»).
 */
export function RunsView() {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const split = useSplitView('/payroll');
  // The run's own page is /payroll/runs/:id; from 1024 px it opens beside the list (`?id=`).
  const rowHref = (r: Pick<PayrollRunDto, 'id'>) => (split.wide ? split.hrefFor(r.id) : runHref(r));
  const [columnVisibility, setColumnVisibility] = useColumnVisibility(`payroll-runs:${me.id}`);
  const params = useListParams();
  const allowed =
    can(me, 'payroll.manage') || can(me, 'payroll.review') || can(me, 'payroll.approve');
  const manage = can(me, 'payroll.manage');
  const [creating, setCreating] = useState(false);
  const query = { page: params.page, perPage: 24 };
  const list = useQuery({
    queryKey: payrollKeys.runs(query),
    queryFn: ({ signal }) => fetchRuns(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  const rows = useMemo(() => list.data?.data ?? [], [list.data]);
  const meta = list.data?.meta;
  // Rebuilt each render: the row link follows the split view (`?id=` on wide screens).
  const columns: ColumnDef<PayrollRunDto, unknown>[] = [
    {
      id: 'month',
      header: t('month'),
      enableHiding: false,
      cell: ({ row: { original: r } }) => (
        <Link href={rowHref(r)} className="font-semibold text-primary hover:underline">
          {monthLabel(r.period, locale)}
        </Link>
      ),
    },
    {
      id: 'status',
      header: t('status'),
      cell: ({ row: { original: r } }) => <RunStatusBadge status={r.status} />,
    },
    {
      id: 'people',
      header: t('runs.people'),
      meta: { numeric: true } satisfies ColumnMeta,
      cell: ({ row: { original: r } }) => <bdi>{r.people}</bdi>,
    },
    {
      id: 'net',
      header: t('runs.net'),
      // Money is end-aligned (docs/15 §5.13).
      meta: { numeric: true } satisfies ColumnMeta,
      cell: ({ row: { original: r } }) => <TotalsInline totals={r.totals} />,
    },
    {
      id: 'paid',
      header: t('runs.paidPeople'),
      meta: { numeric: true } satisfies ColumnMeta,
      cell: ({ row: { original: r } }) => (
        <bdi>{t('runs.paidOf', { paid: r.paidPeople, total: r.people })}</bdi>
      ),
    },
    {
      id: 'issues',
      header: t('runs.issues'),
      meta: { numeric: true } satisfies ColumnMeta,
      cell: ({ row: { original: r } }) =>
        r.errorCount || r.warningCount ? (
          <bdi className={r.errorCount ? 'font-semibold text-destructive' : undefined}>
            {r.errorCount} / {r.warningCount}
          </bdi>
        ) : (
          '—'
        ),
    },
  ];

  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('runs.title')} />
        <ForbiddenState />
      </>
    );
  }

  const header = (
    <PageHeader
      title={t('runs.title')}
      meta={meta ? t('runs.count', { count: meta.total }) : undefined}
      actions={
        <ListActions
          create={manage ? { label: t('runs.new'), onClick: () => setCreating(true) } : undefined}
          more={
            can(me, 'payroll.view')
              ? [{ label: t('runs.mine'), icon: WalletIcon, href: '/payroll/me' }]
              : []
          }
        />
      }
    />
  );
  const pagination = meta && rows.length > 0 && meta.lastPage > 1 && (
    <ListPagination
      meta={meta}
      onPage={(page) => params.set({ page: page === 1 ? null : page }, { resetPage: false })}
      onPerPage={() => undefined}
    />
  );

  if (split.selectedId) {
    return (
      <>
        {header}
        <SplitView
          selectedId={split.selectedId}
          wide={split.wide}
          detailLabel={t('runs.detail')}
          onClose={split.close}
          fullHref={`/payroll/runs/${split.selectedId}`}
          list={
            <SplitList
              rows={rows}
              loading={list.isPending}
              label={t('runs.table')}
              emptyText={t('runs.none')}
              getRowId={(r) => r.id}
              hrefFor={split.hrefFor}
              selectedId={split.selectedId}
              footer={pagination}
              renderItem={(r) => (
                <span className="flex flex-col gap-1">
                  <span className="flex items-start justify-between gap-2">
                    <span className="font-semibold">{monthLabel(r.period, locale)}</span>
                    <RunStatusBadge status={r.status} />
                  </span>
                  <span className="line-clamp-1 text-sm text-muted-foreground">
                    <TotalsInline totals={r.totals} />
                  </span>
                </span>
              )}
            />
          }
          detail={<RunView key={split.selectedId} id={Number(split.selectedId)} />}
        />
        {creating && (
          <NewRunDialog open onOpenChange={setCreating} existing={rows.map((r) => r.period)} />
        )}
      </>
    );
  }

  return (
    <>
      {header}
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        {t('runs.noMoneyMoves')}
      </p>
      <Card className="gap-0 py-0 shadow-none">
        {list.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : !list.isPending && rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={BanknoteIcon}
              title={t('runs.none')}
              description={t('runs.noneHint')}
              action={
                manage ? (
                  <Button onClick={() => setCreating(true)}>{t('runs.new')}</Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <ResponsiveList
            columns={fixFirstColumn(columns)}
            rows={rows}
            loading={list.isPending}
            label={t('runs.table')}
            emptyText={t('runs.none')}
            getRowId={(r) => r.id}
            getRowHref={rowHref}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={setColumnVisibility}
            renderCard={(r) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold text-primary">{monthLabel(r.period, locale)}</span>
                  <RunStatusBadge status={r.status} />
                </div>
                <span className="text-sm">
                  <TotalsInline totals={r.totals} />
                </span>
                <span className="text-sm text-muted-foreground">
                  {t('runs.paidPeople')}:{' '}
                  <bdi>{t('runs.paidOf', { paid: r.paidPeople, total: r.people })}</bdi>
                </span>
              </div>
            )}
          />
        )}
        {pagination}
      </Card>
      {creating && (
        <NewRunDialog open onOpenChange={setCreating} existing={rows.map((r) => r.period)} />
      )}
    </>
  );
}

/** Create a month's run: pick the month, preview (computed now, nothing stored), create. */
export function NewRunDialog({
  open,
  onOpenChange,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: string[];
}) {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  const router = useRouter();
  const queryClient = useQueryClient();
  const message = usePayrollError();
  const monthId = useId();
  const current = periodIn(ACADEMY_TZ);
  const [period, setPeriod] = useState(() => defaultRunPeriod(existing, current) ?? current);
  const [preview, setPreview] = useState<RunPreviewDto | null>(null);
  const [touched, setTouched] = useState(false);
  const valid = isPeriod(period) && period <= current;
  const load = useMutation({
    mutationFn: () => previewRun(period),
    onSuccess: setPreview,
  });
  const create = useMutation({
    mutationFn: () => createRun(period),
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: payrollKeys.all });
      toast.success(t('newRun.created', { month: monthLabel(run.period, locale) }));
      onOpenChange(false);
      router.push(runHref(run));
    },
  });
  const failure = create.error ?? load.error;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={t('newRun.title')}
      description={t('newRun.description')}
      submitLabel={t('newRun.create')}
      busy={create.isPending}
      error={failure ? message(failure) : null}
      summary={touched && !valid ? t('form.fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (valid) create.mutate();
      }}
      extraActions={
        <Button
          type="button"
          variant="outline"
          disabled={!valid || load.isPending}
          onClick={() => {
            create.reset();
            load.mutate();
          }}
        >
          {load.isPending && <Spinner />}
          {t('newRun.preview')}
        </Button>
      }
    >
      <FormRow
        id={monthId}
        label={t('newRun.month')}
        required
        error={touched && !valid ? t('newRun.monthInvalid') : null}
      >
        <MonthPicker
          id={monthId}
          max={current}
          value={period}
          onChange={(v) => {
            setPeriod(v);
            setPreview(null);
          }}
          invalid={touched && !valid}
          className="w-full sm:w-56"
        />
      </FormRow>
      {preview && preview.period === period && <PreviewTable preview={preview} />}
    </FormDialog>
  );
}

function PreviewTable({ preview }: { preview: RunPreviewDto }) {
  const t = useTranslations('payroll');
  const locale = useUiLocale();
  return (
    <section role="status" className="flex min-w-0 flex-col gap-2">
      <h3 className="font-semibold">
        {t('newRun.previewTitle', { month: monthLabel(preview.period, locale) })} ·{' '}
        {t('newRun.previewPeople', { count: preview.payslips.length })}
      </h3>
      <p className="text-sm text-muted-foreground">{t('newRun.previewHint')}</p>
      {preview.totals.length > 0 && (
        <Alert>
          <AlertDescription className="flex flex-wrap gap-x-4 gap-y-1">
            {preview.totals.map((x) => (
              <span key={x.currency}>
                {t('runs.net')}: <Money amount={x.net} currency={x.currency} strong />
              </span>
            ))}
          </AlertDescription>
        </Alert>
      )}
      <div className="max-h-64 overflow-auto rounded-md border">
        <Table aria-label={t('newRun.previewTable')} className="tabular-nums">
          <TableHeader className="sticky top-0 bg-subtle">
            <TableRow>
              <TableHead className="text-start">{t('person')}</TableHead>
              <TableHead className="text-end">{t('run.net')}</TableHead>
              <TableHead className="text-start">{t('run.warnings')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {preview.payslips.map((s) => (
              <TableRow key={s.user.id}>
                <TableCell className="text-start">{s.user.name}</TableCell>
                <TableCell className="text-end">
                  <Money amount={s.net} currency={s.currency} />
                </TableCell>
                <TableCell className="text-start">
                  <bdi>{s.errors.length + s.warnings.length || '—'}</bdi>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
