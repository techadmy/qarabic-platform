'use client';

import {
  FAMILY_CREDIT_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  type FamilyCreditDto,
  type FamilyCreditStatus,
  type PaymentMethod,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { CheckIcon, CircleCheckIcon, FlagIcon, PiggyBankIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { fixFirstColumn, useColumnVisibility } from '@/components/list/column-chooser';
import { StatusTabs } from '@/components/list/list-toolbar';
import { RefreshFailed, refreshState } from '@/components/list/refresh-failed';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { ToneBadge } from '@/components/sessions/badges';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { billingKeys, fetchFamilyCredits, reviewFamilyCredit } from '@/lib/api/billing';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { formatInstant } from '@/lib/time';
import { Money, useBillingError } from './billing-bits';

type View = 'review' | 'open' | 'all';
const VIEWS: View[] = ['review', 'open', 'all'];

const STATUS_TONE: Record<FamilyCreditStatus, 'green' | 'grey' | 'brown'> = {
  open: 'green',
  used: 'grey',
  refunded: 'brown',
};

/**
 * «الأرصدة الدائنة للأسر» (P1-1, B115): money a family paid beyond an invoice, kept as their credit
 * and used on the next invoice. Billing staff look at each new one (why it came in, from which
 * payment) and mark it reviewed with an optional note; finance can read the list.
 */
export function CreditsView() {
  const t = useTranslations('billing.credits');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const params = useListParams();
  const queryClient = useQueryClient();
  const message = useBillingError();
  const allowed = can(me, 'invoices.manage') || can(me, 'reports.financial');
  const manage = can(me, 'invoices.manage');
  const view: View = VIEWS.includes(params.get('view') as View)
    ? (params.get('view') as View)
    : 'review';
  const query =
    view === 'review' ? { needsReview: true } : view === 'open' ? { status: 'open' as const } : {};
  const list = useQuery({
    queryKey: billingKeys.credits(query),
    queryFn: ({ signal }) => fetchFamilyCredits(query, signal),
    enabled: allowed,
  });
  const live = refreshState(list);
  const [reviewing, setReviewing] = useState<FamilyCreditDto | null>(null);
  const review = useMutation({
    mutationFn: (v: { id: number; note: string | null }) => reviewFamilyCredit(v.id, v.note),
    onSuccess: (c) => {
      setReviewing(null);
      void queryClient.invalidateQueries({ queryKey: billingKeys.all });
      toast.success(t('reviewed', { name: c.family.name }));
    },
  });
  const [columnVisibility, setColumnVisibility] = useColumnVisibility(`credits:${me.id}`);

  const source = (c: FamilyCreditDto) =>
    c.sourcePayment ? (
      <Link
        href={`/invoices/${c.sourcePayment.invoiceId}`}
        className="text-primary hover:underline"
      >
        {t('fromInvoice', {
          id: c.sourcePayment.invoiceId,
          method:
            PAYMENT_METHOD_LABELS[c.sourcePayment.method as PaymentMethod]?.[locale] ??
            c.sourcePayment.method,
        })}
      </Link>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  const state = (c: FamilyCreditDto) => (
    <span className="flex flex-wrap gap-1.5">
      <ToneBadge
        tone={STATUS_TONE[c.status]}
        icon={c.status === 'open' ? PiggyBankIcon : CheckIcon}
        label={FAMILY_CREDIT_STATUS_LABELS[c.status][locale]}
      />
      {!c.reviewedAt && <ToneBadge tone="orange" icon={FlagIcon} label={t('needsReview')} />}
    </span>
  );
  const reviewed = (c: FamilyCreditDto) =>
    c.reviewedAt ? (
      <span className="text-sm">
        <bdi>{c.reviewedBy?.name}</bdi> · {formatInstant(c.reviewedAt, tz, locale)}
        {c.note && <span className="block text-muted-foreground">{c.note}</span>}
      </span>
    ) : manage ? (
      <Button
        variant="outline"
        size="sm"
        className="h-10 md:h-8"
        onClick={() => {
          review.reset();
          setReviewing(c);
        }}
      >
        <CircleCheckIcon />
        {t('markReviewed')}
        <span className="sr-only">: {c.family.name}</span>
      </Button>
    ) : (
      <span className="text-muted-foreground">—</span>
    );

  const columns = useMemo<ColumnDef<FamilyCreditDto, unknown>[]>(
    () => [
      {
        id: 'family',
        header: t('cols.family'),
        cell: ({ row }) => (
          <Link
            href={`/families/${row.original.family.id}`}
            className="font-semibold text-primary hover:underline"
          >
            <bdi>{row.original.family.name}</bdi>
          </Link>
        ),
      },
      {
        id: 'amount',
        header: t('cols.amount'),
        cell: ({ row }) => <Money amount={row.original.amount} currency={row.original.currency} />,
      },
      {
        id: 'remaining',
        header: t('cols.remaining'),
        cell: ({ row }) => (
          <Money amount={row.original.remaining} currency={row.original.currency} />
        ),
      },
      { id: 'status', header: t('cols.status'), cell: ({ row }) => state(row.original) },
      { id: 'source', header: t('cols.source'), cell: ({ row }) => source(row.original) },
      {
        id: 'created',
        header: t('cols.created'),
        cell: ({ row }) => formatInstant(row.original.createdAt, tz, locale),
      },
      { id: 'reviewed', header: t('cols.reviewed'), cell: ({ row }) => reviewed(row.original) },
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
        <div className="border-b p-4">
          <StatusTabs
            label={t('viewLabel')}
            value={view}
            // StatusTabs reports «all» as ''.
            onChange={(v) => params.set({ view: v === 'review' ? null : v || 'all' })}
            options={VIEWS.map((v) => ({
              value: v,
              label: t(`views.${v}`),
              count: v === view && list.data ? rows.length : undefined,
            }))}
          />
        </div>
        {live.failed ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : !list.isPending && rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={PiggyBankIcon}
              title={view === 'review' ? t('emptyReview') : t('empty')}
              description={t('emptyHint')}
            />
          </div>
        ) : (
          <ResponsiveList
            columns={fixFirstColumn(columns)}
            rows={rows}
            loading={list.isPending}
            label={t('title')}
            emptyText={t('empty')}
            getRowId={(c) => c.id}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={setColumnVisibility}
            renderCard={(c) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <Link href={`/families/${c.family.id}`} className="font-semibold text-primary">
                    <bdi>{c.family.name}</bdi>
                  </Link>
                  <Money amount={c.remaining} currency={c.currency} />
                </div>
                {state(c)}
                <span className="text-sm">{source(c)}</span>
                <span className="text-sm text-muted-foreground">
                  {formatInstant(c.createdAt, tz, locale)}
                </span>
                {reviewed(c)}
              </div>
            )}
          />
        )}
      </Card>
      <ReasonDialog
        open={!!reviewing}
        onOpenChange={(o) => !o && setReviewing(null)}
        title={t('reviewTitle', { name: reviewing?.family.name ?? '' })}
        description={t('reviewHint')}
        confirmLabel={t('markReviewed')}
        textLabel={t('note')}
        busy={review.isPending}
        error={review.isError ? message(review.error) : null}
        onConfirm={({ text }) =>
          reviewing && review.mutate({ id: reviewing.id, note: text.trim() || null })
        }
      />
    </>
  );
}
