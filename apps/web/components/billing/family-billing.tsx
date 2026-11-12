'use client';

import {
  CURRENCIES,
  CURRENCY_LABELS,
  type Currency,
  type FamilyBillingDto,
  type FeePackageDto,
  type InvoiceDto,
} from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Field, FieldGroup, FieldLabel } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Switch } from '@qarabic/ui/components/switch';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertCircleIcon, FilePlusIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { DataTable, type ColumnMeta } from '@/components/data-table';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState } from '@/components/states';
import {
  billingKeys,
  fetchFamilyBilling,
  fetchFeePackages,
  fetchInvoice,
  fetchInvoices,
  updateFamilyBilling,
} from '@/lib/api/billing';
import { can } from '@/lib/auth/use-me';
import { validateFamilyBilling, type FamilyBillingForm } from '@/lib/billing/forms';
import { lineLabel, warningLabel, warningStudent } from '@/lib/billing/labels';
import { amountInput } from '@/lib/billing/money';
import { formatDate } from '@/lib/time';
import { ManualInvoiceDialog } from './action-dialogs';
import { FormRow, InvoiceStatusBadge, Money, NUMBER_INPUT, useBillingError } from './billing-bits';
import { PackageUsage, Section } from './invoice-parts';

const NO_PACKAGE = '__none__';

/**
 * Family profile → «الفوترة» (docs/20 §12, the current app's `FamilyBillingTab`): the billing
 * profile (currency, billing day, monthly billing on/off, fixed monthly fee, first billed day and
 * each child's package; a package change applies from the next invoice), the next invoice as the
 * run would issue it, what the family owes, its invoices with «فاتورة يدوية», and the package
 * usage of the latest invoice (B24, information only).
 */
export function FamilyBillingSection({ familyId }: { familyId: number }) {
  const t = useTranslations('billing.family');
  const tb = useTranslations('billing');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const manage = can(me, 'invoices.manage');
  const canDraft = manage || can(me, 'invoices.request');
  const [manual, setManual] = useState(false);
  const profile = useQuery({
    queryKey: billingKeys.family(familyId),
    queryFn: ({ signal }) => fetchFamilyBilling(familyId, signal),
  });
  const invoicesQuery = { familyId, perPage: 50 };
  const invoices = useQuery({
    queryKey: billingKeys.invoices(invoicesQuery),
    queryFn: ({ signal }) => fetchInvoices(invoicesQuery, signal),
  });
  const latest = invoices.data?.data.find(
    (i) => i.periodStart && i.status !== 'void' && i.status !== 'draft',
  );
  const latestDetail = useQuery({
    queryKey: billingKeys.invoice(latest?.id ?? 0),
    queryFn: ({ signal }) => fetchInvoice(latest!.id, signal),
    enabled: !!latest,
  });

  const columns = useMemo<ColumnDef<InvoiceDto, unknown>[]>(
    () => [
      {
        id: 'number',
        header: tb('fields.number'),
        cell: ({ row: { original: x } }) => (
          <Link href={`/invoices/${x.id}`} className="font-semibold text-primary hover:underline">
            <bdi>{x.number ?? tb('detail.draftTitle')}</bdi>
          </Link>
        ),
      },
      {
        id: 'due',
        header: tb('fields.dueDate'),
        cell: ({ row: { original: x } }) => formatDate(x.dueDate, locale) ?? '—',
      },
      {
        id: 'total',
        header: tb('fields.total'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: x } }) => <Money amount={x.total} currency={x.currency} />,
      },
      {
        id: 'balance',
        header: tb('fields.balance'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: x } }) => <Money amount={x.balance} currency={x.currency} />,
      },
      {
        id: 'status',
        header: tb('fields.status'),
        cell: ({ row: { original: x } }) => <InvoiceStatusBadge invoice={x} />,
      },
    ],
    [tb, locale],
  );

  if (profile.isError) {
    return (
      <section aria-label={t('title')} className="lg:col-span-2">
        <ErrorState onRetry={() => void profile.refetch()} />
      </section>
    );
  }
  const b = profile.data;
  if (!b) return <Skeleton className="h-64 rounded-xl lg:col-span-2" aria-busy="true" />;
  const next = b.nextInvoice;
  const nameOf = (id: number | null) => b.students.find((s) => s.id === id)?.name;

  return (
    <>
      <Section title={t('title')} className="lg:col-span-2">
        <div className="flex flex-col gap-4">
          {b.balance.length > 0 && (
            <dl className="flex flex-wrap gap-x-6 gap-y-2">
              {b.balance.map((x) => (
                <div key={x.currency} className="flex flex-col">
                  <dt className="text-sm text-muted-foreground">
                    {t('owes', { count: x.openInvoices })}
                  </dt>
                  <dd className="text-lg">
                    <Money amount={x.due} currency={x.currency} strong />
                    {x.overdue !== '0.00' && (
                      <span className="ms-2 text-sm font-semibold text-destructive">
                        {t('overdue')}: <Money amount={x.overdue} currency={x.currency} />
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {manage ? (
            <ProfileForm key={JSON.stringify(b)} billing={b} />
          ) : (
            <ProfileView billing={b} />
          )}
        </div>
      </Section>

      <Section
        title={t('next', {
          from: formatDate(next.periodStart, locale) ?? '',
          to: formatDate(next.periodEnd, locale) ?? '',
        })}
      >
        <div className="flex flex-col gap-3">
          {!b.billingEnabled && (
            <Alert>
              <TriangleAlertIcon />
              <AlertDescription>{t('disabledHint')}</AlertDescription>
            </Alert>
          )}
          {next.warnings.length > 0 && (
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertTitle>{t('warningsTitle')}</AlertTitle>
              <AlertDescription>
                <ul className="list-inside list-disc">
                  {next.warnings.map((w) => {
                    const who = nameOf(warningStudent(w));
                    return (
                      <li key={w}>
                        {warningLabel(w, locale)}
                        {who && ` (${who})`}
                      </li>
                    );
                  })}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {next.lines.length > 0 && (
            <ul className="flex flex-col divide-y">
              {next.lines.map((l, i) => (
                <li key={i} className="flex items-start justify-between gap-4 py-2">
                  <span dir="auto" className="min-w-0 break-words">
                    {lineLabel(l, tb('detail.monthlyFee'))}
                  </span>
                  <Money amount={l.amount} currency={next.currency} />
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between gap-4 border-t pt-2">
            <span className="font-bold">{tb('detail.total')}</span>
            {next.currency ? (
              <Money amount={next.total} currency={next.currency} strong />
            ) : (
              <span>—</span>
            )}
          </div>
        </div>
      </Section>

      <Section title={tb('usage.titleLatest')}>
        {latestDetail.data?.usage.length ? (
          <PackageUsage usage={latestDetail.data.usage} />
        ) : (
          <p className="text-muted-foreground">{tb('usage.none')}</p>
        )}
      </Section>

      <Section
        title={t('invoices')}
        className="lg:col-span-2"
        action={
          canDraft &&
          b.billingCurrency && (
            <Button
              variant="ghost"
              size="sm"
              className="text-primary"
              onClick={() => setManual(true)}
            >
              <FilePlusIcon />
              {tb('manual.open')}
            </Button>
          )
        }
      >
        {invoices.isError ? (
          <ErrorState onRetry={() => void invoices.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            data={invoices.data?.data ?? []}
            label={t('invoices')}
            emptyText={t('noInvoices')}
            loading={invoices.isPending}
            getRowHref={(x) => `/invoices/${x.id}`}
          />
        )}
      </Section>
      {manual && b.billingCurrency && (
        <ManualInvoiceDialog
          familyId={familyId}
          currency={b.billingCurrency}
          canIssue={manage}
          open
          onOpenChange={setManual}
        />
      )}
    </>
  );
}

function ProfileView({ billing: b }: { billing: FamilyBillingDto }) {
  const t = useTranslations('billing.family');
  const tr = useTranslations('billing.run');
  const locale = useUiLocale();
  const packages = useQuery({
    queryKey: billingKeys.packages,
    queryFn: ({ signal }) => fetchFeePackages(signal),
  });
  const pkgName = (id: number | null) =>
    packages.data?.find((p) => p.id === id)?.name ?? (id ? `#${id}` : t('noPackage'));
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: t('currency'),
      value:
        b.billingCurrency && `${b.billingCurrency} · ${CURRENCY_LABELS[b.billingCurrency][locale]}`,
    },
    { label: tr('day'), value: tr(b.billingDay === 15 ? 'day15' : 'day1') },
    { label: t('enabled'), value: t(b.billingEnabled ? 'on' : 'off') },
    {
      label: t('customFee'),
      value: b.customFee ? <Money amount={b.customFee} currency={b.billingCurrency} /> : null,
    },
    { label: t('startsOn'), value: formatDate(b.billingStartsOn, locale) },
    ...b.students.map((s) => ({
      label: t('packageOf', { name: s.name }),
      value: pkgName(s.feePackageId),
    })),
  ];
  return (
    <dl aria-label={t('profile')} className="divide-y">
      {rows.map((r) => (
        <div key={r.label} className="grid gap-1 py-2.5 sm:grid-cols-[12rem_1fr] sm:gap-4">
          <dt className="text-sm text-muted-foreground">{r.label}</dt>
          <dd>{r.value || <span className="text-muted-foreground">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

function ProfileForm({ billing: b }: { billing: FamilyBillingDto }) {
  const t = useTranslations('billing.family');
  const tr = useTranslations('billing.run');
  const tf = useTranslations('billing.form');
  const locale = useUiLocale();
  const message = useBillingError();
  const queryClient = useQueryClient();
  const ids = {
    currency: useId(),
    day: useId(),
    fee: useId(),
    starts: useId(),
    enabled: useId(),
    kid: useId(),
  };
  const packages = useQuery({
    queryKey: billingKeys.packages,
    queryFn: ({ signal }) => fetchFeePackages(signal),
  });
  const [v, setV] = useState<FamilyBillingForm>({
    currency: b.billingCurrency ?? '',
    billingDay: b.billingDay === 15 ? 15 : 1,
    enabled: b.billingEnabled,
    customFee: amountInput(b.customFee),
    startsOn: b.billingStartsOn ?? '',
    students: b.students.map((s) => ({ id: s.id, feePackageId: s.feePackageId })),
  });
  const [touched, setTouched] = useState(false);
  const save = useMutation({
    mutationFn: (body: Parameters<typeof updateFamilyBilling>[1]) =>
      updateFamilyBilling(b.familyId, body),
    onSuccess: (data) => {
      queryClient.setQueryData(billingKeys.family(b.familyId), data);
      toast.success(t('saved'));
    },
  });
  const check = validateFamilyBilling(v);
  const err = (k: 'currency' | 'customFee' | 'startsOn') =>
    touched && check.errors[k] ? tf(check.errors[k]) : null;
  const choices = (current: number | null): FeePackageDto[] =>
    (packages.data ?? []).filter((p) => p.isActive || p.id === current);

  return (
    <form
      noValidate
      aria-label={t('profile')}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (check.body) save.mutate(check.body);
      }}
    >
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        <FormRow id={ids.currency} label={t('currency')} required error={err('currency')}>
          <Select
            value={v.currency || undefined}
            onValueChange={(c) => setV((s) => ({ ...s, currency: c as Currency }))}
          >
            <SelectTrigger
              id={ids.currency}
              className="h-10! w-full"
              aria-invalid={!!err('currency')}
            >
              <SelectValue placeholder={t('chooseCurrency')} />
            </SelectTrigger>
            <SelectContent position="popper">
              {CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c} · {CURRENCY_LABELS[c][locale]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>
        <FormRow id={ids.day} label={tr('day')} required>
          <Select
            value={String(v.billingDay)}
            onValueChange={(d) => setV((s) => ({ ...s, billingDay: d === '15' ? 15 : 1 }))}
          >
            <SelectTrigger id={ids.day} className="h-10! w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="1">{tr('day1')}</SelectItem>
              <SelectItem value="15">{tr('day15')}</SelectItem>
            </SelectContent>
          </Select>
        </FormRow>
        <FormRow
          id={ids.fee}
          label={t('customFee')}
          error={err('customFee')}
          hint={t('customFeeHint')}
        >
          <Input
            id={ids.fee}
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            value={v.customFee}
            onChange={(e) => setV((s) => ({ ...s, customFee: e.target.value }))}
            aria-invalid={!!err('customFee')}
            className={NUMBER_INPUT}
          />
        </FormRow>
        <FormRow
          id={ids.starts}
          label={t('startsOn')}
          error={err('startsOn')}
          hint={t('startsOnHint')}
        >
          <Input
            id={ids.starts}
            type="date"
            dir="ltr"
            value={v.startsOn}
            onChange={(e) => setV((s) => ({ ...s, startsOn: e.target.value }))}
            aria-invalid={!!err('startsOn')}
            className={NUMBER_INPUT}
          />
        </FormRow>
        {b.students.map((kid, i) => {
          const current = v.students[i]?.feePackageId ?? null;
          const fieldId = `${ids.kid}-${kid.id}`;
          return (
            <FormRow key={kid.id} id={fieldId} label={t('packageOf', { name: kid.name })}>
              <Select
                value={current === null ? NO_PACKAGE : String(current)}
                onValueChange={(x) =>
                  setV((s) => ({
                    ...s,
                    students: s.students.map((st, j) =>
                      j === i ? { ...st, feePackageId: x === NO_PACKAGE ? null : Number(x) } : st,
                    ),
                  }))
                }
              >
                <SelectTrigger id={fieldId} className="h-10! w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value={NO_PACKAGE}>{t('noPackage')}</SelectItem>
                  {choices(current).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormRow>
          );
        })}
      </FieldGroup>
      <Field orientation="horizontal" className="justify-between rounded-lg border p-3">
        <div className="flex flex-col gap-0.5">
          <FieldLabel htmlFor={ids.enabled}>{t('enabledLabel')}</FieldLabel>
          <p className="text-sm text-muted-foreground">{t('enabledHint')}</p>
        </div>
        <Switch
          id={ids.enabled}
          checked={v.enabled}
          onCheckedChange={(x) => setV((s) => ({ ...s, enabled: x }))}
        />
      </Field>
      <p aria-live="polite" className="sr-only">
        {touched && !check.body ? tf('fixErrors') : null}
      </p>
      {save.isError && (
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon />
          <AlertDescription>{message(save.error)}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" className="h-10 self-start" disabled={save.isPending}>
        {save.isPending && <Spinner />}
        {t('save')}
      </Button>
    </form>
  );
}
