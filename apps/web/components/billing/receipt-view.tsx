'use client';

import { PAYMENT_METHOD_LABELS } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent } from '@qarabic/ui/components/card';
import { Separator } from '@qarabic/ui/components/separator';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { ArrowRightIcon, FileXIcon, PrinterIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandLogo } from '@/components/brand-logo';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { billingKeys, fetchInvoice } from '@/lib/api/billing';
import { can } from '@/lib/auth/use-me';
import { formatInstant } from '@/lib/time';
import { Money } from './billing-bits';

/**
 * Payment receipt (parent and staff; docs/20 §12, the current app's `ReceiptPage`): one printable
 * card built from the invoice and its succeeded payment. Print hides the app chrome and buttons.
 */
export function ReceiptView({ invoiceId, paymentId }: { invoiceId: number; paymentId: number }) {
  const t = useTranslations('billing.receipt');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const allowed = can(me, 'invoices.view');
  const query = useQuery({
    queryKey: billingKeys.invoice(invoiceId),
    queryFn: ({ signal }) => fetchInvoice(invoiceId, signal),
    enabled: allowed && Number.isInteger(invoiceId) && invoiceId > 0,
  });
  const backLink = (
    <Button variant="ghost" className="h-10 self-start print:hidden" asChild>
      <Link href={`/invoices/${invoiceId}`}>
        <ArrowRightIcon className="ltr:rotate-180" />
        {t('back')}
      </Link>
    </Button>
  );
  if (!allowed || isApiError(query.error, 403)) return <ForbiddenState />;
  if (query.isError && !isApiError(query.error, 404)) {
    return <ErrorState onRetry={() => void query.refetch()} />;
  }
  if (query.isPending) {
    return <Skeleton className="mx-auto h-96 w-full max-w-2xl rounded-xl" aria-busy="true" />;
  }
  const inv = query.data;
  const p = inv?.payments.find((x) => x.id === paymentId && x.status === 'succeeded');
  if (!inv || !p) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        {backLink}
        <EmptyState
          icon={FileXIcon}
          role="alert"
          title={t('notFound')}
          description={t('notFoundHint')}
        />
      </div>
    );
  }
  const row = (label: string, value: ReactNode) => (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-end font-semibold">{value}</dd>
    </div>
  );
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        {backLink}
        <Button variant="outline" className="h-10" onClick={() => window.print()}>
          <PrinterIcon />
          {t('print')}
        </Button>
      </div>
      <Card className="shadow-none print:ring-0">
        <CardContent className="flex flex-col gap-4 sm:p-4">
          <div className="flex items-center justify-between gap-4">
            <BrandLogo className="w-28" />
            <h1 className="text-xl font-bold">{t('title')}</h1>
          </div>
          <Separator />
          <dl className="flex flex-col gap-2.5">
            {row(t('number'), <bdi dir="ltr">{p.receiptNumber}</bdi>)}
            {row(t('date'), formatInstant(p.receivedAt ?? p.createdAt, tz, locale))}
            {row(t('family'), inv.family.name)}
            {row(t('invoice'), <bdi dir="ltr">{inv.number}</bdi>)}
            {row(t('method'), PAYMENT_METHOD_LABELS[p.method][locale])}
            {p.reference && row(t('reference'), <bdi dir="ltr">{p.reference}</bdi>)}
          </dl>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <span className="font-bold">{t('amount')}</span>
            <span className="text-2xl">
              <Money amount={p.amount} currency={p.currency} strong />
            </span>
          </div>
          <dl>{row(t('balance'), <Money amount={inv.balance} currency={inv.currency} />)}</dl>
          <p className="text-sm text-muted-foreground">{t('footer')}</p>
        </CardContent>
      </Card>
    </div>
  );
}
