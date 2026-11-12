'use client';

import { INVOICE_KIND_LABELS, PAYMENT_METHOD_LABELS, type PaymentDto } from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BanIcon,
  BellRingIcon,
  BanknoteIcon,
  EllipsisVerticalIcon,
  FileCheckIcon,
  FileXIcon,
  InfoIcon,
  PercentIcon,
  PlusIcon,
  PrinterIcon,
  SplitIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { KeyFacts } from '@/components/people/detail';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import {
  billingKeys,
  fetchInvoice,
  invoicePrintUrl,
  issueInvoice,
  remindInvoice,
  voidInvoice,
  voidPayment,
} from '@/lib/api/billing';
import { can } from '@/lib/auth/use-me';
import { periodLabel } from '@/lib/billing/labels';
import { minorOf } from '@/lib/billing/money';
import { formatDate } from '@/lib/time';
import { useDirection } from '@/lib/use-direction';
import { LineDialog, RecordPaymentDialog, SplitDialog } from './action-dialogs';
import { InvoiceStatusBadge, Money, useBillingError } from './billing-bits';
import { InvoiceLines, PackageUsage, PaymentsList, Section } from './invoice-parts';

type Open = null | 'issue' | 'payment' | 'adjustment' | 'discount' | 'split' | 'void';

/**
 * Staff invoice workbench (docs/20 §12, the current app's `InvoiceDetailPage`): number, status and
 * family; total / paid / balance / due date; lines and totals, payments, package usage. Primary
 * action: «إصدار الفاتورة» for a draft, «تسجيل دفعة» for an open invoice; «أرسل تذكيرًا» and
 * «طباعة» beside it; adjust, discount, split and void in the ⋯ menu. Void (invoice or payment)
 * needs a reason (D31). The buttons follow the API's `can` flags; nothing changes from a link.
 */
export function InvoiceDetailView({ id }: { id: number }) {
  const t = useTranslations('billing');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const dir = useDirection();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = useBillingError();
  const allowed = can(me, 'invoices.view');
  const [open, setOpen] = useState<Open>(null);
  const [voidingPayment, setVoidingPayment] = useState<PaymentDto | null>(null);
  const query = useQuery({
    queryKey: billingKeys.invoice(id),
    queryFn: ({ signal }) => fetchInvoice(id, signal),
    enabled: allowed && Number.isInteger(id) && id > 0,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: billingKeys.all });
  const issue = useMutation({
    mutationFn: () => issueInvoice(id),
    onSuccess: () => {
      refresh();
      setOpen(null);
      toast.success(t('detail.issuedToast'));
    },
  });
  const remind = useMutation({
    mutationFn: () => remindInvoice(id),
    onSuccess: () => toast.success(t('detail.reminded')),
    onError: (e) => toast.error(message(e)),
  });
  const voidInv = useMutation({
    mutationFn: (reason: string) => voidInvoice(id, reason),
    onSuccess: () => {
      refresh();
      setOpen(null);
      toast.success(t('void.done'));
    },
  });
  const voidPay = useMutation({
    mutationFn: (v: { id: number; reason: string }) => voidPayment(v.id, v.reason),
    onSuccess: () => {
      refresh();
      setVoidingPayment(null);
      toast.success(t('payment.voided'));
    },
  });

  const back = { href: '/invoices', label: t('detail.back') };
  if (!allowed || isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={t('detail.title')} back={back} />
        <ForbiddenState />
      </>
    );
  }
  if (isApiError(query.error, 404)) {
    return (
      <>
        <PageHeader title={t('detail.title')} back={back} />
        <EmptyState
          icon={FileXIcon}
          role="alert"
          title={t('detail.notFoundTitle')}
          description={t('detail.notFound')}
        />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title={t('detail.title')} back={back} />
        <ErrorState onRetry={() => void query.refetch()} />
      </>
    );
  }
  const inv = query.data;
  if (!inv) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const c = inv.can;
  const period = periodLabel(inv, locale);
  const overflow = c.edit || c.split || c.void;
  const title = inv.number ?? t('detail.draftTitle');

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <bdi>{title}</bdi>
            <InvoiceStatusBadge invoice={inv} />
          </span>
        }
        meta={
          <>
            {can(me, 'families.view') ? (
              <Link href={`/families/${inv.family.id}`} className="text-primary underline">
                {inv.family.name}
              </Link>
            ) : (
              inv.family.name
            )}
            {' · '}
            {INVOICE_KIND_LABELS[inv.kind][locale]}
            {period && ` · ${period}`}
          </>
        }
        actions={
          <>
            {c.issue && (
              <Button className="h-10" onClick={() => setOpen('issue')}>
                <FileCheckIcon />
                {t('actions.issue')}
              </Button>
            )}
            {c.recordPayment && minorOf(inv.balance) > 0 && (
              <Button className="h-10" onClick={() => setOpen('payment')}>
                <BanknoteIcon />
                {t('actions.recordPayment')}
              </Button>
            )}
            {c.remind && (
              <Button
                variant="outline"
                className="h-10"
                disabled={remind.isPending}
                onClick={() => remind.mutate()}
              >
                <BellRingIcon />
                {t('actions.remind')}
              </Button>
            )}
            {inv.number && (
              <Button variant="outline" className="h-10" asChild>
                <a href={invoicePrintUrl(inv.id)} target="_blank" rel="noopener noreferrer">
                  <PrinterIcon />
                  {t('actions.print')}
                  <span className="sr-only">{t('opensNewTab')}</span>
                </a>
              </Button>
            )}
            {overflow && (
              <DropdownMenu dir={dir}>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-lg" aria-label={t('actions.more')}>
                    <EllipsisVerticalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {c.edit && (
                    <DropdownMenuItem onSelect={() => setOpen('adjustment')}>
                      <PlusIcon />
                      {t('actions.adjust')}
                    </DropdownMenuItem>
                  )}
                  {c.edit && (
                    <DropdownMenuItem onSelect={() => setOpen('discount')}>
                      <PercentIcon />
                      {t('actions.discount')}
                    </DropdownMenuItem>
                  )}
                  {c.split && (
                    <DropdownMenuItem onSelect={() => setOpen('split')}>
                      <SplitIcon />
                      {t('actions.split')}
                    </DropdownMenuItem>
                  )}
                  {c.void && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setOpen('void')}>
                        <BanIcon />
                        {t('actions.void')}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />

      {inv.status === 'void' && (
        <Alert>
          <InfoIcon />
          <AlertTitle>{t('detail.voidedTitle')}</AlertTitle>
          <AlertDescription>
            {t('detail.voidReason', { reason: inv.voidReason ?? '—' })}
          </AlertDescription>
        </Alert>
      )}
      {inv.status === 'split' && inv.splits.length > 0 && (
        <Alert>
          <SplitIcon />
          <AlertTitle>{t('detail.splitInto')}</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-1">
              {inv.splits.map((s) => (
                <li key={s.id}>
                  <Link href={`/invoices/${s.id}`} className="text-primary underline">
                    <bdi>{s.number ?? `#${s.id}`}</bdi>
                  </Link>
                  {' · '}
                  <Money amount={s.total} currency={inv.currency} />
                  {s.dueDate && ` · ${t('fields.dueDate')}: ${formatDate(s.dueDate, locale)}`}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {inv.splitFrom && (
        <Alert>
          <SplitIcon />
          <AlertDescription>
            <span>
              {t('detail.splitFrom')}{' '}
              <Link href={`/invoices/${inv.splitFrom.id}`} className="text-primary underline">
                <bdi>{inv.splitFrom.number ?? `#${inv.splitFrom.id}`}</bdi>
              </Link>
            </span>
          </AlertDescription>
        </Alert>
      )}
      {inv.status === 'draft' && (
        <Alert>
          <InfoIcon />
          <AlertDescription>{t('detail.draftHint')}</AlertDescription>
        </Alert>
      )}

      <KeyFacts
        items={[
          { label: t('detail.total'), value: <Money amount={inv.total} currency={inv.currency} /> },
          { label: t('detail.paid'), value: <Money amount={inv.paid} currency={inv.currency} /> },
          {
            label: t('detail.balance'),
            value: <Money amount={inv.balance} currency={inv.currency} />,
          },
          {
            label: t('fields.dueDate'),
            value: (
              <span className={inv.isOverdue ? 'text-destructive' : undefined}>
                {formatDate(inv.dueDate, locale) ?? '—'}
              </span>
            ),
          },
        ]}
      />

      <div className="grid items-start gap-4 lg:grid-cols-12">
        <Section title={t('detail.lines')} className="lg:col-span-7">
          <InvoiceLines invoice={inv} />
          {inv.notes && (
            <p className="mt-3 text-sm break-words text-muted-foreground" dir="auto">
              {inv.notes}
            </p>
          )}
        </Section>
        <div className="flex flex-col gap-4 lg:col-span-5">
          <Section title={t('detail.payments')}>
            <PaymentsList
              payments={inv.payments}
              viewerTz={tz}
              receiptHref={(p) => `/invoices/${inv.id}/receipts/${p.id}`}
              onVoid={can(me, 'invoices.manage') ? setVoidingPayment : undefined}
            />
          </Section>
          {inv.usage.length > 0 && (
            <Section title={t('usage.title')}>
              <PackageUsage usage={inv.usage} />
            </Section>
          )}
        </div>
      </div>

      {open === 'issue' && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setOpen(null)}
          title={t('issue.title')}
          description={t('issue.body')}
          confirmLabel={t('actions.issue')}
          busy={issue.isPending}
          error={issue.isError ? message(issue.error) : null}
          onConfirm={() => issue.mutate()}
        />
      )}
      {open === 'payment' && (
        <RecordPaymentDialog invoice={inv} open onOpenChange={(o) => !o && setOpen(null)} />
      )}
      {(open === 'adjustment' || open === 'discount') && (
        <LineDialog invoice={inv} kind={open} open onOpenChange={(o) => !o && setOpen(null)} />
      )}
      {open === 'split' && (
        <SplitDialog invoice={inv} open onOpenChange={(o) => !o && setOpen(null)} />
      )}
      {open === 'void' && (
        <ReasonDialog
          open
          destructive
          onOpenChange={(o) => {
            if (!o) {
              setOpen(null);
              voidInv.reset();
            }
          }}
          title={t('void.title', { number: title })}
          description={t('void.body')}
          confirmLabel={t('void.confirm')}
          textLabel={t('form.reason')}
          textRequired
          textMin={3}
          busy={voidInv.isPending}
          error={voidInv.isError ? message(voidInv.error) : null}
          onConfirm={({ text }) => voidInv.mutate(text)}
        />
      )}
      {voidingPayment && (
        <ReasonDialog
          open
          destructive
          onOpenChange={(o) => {
            if (!o) {
              setVoidingPayment(null);
              voidPay.reset();
            }
          }}
          title={t('payment.voidTitle')}
          description={
            <>
              {t('payment.voidBody', {
                method: PAYMENT_METHOD_LABELS[voidingPayment.method][locale],
              })}{' '}
              <Money amount={voidingPayment.amount} currency={voidingPayment.currency} strong />
            </>
          }
          confirmLabel={t('payment.void')}
          textLabel={t('form.reason')}
          textRequired
          textMin={3}
          busy={voidPay.isPending}
          error={voidPay.isError ? message(voidPay.error) : null}
          onConfirm={({ text }) => voidPay.mutate({ id: voidingPayment.id, reason: text })}
        />
      )}
    </>
  );
}
