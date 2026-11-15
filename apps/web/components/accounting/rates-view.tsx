'use client';

import { CURRENCIES, type ExchangeRateDto, type UpsertExchangeRateInput } from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Input } from '@qarabic/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { Textarea } from '@qarabic/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { MonthPicker } from '@/components/forms/date-time';
import { PageHeader } from '@/components/page-header';
import { FormDialog } from '@/components/payroll/payroll-bits';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { academyToday } from '@/lib/accounting/forms';
import {
  accountingKeys,
  deleteExchangeRate,
  fetchExchangeRates,
  saveExchangeRate,
} from '@/lib/api/accounting';
import { isApiError } from '@/lib/api/client';
import { can } from '@/lib/auth/use-me';
import { monthLabel } from '@/lib/billing/labels';
import { normalizeNumberInput } from '@/lib/billing/money';
import { useListParams } from '@/lib/list-params';
import { formatInstant, intlLocale } from '@/lib/time';
import { FormRow, NUMBER_INPUT, useAccountingError } from './accounting-bits';

/** Every billing currency but USD (the reporting currency, always 1). */
const RATE_CURRENCIES = CURRENCIES.filter((c) => c !== 'USD');
const RATE = /^\d{1,6}(\.\d{1,8})?$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

type Draft = { currency: string; month: string; rateToUsd: string; note: string; edit?: boolean };

/**
 * «أسعار الصرف» (D144, D146): the monthly rate of each currency to USD that every dashboard and
 * report converts with. Accounts keep them (`accounting.rates`) without seeing the ledger; the
 * owner's `accounting.manage` can too; billing reads them (`reports.financial`). A year at a time,
 * newest month first. Deleting a rate needs a reason: every report of that month changes.
 * `?new=1&currency=GBP&month=2025-12` opens the form prefilled (the dashboard's missing-rate link).
 */
export function RatesView() {
  const t = useTranslations('accounting.rates');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const params = useListParams();
  const queryClient = useQueryClient();
  const message = useAccountingError();
  const today = academyToday();
  const thisYear = Number(today.slice(0, 4));
  const year = Number(params.get('year')) || thisYear;
  const currency = params.get('currency') ?? '';
  const allowed = can(me, 'accounting.view') || can(me, 'reports.financial');
  const manage = can(me, 'accounting.manage') || can(me, 'accounting.rates');
  const query = {
    from: `${year}-01`,
    to: `${year}-12`,
    ...(RATE_CURRENCIES.includes(currency as never) ? { currency } : {}),
  };
  const rates = useQuery({
    queryKey: accountingKeys.rates(query),
    queryFn: ({ signal }) => fetchExchangeRates(query, signal),
    enabled: allowed,
  });

  // The form: opened empty, for a row, or from the URL (`?new=1&month=…&currency=…`).
  const fromUrl = manage && params.get('new') === '1';
  const [editing, setEditing] = useState<Draft | 'closed' | null>(null);
  const draft: Draft | null =
    editing === 'closed'
      ? null
      : (editing ??
        (fromUrl
          ? {
              currency: RATE_CURRENCIES.includes(currency as never) ? currency : 'GBP',
              month: MONTH.test(params.get('month') ?? '')
                ? params.get('month')!
                : today.slice(0, 7),
              rateToUsd: '',
              note: '',
            }
          : null));
  const closeForm = () => {
    setEditing('closed');
    if (fromUrl) params.set({ new: null, month: null }, { resetPage: false });
  };
  const [deleting, setDeleting] = useState<ExchangeRateDto | null>(null);
  const remove = useMutation({
    mutationFn: (v: { id: number; reason: string }) => deleteExchangeRate(v.id, v.reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: accountingKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      if (deleting) {
        toast.success(
          t('deleted', { currency: deleting.currency, month: monthLabel(deleting.month, locale) }),
        );
      }
      setDeleting(null);
    },
  });

  if (!allowed || isApiError(rates.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const goYear = (y: number) => params.set({ year: y === thisYear ? null : y });
  const rows = rates.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          manage && (
            <Button
              className="h-10"
              onClick={() =>
                setEditing({
                  currency: query.currency ?? 'GBP',
                  month: today.slice(0, 7),
                  rateToUsd: '',
                  note: '',
                })
              }
            >
              <PlusIcon />
              {t('add')}
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-lg"
            aria-label={t('prevYear')}
            onClick={() => goYear(year - 1)}
          >
            <ChevronRightIcon className="ltr:rotate-180" />
          </Button>
          <span className="min-w-16 text-center text-lg font-bold tabular-nums" aria-live="polite">
            {year}
          </span>
          <Button
            variant="outline"
            size="icon-lg"
            aria-label={t('nextYear')}
            disabled={year >= thisYear}
            onClick={() => goYear(year + 1)}
          >
            <ChevronLeftIcon className="ltr:rotate-180" />
          </Button>
        </div>
        <Select
          value={query.currency ?? 'all'}
          onValueChange={(v) => params.set({ currency: v === 'all' ? null : v })}
        >
          <SelectTrigger aria-label={t('currency')} className="h-10! w-44 bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="all">{t('allCurrencies')}</SelectItem>
            {RATE_CURRENCIES.map((c) => (
              <SelectItem key={c} value={c}>
                <bdi>{c}</bdi>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {rates.isError ? (
        <ErrorState onRetry={() => void rates.refetch()} />
      ) : rates.isSuccess && rows.length === 0 ? (
        <EmptyState
          icon={ArrowLeftRightIcon}
          title={t('empty', { year })}
          description={t('emptyHint')}
        />
      ) : (
        <Card className="gap-0 overflow-x-auto py-0 shadow-none">
          <Table aria-label={t('tableLabel', { year })}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('month')}</TableHead>
                <TableHead>{t('currency')}</TableHead>
                <TableHead className="text-end">{t('rate')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('note')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('updated')}</TableHead>
                {manage && (
                  <TableHead>
                    <span className="sr-only">{t('actions')}</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const label = `${r.currency} · ${monthLabel(r.month, locale)}`;
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium whitespace-nowrap">
                      {monthLabel(r.month, locale)}
                    </TableCell>
                    <TableCell>
                      <bdi>{r.currency}</bdi>
                    </TableCell>
                    <TableCell className="text-end whitespace-nowrap tabular-nums">
                      <RateLine currency={r.currency} rate={r.rateToUsd} />
                    </TableCell>
                    <TableCell className="hidden max-w-64 truncate text-sm text-muted-foreground md:table-cell">
                      {r.note ?? '—'}
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                      {r.updatedBy
                        ? t('updatedLine', {
                            name: r.updatedBy.name,
                            when: formatInstant(r.updatedAt, tz, locale) ?? '—',
                          })
                        : (formatInstant(r.updatedAt, tz, locale) ?? '—')}
                    </TableCell>
                    {manage && (
                      <TableCell className="text-end whitespace-nowrap">
                        <Button
                          variant="ghost"
                          size="icon-lg"
                          aria-label={t('editRow', { row: label })}
                          onClick={() =>
                            setEditing({
                              currency: r.currency,
                              month: r.month,
                              rateToUsd: r.rateToUsd,
                              note: r.note ?? '',
                              edit: true,
                            })
                          }
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-lg"
                          aria-label={t('deleteRow', { row: label })}
                          onClick={() => setDeleting(r)}
                        >
                          <Trash2Icon />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
              {rates.isPending &&
                Array.from({ length: 6 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={manage ? 6 : 5}>
                      <Skeleton className="h-6" />
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {draft && (
        <RateDialog
          key={`${draft.edit ? 'edit' : 'add'}-${draft.currency}-${draft.month}`}
          initial={draft}
          onClose={closeForm}
        />
      )}
      <ReasonDialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) {
            setDeleting(null);
            remove.reset();
          }
        }}
        destructive
        title={
          deleting
            ? t('deleteTitle', {
                currency: deleting.currency,
                month: monthLabel(deleting.month, locale),
              })
            : ''
        }
        description={t('deleteHint')}
        confirmLabel={t('delete')}
        textLabel={t('reason')}
        textRequired
        textMin={3}
        busy={remove.isPending}
        error={remove.isError ? message(remove.error) : null}
        onConfirm={({ text }) => deleting && remove.mutate({ id: deleting.id, reason: text })}
      />
    </div>
  );
}

/** «1 GBP = 1.2700 USD»: at least 4 decimals, up to the 8 the API keeps. */
export function formatRate(rate: string | number, locale: 'ar' | 'en') {
  return new Intl.NumberFormat(intlLocale(locale), {
    minimumFractionDigits: 4,
    maximumFractionDigits: 8,
  }).format(Number(rate));
}

function RateLine({ currency, rate }: { currency: string; rate: string | number }) {
  const locale = useUiLocale();
  return (
    <bdi dir="ltr" className="tabular-nums">
      1 {currency} = {formatRate(rate, locale)} USD
    </bdi>
  );
}

/**
 * Set or change one month's rate. A month that already has one (opened from its row, or chosen
 * while adding) shows the current value and a warning, and needs «استبدال السعر» with a reason:
 * every report and the dashboard of that month change (ui-ux P1 on #109).
 */
function RateDialog({ initial, onClose }: { initial: Draft; onClose: () => void }) {
  const t = useTranslations('accounting.rates');
  const locale = useUiLocale();
  const queryClient = useQueryClient();
  const message = useAccountingError();
  const ids = {
    currency: useId(),
    month: useId(),
    rate: useId(),
    note: useId(),
    reason: useId(),
  };
  const [form, setForm] = useState(initial);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  // Editing a row keeps its currency and month (another month is another rate).
  const locked = !!initial.edit;
  const lookup = { currency: form.currency, from: form.month, to: form.month };
  const current = useQuery({
    queryKey: accountingKeys.rates(lookup),
    queryFn: ({ signal }) => fetchExchangeRates(lookup, signal),
    enabled: MONTH.test(form.month),
  });
  const existing = current.data?.find(
    (r) => r.currency === form.currency && r.month === form.month,
  );
  const rate = normalizeNumberInput(form.rateToUsd);
  const rateOk = RATE.test(rate) && Number(rate) > 0;
  const errors = {
    month: MONTH.test(form.month) ? null : t('errors.month'),
    rateToUsd: !rate ? t('errors.rateRequired') : !rateOk ? t('errors.rate') : null,
    reason: existing && reason.trim().length < 3 ? t('errors.reason') : null,
  };
  const valid = !errors.month && !errors.rateToUsd && !errors.reason && !current.isFetching;
  const save = useMutation({
    mutationFn: saveExchangeRate,
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: accountingKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(t('saved', { currency: r.currency, month: monthLabel(r.month, locale) }));
      onClose();
    },
    // Someone set this month meanwhile (409 rate_exists): show it and ask again.
    onError: () => void current.refetch(),
  });
  const err = (k: keyof typeof errors) => (touched ? errors[k] : null);
  const set = (patch: Partial<Draft>) => {
    save.reset();
    setForm((f) => ({ ...f, ...patch }));
  };
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={locked ? t('editTitle') : t('addTitle')}
      description={t('formHint')}
      submitLabel={existing ? t('replace') : t('save')}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={touched && !valid ? t('errors.fix') : null}
      onSubmit={() => {
        setTouched(true);
        if (!valid) return;
        save.mutate({
          currency: form.currency,
          month: form.month,
          rateToUsd: rate,
          note: form.note.trim() || null,
          // The API refuses to overwrite silently (409 rate_exists) unless asked, with a reason.
          ...(existing ? { replace: true, reason: reason.trim() } : {}),
        } as UpsertExchangeRateInput);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormRow id={ids.currency} label={t('currency')} required>
          <Select
            value={form.currency}
            disabled={locked}
            onValueChange={(currency) => set({ currency })}
          >
            <SelectTrigger id={ids.currency} className="h-10! w-full bg-card md:text-body">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {RATE_CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  <bdi>{c}</bdi>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>
        <FormRow id={ids.month} label={t('month')} required error={err('month')}>
          {locked ? (
            <Input
              id={ids.month}
              value={monthLabel(form.month, locale)}
              disabled
              className="h-10"
            />
          ) : (
            <MonthPicker
              id={ids.month}
              value={form.month}
              onChange={(month) => set({ month })}
              invalid={!!err('month')}
            />
          )}
        </FormRow>
      </div>
      {existing && (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>
            {t('existsTitle', {
              currency: existing.currency,
              month: monthLabel(existing.month, locale),
            })}
          </AlertTitle>
          <AlertDescription>
            <span>
              {t('existsCurrent')}{' '}
              <RateLine currency={existing.currency} rate={existing.rateToUsd} />
            </span>
            <span>{t('existsHint')}</span>
          </AlertDescription>
        </Alert>
      )}
      <FormRow
        id={ids.rate}
        label={t('rateLabel', { currency: form.currency })}
        required
        error={err('rateToUsd')}
        hint={
          rateOk ? (
            <span className="flex flex-col">
              <RateLine currency={form.currency} rate={rate} />
              <bdi dir="ltr" className="tabular-nums">
                100 {form.currency} = {formatRate(Number(rate) * 100, locale)} USD
              </bdi>
            </span>
          ) : (
            t('rateHint', { currency: form.currency })
          )
        }
      >
        <Input
          id={ids.rate}
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          value={form.rateToUsd}
          aria-invalid={!!err('rateToUsd')}
          aria-describedby={err('rateToUsd') ? `${ids.rate}-error` : undefined}
          onChange={(e) => set({ rateToUsd: e.target.value })}
          className={NUMBER_INPUT}
        />
      </FormRow>
      {existing && (
        <FormRow id={ids.reason} label={t('replaceReason')} required error={err('reason')}>
          <Textarea
            id={ids.reason}
            maxLength={500}
            value={reason}
            aria-invalid={!!err('reason')}
            aria-describedby={err('reason') ? `${ids.reason}-error` : undefined}
            onChange={(e) => setReason(e.target.value)}
            className="md:text-body"
          />
        </FormRow>
      )}
      <FormRow id={ids.note} label={t('note')}>
        <Textarea
          id={ids.note}
          maxLength={500}
          value={form.note}
          onChange={(e) => set({ note: e.target.value })}
          className="md:text-body"
        />
      </FormRow>
    </FormDialog>
  );
}
