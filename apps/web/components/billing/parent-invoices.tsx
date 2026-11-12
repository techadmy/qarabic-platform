'use client';

import {
  INVOICE_KIND_LABELS,
  isOpenInvoice,
  type InvoiceDto,
  type OnlinePaymentMethod,
} from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent } from '@qarabic/ui/components/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { cn } from '@qarabic/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircleIcon,
  CircleCheckIcon,
  CreditCardIcon,
  FileXIcon,
  InfoIcon,
  LockIcon,
  PrinterIcon,
  ReceiptTextIcon,
  WalletIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/page-header';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import {
  billingKeys,
  capturePaypal,
  fetchBillingProviders,
  fetchInvoice,
  fetchInvoices,
  invoicePrintUrl,
  startCheckout,
} from '@/lib/api/billing';
import { can } from '@/lib/auth/use-me';
import { periodMonth } from '@/lib/billing/labels';
import { minorOf } from '@/lib/billing/money';
import { checkoutTarget, readCheckoutReturn } from '@/lib/billing/checkout';
import { formatDate } from '@/lib/time';
import { InvoiceStatusBadge, Money, useBillingError } from './billing-bits';
import { InvoiceLines, PackageUsage, PaymentsList, Section } from './invoice-parts';

/** After the provider sends the parent back: poll this often, give up after this long (D88). */
const CONFIRM_POLL_MS = 3_000;
const CONFIRM_GIVE_UP_MS = 120_000;

function useInvoiceTitle() {
  const t = useTranslations('billing.parent');
  const locale = useUiLocale();
  return (inv: Pick<InvoiceDto, 'periodStart' | 'kind'>) => {
    const month = periodMonth(inv.periodStart, locale);
    return month ? t('invoiceFor', { month }) : INVOICE_KIND_LABELS[inv.kind][locale];
  };
}

/**
 * «فواتيري» (parent, mobile-first; docs/20 §12): what is due now first (amount, due date, «ادفع
 * الآن» one tap away), then the history. Only the family's own issued invoices (the API's scope).
 */
export function ParentInvoicesView() {
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
  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const rows = list.data?.data ?? [];
  const open = rows
    .filter((r) => isOpenInvoice(r.status))
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
  const past = rows.filter((r) => !isOpenInvoice(r.status));

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      {list.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : list.isError ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={ReceiptTextIcon} title={t('empty')} description={t('emptyHint')} />
      ) : (
        <>
          <section aria-labelledby="due-now" className="flex flex-col gap-3">
            <h2 id="due-now" className="text-base font-semibold">
              {open.length ? t('due') : t('allPaid')}
            </h2>
            {open.length > 0 && (
              <ul className="flex flex-col gap-3">
                {open.map((inv) => (
                  <li key={inv.id}>
                    <Card className={cn('shadow-none', inv.isOverdue && 'ring-destructive/60')}>
                      <CardContent className="flex flex-col gap-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="font-bold">{title(inv)}</h3>
                          <InvoiceStatusBadge invoice={inv} />
                        </div>
                        <p className="text-2xl">
                          <Money amount={inv.balance} currency={inv.currency} strong />
                        </p>
                        <p
                          className={cn(
                            'text-sm',
                            inv.isOverdue
                              ? 'font-semibold text-destructive'
                              : 'text-muted-foreground',
                          )}
                        >
                          {t('dueOn', { date: formatDate(inv.dueDate, locale) ?? '—' })}
                          {inv.number && (
                            <>
                              {' · '}
                              <bdi>{inv.number}</bdi>
                            </>
                          )}
                        </p>
                        <div className="flex gap-2">
                          <Button asChild className="h-11 flex-1">
                            <Link href={`/invoices/${inv.id}?pay=1`}>
                              {t('payNow')}
                              <span className="sr-only">: {title(inv)}</span>
                            </Link>
                          </Button>
                          <Button asChild variant="outline" className="h-11">
                            <Link href={`/invoices/${inv.id}`}>
                              {t('details')}
                              <span className="sr-only">: {title(inv)}</span>
                            </Link>
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {past.length > 0 && (
            <section aria-labelledby="history" className="flex flex-col gap-3">
              <h2 id="history" className="text-base font-semibold">
                {t('history')}
              </h2>
              <ul className="flex flex-col gap-2">
                {past.map((inv) => (
                  <li key={inv.id}>
                    <Card className="py-0 shadow-none">
                      <Link
                        href={`/invoices/${inv.id}`}
                        className="flex min-h-11 items-center justify-between gap-3 rounded-xl p-4 outline-none hover:bg-subtle focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="font-semibold">{title(inv)}</span>
                          <bdi className="text-sm text-muted-foreground">{inv.number}</bdi>
                        </span>
                        <span className="flex flex-col items-end gap-1">
                          <Money amount={inv.total} currency={inv.currency} />
                          <InvoiceStatusBadge invoice={inv} />
                        </span>
                      </Link>
                    </Card>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Parent → one invoice: amount due and «ادفع الآن» (card through Stripe Checkout or PayPal, only
 * the providers the API reports as on), lines, package usage, payments and receipts. Coming back
 * from the provider (`?checkout=return|success`) only shows «جارٍ تأكيد الدفع…» and polls: the
 * invoice turns paid when the provider confirms to the server (signed webhook / server capture,
 * D88), never because of the return address. `?checkout=cancelled|cancel` says nothing was taken.
 */
export function ParentInvoiceView({ id }: { id: number }) {
  const t = useTranslations('billing.parent');
  const tb = useTranslations('billing');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const router = useRouter();
  const search = useSearchParams();
  const queryClient = useQueryClient();
  const message = useBillingError();
  const title = useInvoiceTitle();
  const back = { href: '/invoices', label: t('back') };
  const ret = readCheckoutReturn(search);
  const [gaveUp, setGaveUp] = useState(false);
  const [choosing, setChoosing] = useState(search.get('pay') === '1');
  const [cancelSeen, setCancelSeen] = useState(false);
  const allowed = can(me, 'invoices.view');

  const query = useQuery({
    queryKey: billingKeys.invoice(id),
    queryFn: ({ signal }) => fetchInvoice(id, signal),
    enabled: allowed && Number.isInteger(id) && id > 0,
    refetchInterval: (q) =>
      ret.kind === 'return' && !gaveUp && q.state.data?.status !== 'paid' ? CONFIRM_POLL_MS : false,
  });
  const waiting = ret.kind === 'return' && !gaveUp && query.data?.status !== 'paid';
  const providers = useQuery({
    queryKey: billingKeys.providers,
    queryFn: ({ signal }) => fetchBillingProviders(signal),
    enabled: allowed,
  });
  const checkout = useMutation({
    mutationFn: async (p: OnlinePaymentMethod) => {
      const target = checkoutTarget((await startCheckout(id, p)).url, window.location.origin);
      if (target.kind === 'invalid') throw new Error('The provider page address is not valid.');
      return target;
    },
    onSuccess: (target) => {
      if (target.kind === 'internal') {
        setChoosing(false);
        router.push(target.path);
        void queryClient.invalidateQueries({ queryKey: billingKeys.invoice(id) });
      } else if (target.kind === 'external') {
        window.location.assign(target.url);
      }
    },
  });
  const capture = useMutation({
    mutationFn: (orderId: string) => capturePaypal(id, orderId),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: billingKeys.invoice(id) }),
  });
  const captured = useRef(false);
  const { mutate: captureOrder } = capture;
  useEffect(() => {
    if (ret.paypalOrder && !captured.current) {
      captured.current = true;
      captureOrder(ret.paypalOrder);
    }
  }, [ret.paypalOrder, captureOrder]);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setGaveUp(true), CONFIRM_GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  if (!allowed || isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} back={back} />
        <ForbiddenState />
      </>
    );
  }
  if (isApiError(query.error, 404)) {
    return (
      <>
        <PageHeader title={t('title')} back={back} />
        <EmptyState
          icon={FileXIcon}
          role="alert"
          title={tb('detail.notFoundTitle')}
          description={tb('detail.notFound')}
        />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title={t('title')} back={back} />
        <ErrorState onRetry={() => void query.refetch()} />
      </>
    );
  }
  const inv = query.data;
  if (!inv) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4" aria-busy="true">
        <Skeleton className="h-12 w-60" />
        <Skeleton className="h-44 rounded-xl" />
        <Skeleton className="h-60 rounded-xl" />
      </div>
    );
  }
  const online = providers.data?.online ?? [];
  const payable = inv.can.pay && minorOf(inv.balance) > 0;
  const paid = inv.status === 'paid';
  const confirming = ret.kind === 'return' && !paid && !gaveUp;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{title(inv)}</span>
            <InvoiceStatusBadge invoice={inv} />
          </span>
        }
        meta={
          <>
            <bdi>{inv.number}</bdi>
            {inv.issueDate &&
              ` · ${t('issuedOn', { date: formatDate(inv.issueDate, locale) ?? '' })}`}
          </>
        }
        actions={
          inv.number && (
            <Button variant="outline" className="h-10" asChild>
              <a href={invoicePrintUrl(inv.id)} target="_blank" rel="noopener noreferrer">
                <PrinterIcon />
                {tb('actions.print')}
                <span className="sr-only">{tb('opensNewTab')}</span>
              </a>
            </Button>
          )
        }
      />

      <div aria-live="polite" className="flex flex-col gap-3">
        {confirming && (
          <Alert role="status">
            <Spinner />
            <AlertTitle>{t('confirmingTitle')}</AlertTitle>
            <AlertDescription>{t('confirming')}</AlertDescription>
          </Alert>
        )}
        {ret.kind === 'return' && !paid && gaveUp && (
          <Alert variant="warning" role="status">
            <InfoIcon />
            <AlertDescription>{t('notYet')}</AlertDescription>
          </Alert>
        )}
        {(ret.kind === 'return' || ret.paypalOrder) && paid && (
          <Alert role="status">
            <CircleCheckIcon />
            <AlertTitle>{t('paidTitle')}</AlertTitle>
            <AlertDescription>{t('paidThanks')}</AlertDescription>
          </Alert>
        )}
        {ret.kind === 'cancelled' && !cancelSeen && (
          <Alert role="status">
            <InfoIcon />
            <AlertTitle>{t('cancelledTitle')}</AlertTitle>
            <AlertDescription>
              <span>{t('cancelled')}</span>
              <Button
                variant="link"
                className="h-auto p-0"
                onClick={() => {
                  setCancelSeen(true);
                  router.replace(`/invoices/${id}`);
                }}
              >
                {t('dismiss')}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {capture.isError && (
          <Alert variant="destructive" role="alert">
            <AlertCircleIcon />
            <AlertDescription>{message(capture.error)}</AlertDescription>
          </Alert>
        )}
      </div>

      <Card className="shadow-none">
        <CardContent className="flex flex-col gap-2">
          {payable ? (
            <>
              <span className="text-sm text-muted-foreground">{t('amountDue')}</span>
              <p className="text-3xl">
                <Money amount={inv.balance} currency={inv.currency} strong />
              </p>
              <p
                className={cn(
                  'text-sm',
                  inv.isOverdue ? 'font-semibold text-destructive' : 'text-muted-foreground',
                )}
              >
                {t('dueOn', { date: formatDate(inv.dueDate, locale) ?? '—' })}
              </p>
              {online.length > 0 ? (
                <Button
                  className="mt-2 h-11 sm:self-start sm:px-8"
                  disabled={confirming}
                  onClick={() => setChoosing(true)}
                >
                  {t('payNow')}
                </Button>
              ) : (
                providers.isSuccess && (
                  <Alert>
                    <InfoIcon />
                    <AlertDescription>{t('payOffline')}</AlertDescription>
                  </Alert>
                )
              )}
            </>
          ) : (
            <>
              <span className="text-sm text-muted-foreground">{tb('detail.total')}</span>
              <p className="text-3xl">
                <Money amount={inv.total} currency={inv.currency} strong />
              </p>
              {paid && inv.paidAt && (
                <p className="text-sm text-muted-foreground">
                  {t('paidOn', { date: formatDate(inv.paidAt.slice(0, 10), locale) ?? '' })}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Section title={tb('detail.lines')}>
        <InvoiceLines invoice={inv} />
      </Section>
      {inv.usage.length > 0 && (
        <Section title={tb('usage.title')}>
          <PackageUsage usage={inv.usage} />
        </Section>
      )}
      <Section title={tb('detail.payments')}>
        <PaymentsList
          payments={inv.payments}
          viewerTz={tz}
          receiptHref={(p) => `/invoices/${inv.id}/receipts/${p.id}`}
        />
      </Section>

      {choosing && payable && online.length > 0 && (
        <PayDialog
          providers={online}
          amount={<Money amount={inv.balance} currency={inv.currency} strong />}
          busy={checkout.isPending || checkout.isSuccess}
          error={checkout.isError ? message(checkout.error) : null}
          onPay={(p) => checkout.mutate(p)}
          onClose={() => {
            setChoosing(false);
            checkout.reset();
            if (search.get('pay')) router.replace(`/invoices/${id}`);
          }}
        />
      )}
    </div>
  );
}

function PayDialog({
  providers,
  amount,
  busy,
  error,
  onPay,
  onClose,
}: {
  providers: OnlinePaymentMethod[];
  amount: ReactNode;
  busy: boolean;
  error: string | null;
  onPay: (p: OnlinePaymentMethod) => void;
  onClose: () => void;
}) {
  const t = useTranslations('billing.pay');
  const tf = useTranslations('billing.form');
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('amount')}: {amount}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {providers.map((p, i) => (
            <Button
              key={p}
              variant={i === 0 ? 'default' : 'outline'}
              className="h-12 justify-start text-base"
              disabled={busy}
              onClick={() => onPay(p)}
            >
              {p === 'stripe' ? <CreditCardIcon /> : <WalletIcon />}
              {t(p)}
            </Button>
          ))}
          {busy && (
            <p role="status" className="flex items-center gap-2 text-sm">
              <Spinner />
              {t('redirecting')}
            </p>
          )}
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <LockIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t('secure')}
          </p>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertCircleIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy}>
              {tf('cancel')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
