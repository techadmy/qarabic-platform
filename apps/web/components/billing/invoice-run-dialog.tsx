'use client';

import type { InvoiceRunPreviewResponse } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
import { Input } from '@qarabic/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Spinner } from '@qarabic/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircleIcon, CircleCheckIcon, CopyCheckIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ToneBadge } from '@/components/sessions/badges';
import { useUiLocale } from '@/components/sessions/times';
import { billingKeys, previewInvoiceRun, runInvoices } from '@/lib/api/billing';
import { ACADEMY_TZ, monthLabel, nextMonth, runDueDate, warningLabel } from '@/lib/billing/labels';
import { dateKeyIn, isDateKey } from '@/lib/schedule-time';
import { formatDate } from '@/lib/time';
import { FormRow, Money, NUMBER_INPUT, useBillingError } from './billing-bits';

/**
 * «إصدار فواتير الشهر» (docs/20 §4.2, the current app's `InvoiceRunDialog`): month, billing day
 * and due date → a preview that writes nothing (per family: children, amount, what will happen) →
 * «أصدر N فاتورة». Running twice never duplicates: one invoice per family and period on the server.
 */
export function InvoiceRunDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('billing.run');
  const tf = useTranslations('billing.form');
  const locale = useUiLocale();
  const message = useBillingError();
  const queryClient = useQueryClient();
  const ids = { month: useId(), day: useId(), due: useId() };
  const today = dateKeyIn(ACADEMY_TZ);
  const [period, setPeriod] = useState(() => nextMonth(today));
  const [day, setDay] = useState<1 | 15>(1);
  const [due, setDue] = useState(() => runDueDate(nextMonth(today), today));
  const [preview, setPreview] = useState<InvoiceRunPreviewResponse | null>(null);
  const load = useMutation({
    mutationFn: () => previewInvoiceRun({ period, billingDay: day }),
    onSuccess: setPreview,
  });
  const run = useMutation({
    mutationFn: () => runInvoices({ period, billingDay: day, dueDate: due }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: billingKeys.all });
      toast.success(t('done', { count: r.issuedCount }));
      onOpenChange(false);
    },
  });
  const periodOk = /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
  const dueError = !isDateKey(due) || due < today ? tf('dateFromToday') : null;
  const reset = () => {
    setPreview(null);
    load.reset();
    run.reset();
  };
  const error = load.error ?? run.error;
  const busy = load.isPending || run.isPending;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('hint')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormRow
            id={ids.month}
            label={t('month')}
            required
            error={periodOk ? null : tf('required')}
          >
            <Input
              id={ids.month}
              type="month"
              dir="ltr"
              value={period}
              onChange={(e) => {
                setPeriod(e.target.value);
                if (e.target.value) setDue(runDueDate(e.target.value, today));
                reset();
              }}
              aria-invalid={!periodOk}
              className={NUMBER_INPUT}
            />
          </FormRow>
          <FormRow id={ids.day} label={t('day')} required>
            <Select
              value={String(day)}
              onValueChange={(v) => {
                setDay(v === '15' ? 15 : 1);
                reset();
              }}
            >
              <SelectTrigger id={ids.day} className="h-10! w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="1">{t('day1')}</SelectItem>
                <SelectItem value="15">{t('day15')}</SelectItem>
              </SelectContent>
            </Select>
          </FormRow>
          <FormRow id={ids.due} label={t('dueDate')} required error={dueError} hint={t('dueHint')}>
            <Input
              id={ids.due}
              type="date"
              dir="ltr"
              min={today}
              value={due}
              onChange={(e) => setDue(e.target.value)}
              aria-invalid={!!dueError}
              className={NUMBER_INPUT}
            />
          </FormRow>
        </div>

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertCircleIcon />
            <AlertDescription>{message(error)}</AlertDescription>
          </Alert>
        )}

        {preview && (
          <section aria-label={t('previewTitle')} className="flex flex-col gap-3">
            <p role="status" className="font-semibold">
              {t('summary', {
                count: preview.meta.willIssue,
                families: preview.meta.families,
                month: monthLabel(period, locale),
              })}{' '}
              {Object.entries(preview.meta.totals).map(([cur, v], i) => (
                <span key={cur}>
                  {i > 0 && ' + '}
                  <Money amount={v} currency={cur} />
                </span>
              ))}
            </p>
            {preview.data.length === 0 ? (
              <p className="text-muted-foreground">{t('noFamilies')}</p>
            ) : (
              <div className="max-h-80 overflow-auto rounded-lg border">
                <Table aria-label={t('previewTitle')} className="tabular-nums">
                  <TableHeader className="sticky top-0 bg-subtle">
                    <TableRow className="hover:bg-subtle">
                      <TableHead className="text-[0.8125rem] font-semibold">
                        {t('family')}
                      </TableHead>
                      <TableHead className="text-[0.8125rem] font-semibold">
                        {t('children')}
                      </TableHead>
                      <TableHead className="text-end text-[0.8125rem] font-semibold">
                        {t('amount')}
                      </TableHead>
                      <TableHead className="text-[0.8125rem] font-semibold">
                        {t('result')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.data.map((r) => (
                      <TableRow key={r.familyId}>
                        <TableCell className="font-medium">{r.familyName}</TableCell>
                        <TableCell>{r.children}</TableCell>
                        <TableCell className="text-end">
                          {r.currency && r.lines.length ? (
                            <Money amount={r.total} currency={r.currency} />
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell>
                          {r.willIssue ? (
                            <ToneBadge tone="green" icon={CircleCheckIcon} label={t('willIssue')} />
                          ) : r.existingInvoiceId ? (
                            <ToneBadge tone="grey" icon={CopyCheckIcon} label={t('exists')} />
                          ) : (
                            <ToneBadge
                              tone="amber"
                              icon={TriangleAlertIcon}
                              label={warningLabel(r.warnings[0] ?? 'no_fee', locale)}
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {preview.meta.willIssue > 0 && !dueError && (
              <p className="text-sm text-muted-foreground">
                {t('dueOn', { date: formatDate(due, locale) ?? due })}
              </p>
            )}
          </section>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy}>
              {tf('cancel')}
            </Button>
          </DialogClose>
          {!preview ? (
            <Button disabled={busy || !periodOk} onClick={() => load.mutate()}>
              {load.isPending && <Spinner />}
              {t('preview')}
            </Button>
          ) : (
            <Button
              disabled={busy || !!dueError || preview.meta.willIssue === 0}
              onClick={() => run.mutate()}
            >
              {run.isPending && <Spinner />}
              {t('issue', { count: preview.meta.willIssue })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
