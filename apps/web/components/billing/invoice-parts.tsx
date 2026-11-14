'use client';

import {
  INVOICE_LINE_TYPE_LABELS,
  isOnlineMethod,
  PAYMENT_METHOD_LABELS,
  SESSION_STAGE_LABELS,
  type InvoiceDetailDto,
  type PackageUsageDto,
  type PaymentDto,
  type SessionStage,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Progress } from '@qarabic/ui/components/progress';
import { Separator } from '@qarabic/ui/components/separator';
import { cn } from '@qarabic/ui/lib/utils';
import { ReceiptTextIcon, Undo2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useUiLocale } from '@/components/sessions/times';
import { lineLabel, prorationOf } from '@/lib/billing/labels';
import { minorOf } from '@/lib/billing/money';
import { formatDate, formatInstant } from '@/lib/time';
import { Money, PaymentStatusBadge } from './billing-bits';

/** A titled shadcn Card (the profile sections' look). */
export function Section({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('gap-2 shadow-none', className)}>
      <CardHeader className="border-b">
        <CardTitle className="text-base font-bold">
          <h2>{title}</h2>
        </CardTitle>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * Lines then totals. Lines are append-only (D83): an adjustment or a discount is its own line with
 * its reason and date, so the history of the amount stays visible.
 */
export function InvoiceLines({ invoice }: { invoice: InvoiceDetailDto }) {
  const t = useTranslations('billing.detail');
  const locale = useUiLocale();
  const c = invoice.currency;
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label={t('lines')} className="flex flex-col divide-y">
        {invoice.lines.map((l) => {
          const prorated = prorationOf(l.meta);
          const dated = l.type === 'adjustment' || l.type === 'discount';
          return (
            <li key={l.id} className="flex items-start justify-between gap-4 py-2.5">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-semibold break-words" dir="auto">
                  {lineLabel(l, t('monthlyFee'))}
                </span>
                <span className="text-sm text-muted-foreground">
                  {INVOICE_LINE_TYPE_LABELS[l.type][locale]}
                  {dated && ` · ${formatDate(l.createdAt.slice(0, 10), locale)}`}
                  {prorated &&
                    ` · ${t('prorated', { days: prorated.days, of: prorated.periodDays })}`}
                </span>
              </div>
              <Money amount={l.amount} currency={c} />
            </li>
          );
        })}
      </ul>
      <Separator />
      <dl className="flex flex-col gap-1.5">
        <Total label={t('subtotal')} amount={invoice.subtotal} currency={c} />
        {minorOf(invoice.adjustments) !== 0 && (
          <Total label={t('adjustments')} amount={invoice.adjustments} currency={c} />
        )}
        {minorOf(invoice.discounts) !== 0 && (
          <Total label={t('discounts')} amount={invoice.discounts} currency={c} />
        )}
        <Total label={t('total')} amount={invoice.total} currency={c} strong />
        {minorOf(invoice.paid) > 0 && (
          <Total label={t('paid')} amount={invoice.paid} currency={c} />
        )}
        <Total label={t('balance')} amount={invoice.balance} currency={c} strong />
      </dl>
    </div>
  );
}

function Total({
  label,
  amount,
  currency,
  strong,
}: {
  label: string;
  amount: string;
  currency: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className={cn(strong ? 'font-bold' : 'text-muted-foreground')}>{label}</dt>
      <dd>
        <Money amount={amount} currency={currency} strong={strong} />
      </dd>
    </div>
  );
}

/** Payments of one invoice; a receipt for each succeeded one; staff may void a manual one. */
export function PaymentsList({
  payments,
  receiptHref,
  onVoid,
  viewerTz,
}: {
  payments: PaymentDto[];
  receiptHref?: (p: PaymentDto) => string;
  onVoid?: (p: PaymentDto) => void;
  viewerTz: string;
}) {
  const t = useTranslations('billing.detail');
  const locale = useUiLocale();
  if (!payments.length) return <p className="text-muted-foreground">{t('noPayments')}</p>;
  return (
    <ul aria-label={t('payments')} className="flex flex-col divide-y">
      {payments.map((p) => {
        const method = PAYMENT_METHOD_LABELS[p.method][locale];
        return (
          <li key={p.id} className="flex flex-col gap-1.5 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{method}</span>
                <PaymentStatusBadge status={p.status} />
              </span>
              <Money amount={p.amount} currency={p.currency} />
            </div>
            <span className="text-sm text-muted-foreground">
              {formatInstant(p.receivedAt ?? p.createdAt, viewerTz, locale)}
              {p.reference && (
                <>
                  {' · '}
                  {t('reference')}:{' '}
                  <bdi dir="ltr" className="whitespace-nowrap">
                    {p.reference}
                  </bdi>
                </>
              )}
              {p.recordedBy && ` · ${t('recordedBy', { name: p.recordedBy.name })}`}
              {p.receiptNumber && (
                <>
                  {' · '}
                  <bdi dir="ltr" className="whitespace-nowrap">
                    {p.receiptNumber}
                  </bdi>
                </>
              )}
            </span>
            {p.note && (
              <span className="text-sm break-words" dir="auto">
                {p.note}
              </span>
            )}
            {p.status === 'succeeded' && (receiptHref || onVoid) && (
              <span className="flex flex-wrap gap-2">
                {receiptHref && (
                  <Button variant="outline" size="sm" asChild>
                    <Link href={receiptHref(p)}>
                      <ReceiptTextIcon />
                      {t('receipt')}
                      <span className="sr-only">: {p.receiptNumber}</span>
                    </Link>
                  </Button>
                )}
                {onVoid && !isOnlineMethod(p.method) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => onVoid(p)}
                  >
                    <Undo2Icon className="rtl:-scale-x-100" />
                    {t('voidPayment')}
                    <span className="sr-only">: {method}</span>
                  </Button>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** B24 (D85): the classes that count against each child's package this period. Information only. */
export function PackageUsage({ usage }: { usage: PackageUsageDto[] }) {
  const t = useTranslations('billing.usage');
  const locale = useUiLocale();
  if (!usage.length) return <p className="text-muted-foreground">{t('none')}</p>;
  const stages = usage[0]?.countedStages ?? [];
  return (
    <div className="flex flex-col gap-4">
      {usage.map((u) => {
        const label = t('counted', { counted: u.counted, allowance: u.allowance });
        return (
          <div key={u.studentId} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">{u.studentName}</span>
              <span className="text-sm tabular-nums">{label}</span>
            </div>
            <Progress
              value={u.allowance ? Math.min(100, Math.round((u.counted / u.allowance) * 100)) : 0}
              aria-label={`${u.studentName}: ${label}`}
            />
            <span className="text-sm text-muted-foreground">
              {t('detail', { notCounted: u.notCounted, upcoming: u.upcoming })}
            </span>
          </div>
        );
      })}
      {stages.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t('rule', {
            stages: stages
              .map((s) => SESSION_STAGE_LABELS[s as SessionStage]?.[locale] ?? s)
              .join(locale === 'ar' ? '، ' : ', '),
          })}
        </p>
      )}
    </div>
  );
}
