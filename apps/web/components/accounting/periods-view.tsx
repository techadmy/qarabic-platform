'use client';

import { OUTBOX_SOURCES, PERIOD_STATUS_LABELS, type AccountingPeriodDto } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@qarabic/ui/components/alert-dialog';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LockIcon,
  LockOpenIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { KeyFacts } from '@/components/people/detail';
import { PageHeader } from '@/components/page-header';
import { ToneBadge } from '@/components/sessions/badges';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState, ForbiddenState } from '@/components/states';
import {
  accountingKeys,
  closePeriod,
  fetchOutbox,
  fetchPeriods,
  processOutbox,
  reopenPeriod,
} from '@/lib/api/accounting';
import { isApiError } from '@/lib/api/client';
import { academyToday } from '@/lib/accounting/forms';
import { can } from '@/lib/auth/use-me';
import { monthLabel } from '@/lib/billing/labels';
import { useListParams } from '@/lib/list-params';
import { relativeTime } from '@/lib/schedule-time';
import { formatInstant } from '@/lib/time';
import { useAccountingError } from './accounting-bits';

/**
 * Automatic entries waiting in the billing and payroll outboxes (posted every 5 minutes by the
 * API job), the ones that failed and why, and «رحّل الآن» (accounting.manage).
 */
function OutboxCard() {
  const t = useTranslations('accounting.outbox');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const now = useNow(60_000);
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = useAccountingError();
  const status = useQuery({
    queryKey: accountingKeys.outbox,
    queryFn: ({ signal }) => fetchOutbox(signal),
    refetchInterval: 60_000,
  });
  const run = useMutation({
    mutationFn: processOutbox,
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: accountingKeys.all });
      toast.success(t('processed', { posted: r.posted, failed: r.failed }));
    },
    onError: (e) => toast.error(message(e)),
  });
  if (status.isError) return <ErrorState onRetry={() => void status.refetch()} />;
  if (!status.data) return <Skeleton className="h-40" />;
  const s = status.data;
  const pending = OUTBOX_SOURCES.reduce((n, src) => n + (s.pending[src] ?? 0), 0);
  return (
    <Card className="gap-4 shadow-none" aria-labelledby="outbox-title">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-base font-bold">
            <h2 id="outbox-title">{t('title')}</h2>
          </CardTitle>
          <p className="text-sm text-muted-foreground">{t('hint')}</p>
        </div>
        {can(me, 'accounting.manage') && (
          <Button
            variant="outline"
            className="h-10"
            disabled={run.isPending || pending === 0}
            onClick={() => run.mutate()}
          >
            {run.isPending ? <Spinner /> : <RefreshCwIcon />}
            {t('processNow')}
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <KeyFacts
          items={[
            ...OUTBOX_SOURCES.map((src) => ({
              label: t(`pending.${src}`),
              value: s.pending[src] ?? 0,
            })),
            {
              label: t('oldest'),
              value: s.oldestPendingAt ? (
                <span className="text-base">{relativeTime(s.oldestPendingAt, now, locale)}</span>
              ) : (
                '—'
              ),
            },
            { label: t('failed'), value: s.failures.length },
          ]}
        />
        {s.failures.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="font-semibold">{t('failures')}</h3>
            <ul className="flex flex-col divide-y rounded-lg border">
              {s.failures.map((f) => (
                <li key={`${f.source}-${f.eventId}`} className="flex flex-col gap-1 p-3 text-sm">
                  <span className="flex flex-wrap items-center gap-2 font-semibold">
                    {t(`pending.${f.source}`)}
                    <bdi dir="ltr" className="font-normal text-muted-foreground">
                      {f.eventType} #{f.eventId}
                    </bdi>
                  </span>
                  <bdi dir="ltr" className="text-destructive">
                    {f.error}
                  </bdi>
                  <span className="text-muted-foreground">
                    {t('attempts', {
                      count: f.attempts,
                      when: formatInstant(f.lastAttemptAt, tz, locale) ?? '',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * «الفترات المحاسبية» (M7, D95): the twelve months of a year, open or closed, with their entry
 * counts. Closing a month (after it ends, with no automatic entries still waiting for it) stops any
 * posting dated in it; reopening needs a reason. The outbox card above shows what is still waiting.
 */
export function PeriodsView() {
  const t = useTranslations('accounting.periods');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const params = useListParams();
  const queryClient = useQueryClient();
  const message = useAccountingError();
  const thisYear = Number(academyToday().slice(0, 4));
  const yearParam = Number(params.get('year'));
  const year = yearParam >= 2000 && yearParam <= 2100 ? yearParam : thisYear;
  const [closing, setClosing] = useState<AccountingPeriodDto | null>(null);
  const [reopening, setReopening] = useState<AccountingPeriodDto | null>(null);
  const allowed = can(me, 'accounting.view');
  const manage = can(me, 'accounting.manage');
  const periods = useQuery({
    queryKey: accountingKeys.periods(year),
    queryFn: ({ signal }) => fetchPeriods(year, signal),
    enabled: allowed,
  });
  const done = (text: string) => () => {
    void queryClient.invalidateQueries({ queryKey: accountingKeys.all });
    setClosing(null);
    setReopening(null);
    toast.success(text);
  };
  const close = useMutation({
    mutationFn: (p: string) => closePeriod(p),
    onSuccess: (_, p) => done(t('closed', { month: monthLabel(p, locale) }))(),
  });
  const reopen = useMutation({
    mutationFn: (v: { period: string; reason: string }) => reopenPeriod(v.period, v.reason),
    onSuccess: (_, v) => done(t('reopened', { month: monthLabel(v.period, locale) }))(),
  });
  if (!allowed || isApiError(periods.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const current = academyToday().slice(0, 7);
  const goYear = (y: number) => params.set({ year: y === thisYear ? null : y });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-lg"
              aria-label={t('prevYear')}
              onClick={() => goYear(year - 1)}
            >
              <ChevronRightIcon className="ltr:rotate-180" />
            </Button>
            <span
              className="min-w-16 text-center text-lg font-bold tabular-nums"
              aria-live="polite"
            >
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
        }
      />
      <OutboxCard />
      {periods.isError ? (
        <ErrorState onRetry={() => void periods.refetch()} />
      ) : (
        <Card className="gap-0 overflow-x-auto py-0 shadow-none">
          <Table aria-label={t('tableLabel', { year })}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('month')}</TableHead>
                <TableHead>{t('status')}</TableHead>
                <TableHead className="hidden text-end sm:table-cell">{t('entries')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('closedBy')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(periods.data ?? []).map((p) => {
                const isClosed = p.status === 'closed';
                const ended = p.period < current;
                const label = monthLabel(p.period, locale);
                return (
                  <TableRow key={p.period}>
                    <TableCell className="font-medium whitespace-nowrap">
                      {label}
                      {p.period === current && (
                        <span className="ms-2 text-sm text-primary">({t('current')})</span>
                      )}
                      <span className="block text-sm font-normal text-muted-foreground sm:hidden">
                        {t('entriesCount', { count: p.entries })}
                      </span>
                    </TableCell>
                    <TableCell>
                      <ToneBadge
                        tone={isClosed ? 'grey' : 'green'}
                        icon={isClosed ? LockIcon : LockOpenIcon}
                        label={PERIOD_STATUS_LABELS[p.status][locale]}
                      />
                    </TableCell>
                    <TableCell className="hidden text-end tabular-nums sm:table-cell">
                      {p.entries}
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                      {isClosed && p.closedBy
                        ? `${p.closedBy.name} · ${formatInstant(p.closedAt, tz, locale)}`
                        : p.reopenReason
                          ? t('reopenedBecause', { reason: p.reopenReason })
                          : '—'}
                    </TableCell>
                    <TableCell className="text-end">
                      {manage && isClosed && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-9"
                          onClick={() => setReopening(p)}
                        >
                          <LockOpenIcon />
                          {t('reopen')}
                          <span className="sr-only">: {label}</span>
                        </Button>
                      )}
                      {manage && !isClosed && ended && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-9"
                          onClick={() => setClosing(p)}
                        >
                          <LockIcon />
                          {t('close')}
                          <span className="sr-only">: {label}</span>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {periods.isPending &&
                Array.from({ length: 6 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={5}>
                      <Skeleton className="h-6" />
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <AlertDialog
        open={!!closing}
        onOpenChange={(o) => {
          if (!o) {
            setClosing(null);
            close.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {closing && t('closeTitle', { month: monthLabel(closing.period, locale) })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('closeHint')}</AlertDialogDescription>
          </AlertDialogHeader>
          {close.isError && (
            <Alert variant="destructive" role="alert">
              <AlertCircleIcon />
              <AlertDescription>{message(close.error)}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={close.isPending}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={close.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (closing) close.mutate(closing.period);
              }}
            >
              {close.isPending && <Spinner />}
              {t('close')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ReasonDialog
        open={!!reopening}
        onOpenChange={(o) => {
          if (!o) {
            setReopening(null);
            reopen.reset();
          }
        }}
        title={reopening ? t('reopenTitle', { month: monthLabel(reopening.period, locale) }) : ''}
        description={t('reopenHint')}
        confirmLabel={t('reopen')}
        textLabel={t('reason')}
        textRequired
        textMin={3}
        busy={reopen.isPending}
        error={reopen.isError ? message(reopen.error) : null}
        onConfirm={({ text }) =>
          reopening && reopen.mutate({ period: reopening.period, reason: text })
        }
      />
    </div>
  );
}
