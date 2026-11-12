'use client';

import { isOpenInvoice } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { cn } from '@qarabic/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeftIcon, ReceiptTextIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { billingKeys, fetchInvoices } from '@/lib/api/billing';
import { can } from '@/lib/auth/use-me';
import { formatDate } from '@/lib/time';
import { InvoiceStatusBadge, Money } from './billing-bits';
import { useInvoiceTitle } from './parent-invoices';

/** How many open invoices the home lists before «عرض فواتيري». */
const SHOWN = 3;

/**
 * «المستحق عليكم» on the parent home (M9, docs/15 §2.6 P3: pay in one or two taps): the open
 * invoices, overdue first then by due date, each with «ادفع الآن»; nothing when all is paid. Same
 * query as «فواتيري», so the two stay in step.
 */
export function ParentDueCard() {
  const t = useTranslations('billing.parent');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const title = useInvoiceTitle();
  const allowed = can(me, 'invoices.view');
  const list = useQuery({
    queryKey: billingKeys.invoices({ parent: true }),
    queryFn: ({ signal }) => fetchInvoices({ perPage: 100 }, signal),
    enabled: allowed,
  });
  if (!allowed || !list.data) return null;
  const open = list.data.data
    .filter((r) => isOpenInvoice(r.status))
    .sort(
      (a, b) =>
        Number(b.isOverdue) - Number(a.isOverdue) ||
        (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'),
    );
  if (open.length === 0) return null;
  return (
    <section aria-labelledby="home-due">
      <Card className="gap-3 shadow-none">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b">
          <CardTitle className="text-lg font-bold">
            <h2 id="home-due">{t('homeDue')}</h2>
          </CardTitle>
          <Button variant="ghost" asChild className="h-10 px-0 text-primary">
            <Link href="/invoices">
              {t('allInvoices')}
              <ChevronLeftIcon className="ltr:rotate-180" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y">
            {open.slice(0, SHOWN).map((inv) => (
              <li
                key={inv.id}
                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <ReceiptTextIcon className="size-4 text-muted-foreground" aria-hidden />
                    <span className="font-semibold">{title(inv)}</span>
                    <InvoiceStatusBadge invoice={inv} />
                  </span>
                  <span
                    className={cn(
                      'text-sm',
                      inv.isOverdue ? 'font-semibold text-destructive' : 'text-muted-foreground',
                    )}
                  >
                    {t('dueOn', { date: formatDate(inv.dueDate, locale) ?? '—' })}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <Money amount={inv.balance} currency={inv.currency} strong className="text-lg" />
                  <Button asChild className="h-11">
                    <Link href={`/invoices/${inv.id}?pay=1`}>
                      {t('payNow')}
                      <span className="sr-only">: {title(inv)}</span>
                    </Link>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {open.length > SHOWN && (
            <p className="mt-3 text-sm text-muted-foreground">
              {t('moreDue', { count: open.length - SHOWN })}
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
