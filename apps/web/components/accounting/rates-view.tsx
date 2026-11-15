'use client';

import { CURRENCIES, type ExchangeRateDto } from '@qarabic/shared';
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
import { useListParams } from '@/lib/list-params';
import { formatInstant } from '@/lib/time';
import { FormRow, NUMBER_INPUT, useAccountingError } from './accounting-bits';

/** Every billing currency but USD (the reporting currency, always 1). */
const RATE_CURRENCIES = CURRENCIES.filter((c) => c !== 'USD');
const RATE = /^\d{1,6}(\.\d{1,8})?$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

type Draft = { currency: string; month: string; rateToUsd: string; note: string };

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
                      <bdi dir="ltr">
                        1 {r.currency} = ${r.rateToUsd}
                      </bdi>
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
          key={`${draft.currency}-${draft.month}`}
          initial={draft}
          existing={rows.some((r) => r.currency === draft.currency && r.month === draft.month)}
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

/** Set or change one month's rate. A changed rate re-prices every report of that month. */
function RateDialog({
  initial,
  existing,
  onClose,
}: {
  initial: Draft;
  existing: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('accounting.rates');
  const locale = useUiLocale();
  const queryClient = useQueryClient();
  const message = useAccountingError();
  const ids = { currency: useId(), month: useId(), rate: useId(), note: useId() };
  const [form, setForm] = useState(initial);
  const [touched, setTouched] = useState(false);
  // Editing a row keeps its currency and month (another month is another rate).
  const locked = existing && initial.rateToUsd !== '';
  const rate = form.rateToUsd.trim();
  const errors = {
    month: MONTH.test(form.month) ? null : t('errors.month'),
    rateToUsd: !rate
      ? t('errors.rateRequired')
      : !RATE.test(rate) || Number(rate) <= 0
        ? t('errors.rate')
        : null,
  };
  const valid = !errors.month && !errors.rateToUsd;
  const save = useMutation({
    mutationFn: saveExchangeRate,
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: accountingKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(t('saved', { currency: r.currency, month: monthLabel(r.month, locale) }));
      onClose();
    },
  });
  const err = (k: keyof typeof errors) => (touched ? errors[k] : null);
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={locked ? t('editTitle') : t('addTitle')}
      description={t('formHint')}
      submitLabel={t('save')}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={touched && !valid ? t('errors.fix') : null}
      onSubmit={() => {
        setTouched(true);
        if (valid) {
          save.mutate({
            currency: form.currency,
            month: form.month,
            rateToUsd: rate,
            note: form.note.trim() || null,
          });
        }
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormRow id={ids.currency} label={t('currency')} required>
          <Select
            value={form.currency}
            disabled={locked}
            onValueChange={(currency) => setForm((f) => ({ ...f, currency }))}
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
              onChange={(month) => setForm((f) => ({ ...f, month }))}
              invalid={!!err('month')}
            />
          )}
        </FormRow>
      </div>
      <FormRow
        id={ids.rate}
        label={t('rateLabel', { currency: form.currency })}
        required
        error={err('rateToUsd')}
        hint={t('rateHint', { currency: form.currency })}
      >
        <Input
          id={ids.rate}
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          value={form.rateToUsd}
          aria-invalid={!!err('rateToUsd')}
          aria-describedby={err('rateToUsd') ? `${ids.rate}-error` : undefined}
          onChange={(e) => setForm((f) => ({ ...f, rateToUsd: e.target.value }))}
          className={NUMBER_INPUT}
        />
      </FormRow>
      <FormRow id={ids.note} label={t('note')}>
        <Textarea
          id={ids.note}
          maxLength={500}
          value={form.note}
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          className="md:text-body"
        />
      </FormRow>
    </FormDialog>
  );
}
