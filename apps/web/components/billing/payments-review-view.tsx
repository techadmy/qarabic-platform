'use client';

import { PAYMENT_METHOD_LABELS, type PaymentDto } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { CircleCheckIcon, FlagIcon, ScaleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { ColumnMeta } from '@/components/data-table';
import { fixFirstColumn, useColumnVisibility } from '@/components/list/column-chooser';
import { RefreshFailed, refreshState } from '@/components/list/refresh-failed';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { ToneBadge } from '@/components/sessions/badges';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { billingKeys, fetchPaymentsToReview, reviewPayment } from '@/lib/api/billing';
import { can } from '@/lib/auth/use-me';
import { formatInstant } from '@/lib/time';
import { Money, PaymentStatusBadge, useBillingError } from './billing-bits';

/** The API returns at most this many (no paging yet): say so when the list is full. */
const MAX_ROWS = 500;

/**
 * «مدفوعات تحتاج مراجعة» (P1-3 BIL-5, P1-1 B115): payments the system did not settle by itself —
 * a capture in another amount or currency (held, nothing applied, in suspense) and payments beyond
 * what the invoice owed (kept as the family's credit). Billing staff resolve each one with the
 * provider or the family and record what they did; finance can read the list.
 */
export function PaymentsReviewView() {
  const t = useTranslations('billing.paymentsReview');
  const tr = useTranslations('billing.detail.reviewReason');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = useBillingError();
  const allowed = can(me, 'invoices.manage') || can(me, 'reports.financial');
  const manage = can(me, 'invoices.manage');
  const list = useQuery({
    queryKey: billingKeys.paymentsReview,
    queryFn: ({ signal }) => fetchPaymentsToReview(signal),
    enabled: allowed,
  });
  const live = refreshState(list);
  const [reviewing, setReviewing] = useState<PaymentDto | null>(null);
  const review = useMutation({
    mutationFn: (v: { id: number; note: string }) => reviewPayment(v.id, v.note),
    onSuccess: () => {
      setReviewing(null);
      void queryClient.invalidateQueries({ queryKey: billingKeys.all });
      toast.success(t('reviewed'));
    },
  });
  const [columnVisibility, setColumnVisibility] = useColumnVisibility(`payments-review:${me.id}`);

  const reason = (p: PaymentDto) =>
    p.reviewReason && tr.has(p.reviewReason) ? tr(p.reviewReason) : t('reasonOther');
  const captured = (p: PaymentDto) =>
    p.capturedAmount && p.capturedCurrency ? (
      <span className="flex items-center gap-1.5">
        <ScaleIcon aria-hidden className="size-4 text-muted-foreground" />
        <Money amount={p.capturedAmount} currency={p.capturedCurrency} />
      </span>
    ) : p.unapplied && p.unapplied !== '0.00' ? (
      <span className="text-sm">
        {t.rich('kept', {
          amount: () => <Money amount={p.unapplied} currency={p.currency} />,
        })}
      </span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  const action = (p: PaymentDto) =>
    manage ? (
      <Button
        variant="outline"
        size="sm"
        className="h-10 md:h-8"
        onClick={() => {
          review.reset();
          setReviewing(p);
        }}
      >
        <CircleCheckIcon />
        {t('markReviewed')}
        <span className="sr-only">: {t('invoice', { id: p.invoiceId })}</span>
      </Button>
    ) : null;

  const columns = useMemo<ColumnDef<PaymentDto, unknown>[]>(
    () => [
      {
        id: 'invoice',
        header: t('cols.invoice'),
        cell: ({ row }) => (
          <Link
            href={`/invoices/${row.original.invoiceId}`}
            className="font-semibold text-primary hover:underline"
          >
            {t('invoice', { id: row.original.invoiceId })}
          </Link>
        ),
      },
      {
        id: 'method',
        header: t('cols.method'),
        cell: ({ row }) => (
          <span className="flex flex-wrap items-center gap-1.5">
            {PAYMENT_METHOD_LABELS[row.original.method][locale]}
            <PaymentStatusBadge status={row.original.status} />
          </span>
        ),
      },
      {
        id: 'amount',
        header: t('cols.expected'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row }) => <Money amount={row.original.amount} currency={row.original.currency} />,
      },
      {
        id: 'captured',
        header: t('cols.captured'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row }) => captured(row.original),
      },
      {
        id: 'reason',
        header: t('cols.reason'),
        cell: ({ row }) => (
          <span className="flex max-w-64 flex-col items-start gap-1 whitespace-normal">
            <ToneBadge tone="orange" icon={FlagIcon} label={t('needsReview')} />
            <span className="text-sm text-muted-foreground">{reason(row.original)}</span>
          </span>
        ),
      },
      {
        id: 'received',
        header: t('cols.received'),
        cell: ({ row }) =>
          formatInstant(row.original.receivedAt ?? row.original.createdAt, tz, locale),
      },
      { id: 'action', header: t('cols.action'), cell: ({ row }) => action(row.original) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the cells read the latest helpers.
    [t, locale, tz, manage],
  );

  const header = <PageHeader title={t('title')} description={t('subtitle')} />;
  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        {header}
        <ForbiddenState />
      </>
    );
  }
  const rows = list.data ?? [];
  return (
    <>
      {header}
      {live.stale && <RefreshFailed onRetry={() => void list.refetch()} />}
      <Card className="gap-0 py-0 shadow-none">
        {rows.length >= MAX_ROWS && (
          <p role="status" className="border-b px-4 py-2 text-sm text-muted-foreground">
            {t('truncated', { count: MAX_ROWS })}
          </p>
        )}
        {live.failed ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : !list.isPending && rows.length === 0 ? (
          <div className="p-4">
            <EmptyState icon={CircleCheckIcon} title={t('empty')} description={t('emptyHint')} />
          </div>
        ) : (
          <ResponsiveList
            columns={fixFirstColumn(columns)}
            rows={rows}
            loading={list.isPending}
            label={t('title')}
            emptyText={t('empty')}
            getRowId={(p) => p.id}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={setColumnVisibility}
            renderCard={(p) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/invoices/${p.invoiceId}`} className="font-semibold text-primary">
                    {t('invoice', { id: p.invoiceId })}
                  </Link>
                  <Money amount={p.amount} currency={p.currency} />
                </div>
                <span className="flex flex-wrap items-center gap-1.5 text-sm">
                  {PAYMENT_METHOD_LABELS[p.method][locale]}
                  <PaymentStatusBadge status={p.status} />
                </span>
                <span className="text-sm">{reason(p)}</span>
                {captured(p)}
                <span className="text-sm text-muted-foreground">
                  {formatInstant(p.receivedAt ?? p.createdAt, tz, locale)}
                </span>
                {action(p)}
              </div>
            )}
          />
        )}
      </Card>
      <ReasonDialog
        open={!!reviewing}
        onOpenChange={(o) => !o && setReviewing(null)}
        title={t('reviewTitle', { id: reviewing?.invoiceId ?? 0 })}
        description={reviewing ? reason(reviewing) : undefined}
        confirmLabel={t('markReviewed')}
        textLabel={t('note')}
        textRequired
        textMin={3}
        busy={review.isPending}
        error={review.isError ? message(review.error) : null}
        onConfirm={({ text }) => reviewing && review.mutate({ id: reviewing.id, note: text })}
      />
    </>
  );
}
