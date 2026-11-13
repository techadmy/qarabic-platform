'use client';

import {
  CURRENCIES,
  CURRENCY_LABELS,
  SESSION_MINUTES_OPTIONS,
  type Currency,
  type FeePackageDto,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
import { Field, FieldGroup, FieldLabel } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Switch } from '@qarabic/ui/components/switch';
import { Textarea } from '@qarabic/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import {
  AlertCircleIcon,
  ArchiveIcon,
  CircleCheckIcon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { ColumnMeta } from '@/components/data-table';
import { fixFirstColumn, useColumnVisibility } from '@/components/list/column-chooser';
import { ListActions } from '@/components/list/list-actions';
import { ResponsiveList } from '@/components/list/responsive-list';
import { PageHeader } from '@/components/page-header';
import { ToneBadge } from '@/components/sessions/badges';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import {
  billingKeys,
  createFeePackage,
  fetchFeePackages,
  updateFeePackage,
} from '@/lib/api/billing';
import { can } from '@/lib/auth/use-me';
import { validatePackage, type PackageForm } from '@/lib/billing/forms';
import { amountInput } from '@/lib/billing/money';
import { FormRow, Money, NUMBER_INPUT, useBillingError } from './billing-bits';

const EMPTY: PackageForm = {
  name: '',
  classesPerWeek: '2',
  sessionMinutes: 30,
  description: '',
  isActive: true,
  prices: [{ currency: 'USD', amount: '' }],
};

const formOf = (p: FeePackageDto): PackageForm => ({
  name: p.name,
  classesPerWeek: String(p.classesPerWeek),
  sessionMinutes: p.sessionMinutes,
  description: p.description ?? '',
  isActive: p.isActive,
  prices: p.prices.map((x) => ({ currency: x.currency, amount: amountInput(x.monthlyAmount) })),
});

/**
 * «الباقات» (docs/20 §3, §12; the current app's `PackagesPage`): the monthly fee of each weekly
 * plan, one price per currency. Archive (switch it off), never delete: invoices keep their lines.
 */
export function PackagesView() {
  const t = useTranslations('billing.packages');
  const me = useCurrentUser();
  const [columnVisibility, setColumnVisibility] = useColumnVisibility(`packages:${me.id}`);
  const allowed = can(me, 'packages.view');
  const manage = can(me, 'packages.manage');
  const [editing, setEditing] = useState<{ id?: number; form: PackageForm } | null>(null);
  const query = useQuery({
    queryKey: billingKeys.packages,
    queryFn: ({ signal }) => fetchFeePackages(signal),
    enabled: allowed,
  });

  const columns = useMemo<ColumnDef<FeePackageDto, unknown>[]>(() => {
    const cols: ColumnDef<FeePackageDto, unknown>[] = [
      {
        id: 'name',
        enableHiding: false,
        header: t('name'),
        cell: ({ row: { original: p } }) => (
          <span className="flex flex-col">
            <span className="font-semibold">{p.name}</span>
            {p.description && (
              <span className="text-sm text-muted-foreground">{p.description}</span>
            )}
          </span>
        ),
      },
      {
        id: 'plan',
        header: t('plan'),
        cell: ({ row: { original: p } }) =>
          t('planValue', { count: p.classesPerWeek, minutes: p.sessionMinutes }),
      },
      {
        id: 'prices',
        header: t('prices'),
        // Money is end-aligned (docs/15 §5.13).
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: p } }) => <Prices p={p} />,
      },
      {
        id: 'students',
        header: t('students'),
        meta: { numeric: true } satisfies ColumnMeta,
        cell: ({ row: { original: p } }) => p.studentsCount,
      },
      {
        id: 'status',
        header: t('status'),
        cell: ({ row: { original: p } }) => <PackageStatus active={p.isActive} />,
      },
    ];
    if (manage) {
      cols.push({
        id: 'actions',
        header: () => <span className="sr-only">{t('actions')}</span>,
        cell: ({ row: { original: p } }) => (
          <Button
            variant="ghost"
            size="sm"
            className="text-primary"
            onClick={() => setEditing({ id: p.id, form: formOf(p) })}
          >
            <PencilIcon />
            {t('edit')}
            <span className="sr-only">: {p.name}</span>
          </Button>
        ),
      });
    }
    return cols;
  }, [t, manage]);

  if (!allowed || isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const rows = query.data ?? [];
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        actions={
          <ListActions
            create={
              manage ? { label: t('add'), onClick: () => setEditing({ form: EMPTY }) } : undefined
            }
          />
        }
      />
      <Card className="gap-0 py-0 shadow-none">
        {query.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void query.refetch()} />
          </div>
        ) : !query.isPending && rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={PackageIcon}
              title={t('empty')}
              description={t('emptyHint')}
              action={
                manage ? (
                  <Button onClick={() => setEditing({ form: EMPTY })}>{t('add')}</Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <ResponsiveList
            columns={fixFirstColumn(columns)}
            rows={rows}
            loading={query.isPending}
            label={t('title')}
            emptyText={t('empty')}
            getRowId={(p) => p.id}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={setColumnVisibility}
            renderCard={(p) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold">{p.name}</span>
                  <PackageStatus active={p.isActive} />
                </div>
                <span className="text-sm text-muted-foreground">
                  {t('planValue', { count: p.classesPerWeek, minutes: p.sessionMinutes })} ·{' '}
                  {t('studentsCount', { count: p.studentsCount })}
                </span>
                <Prices p={p} />
                {manage && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1 h-10 self-start"
                    onClick={() => setEditing({ id: p.id, form: formOf(p) })}
                  >
                    <PencilIcon />
                    {t('edit')}
                    <span className="sr-only">: {p.name}</span>
                  </Button>
                )}
              </div>
            )}
          />
        )}
      </Card>
      {editing && (
        <PackageDialog
          id={editing.id}
          initial={editing.form}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </>
  );
}

function Prices({ p }: { p: FeePackageDto }) {
  return (
    // Inline, so an end-aligned (numeric) cell puts it at the end.
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
      {p.prices.map((x) => (
        <Money key={x.currency} amount={x.monthlyAmount} currency={x.currency} />
      ))}
    </span>
  );
}

function PackageStatus({ active }: { active: boolean }) {
  const t = useTranslations('billing.packages');
  return active ? (
    <ToneBadge tone="green" icon={CircleCheckIcon} label={t('active')} />
  ) : (
    <ToneBadge tone="grey" icon={ArchiveIcon} label={t('archived')} />
  );
}

function PackageDialog({
  id,
  initial,
  onOpenChange,
}: {
  id?: number;
  initial: PackageForm;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('billing.packages');
  const tf = useTranslations('billing.form');
  const locale = useUiLocale();
  const message = useBillingError();
  const queryClient = useQueryClient();
  const ids = {
    name: useId(),
    perWeek: useId(),
    minutes: useId(),
    desc: useId(),
    active: useId(),
    price: useId(),
  };
  const [v, setV] = useState<PackageForm>(initial);
  const [touched, setTouched] = useState(false);
  const save = useMutation({
    mutationFn: (body: Parameters<typeof createFeePackage>[0]) =>
      id ? updateFeePackage(id, body) : createFeePackage(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: billingKeys.packages });
      toast.success(t('saved'));
      onOpenChange(false);
    },
  });
  const check = validatePackage(v);
  const err = (k: 'name' | 'classesPerWeek' | 'prices') =>
    touched && check.errors[k] ? tf(check.errors[k]) : null;
  const unused = CURRENCIES.filter((c) => !v.prices.some((p) => p.currency === c));
  const setPrice = (i: number, patch: Partial<PackageForm['prices'][number]>) =>
    setV((s) => ({ ...s, prices: s.prices.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));

  return (
    <Dialog open onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg" showCloseButton={false}>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (check.body) save.mutate(check.body);
          }}
        >
          <DialogHeader>
            <DialogTitle>{id ? t('editTitle') : t('add')}</DialogTitle>
            <DialogDescription>{t('dialogHint')}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <FormRow id={ids.name} label={t('name')} required error={err('name')}>
              <Input
                id={ids.name}
                dir="auto"
                maxLength={120}
                value={v.name}
                onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))}
                aria-invalid={!!err('name')}
                aria-required
                className="h-10 md:text-body"
              />
            </FormRow>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormRow id={ids.perWeek} label={t('perWeek')} required error={err('classesPerWeek')}>
                <Input
                  id={ids.perWeek}
                  inputMode="numeric"
                  dir="ltr"
                  value={v.classesPerWeek}
                  onChange={(e) => setV((s) => ({ ...s, classesPerWeek: e.target.value }))}
                  aria-invalid={!!err('classesPerWeek')}
                  aria-required
                  className={NUMBER_INPUT}
                />
              </FormRow>
              <FormRow id={ids.minutes} label={t('minutes')} required>
                <Select
                  value={String(v.sessionMinutes)}
                  onValueChange={(x) => setV((s) => ({ ...s, sessionMinutes: Number(x) }))}
                >
                  <SelectTrigger id={ids.minutes} className="h-10! w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {SESSION_MINUTES_OPTIONS.map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {t('minutesValue', { count: m })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormRow>
            </div>
            <FormRow id={ids.desc} label={t('description')}>
              <Textarea
                id={ids.desc}
                dir="auto"
                rows={2}
                maxLength={500}
                value={v.description}
                onChange={(e) => setV((s) => ({ ...s, description: e.target.value }))}
                className="md:text-body"
              />
            </FormRow>
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-sm font-medium">
                {t('prices')}
                <span className="text-destructive" aria-hidden>
                  *
                </span>
              </legend>
              {v.prices.map((p, i) => (
                <div key={i} className="grid grid-cols-[8rem_1fr_auto] items-start gap-2">
                  <Select
                    value={p.currency}
                    onValueChange={(c) => setPrice(i, { currency: c as Currency })}
                  >
                    <SelectTrigger
                      className="h-10! w-full"
                      aria-label={t('currencyOf', { n: i + 1 })}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {CURRENCIES.filter(
                        (c) => c === p.currency || !v.prices.some((x) => x.currency === c),
                      ).map((c) => (
                        <SelectItem key={c} value={c}>
                          {c} · {CURRENCY_LABELS[c][locale]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    id={`${ids.price}-${i}`}
                    inputMode="decimal"
                    dir="ltr"
                    autoComplete="off"
                    value={p.amount}
                    onChange={(e) => setPrice(i, { amount: e.target.value })}
                    aria-label={t('monthlyIn', { currency: p.currency })}
                    aria-invalid={touched && !!check.priceErrors[i]}
                    className={NUMBER_INPUT}
                  />
                  {v.prices.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-10"
                      aria-label={t('removePrice', { currency: p.currency })}
                      onClick={() =>
                        setV((s) => ({ ...s, prices: s.prices.filter((_, j) => j !== i) }))
                      }
                    >
                      <Trash2Icon />
                    </Button>
                  ) : (
                    <span className="w-10" aria-hidden />
                  )}
                </div>
              ))}
              {unused.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() =>
                    setV((s) => ({
                      ...s,
                      prices: [...s.prices, { currency: unused[0]!, amount: '' }],
                    }))
                  }
                >
                  <PlusIcon />
                  {t('addPrice')}
                </Button>
              )}
              {err('prices') && (
                <p role="alert" className="text-sm text-destructive">
                  {err('prices')}
                </p>
              )}
            </fieldset>
            {id !== undefined && (
              <Field orientation="horizontal" className="justify-between">
                <div className="flex flex-col gap-0.5">
                  <FieldLabel htmlFor={ids.active}>{t('activeLabel')}</FieldLabel>
                  <p className="text-sm text-muted-foreground">{t('activeHint')}</p>
                </div>
                <Switch
                  id={ids.active}
                  checked={v.isActive}
                  onCheckedChange={(x) => setV((s) => ({ ...s, isActive: x }))}
                />
              </Field>
            )}
          </FieldGroup>
          <p aria-live="polite" className="sr-only">
            {touched && !check.body ? tf('fixErrors') : null}
          </p>
          {save.isError && (
            <Alert variant="destructive" role="alert">
              <AlertCircleIcon />
              <AlertDescription>{message(save.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={save.isPending}>
                {tf('cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Spinner />}
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
