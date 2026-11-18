'use client';

import {
  DASHBOARD_EVENT_LABELS,
  DASHBOARD_WAITING_LABELS,
  type DashboardEventDto,
  type DashboardWaitingItemDto,
} from '@qarabic/shared';
import { Badge } from '@qarabic/ui/components/badge';
import { Button } from '@qarabic/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@qarabic/ui/components/item';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronLeftIcon, CircleCheckIcon, HistoryIcon, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Money } from '@/components/billing/billing-bits';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { dashboardKeys, fetchDashboardEvents } from '@/lib/api/dashboard';
import { dayAndClock, relativeTime } from '@/lib/schedule-time';
import { formatDate, formatInstant, intlLocale } from '@/lib/time';

const EVENTS_PAGE = 8;

/** A row-3 panel (docs/40 §3): the chart cards' header, with its own loading, error and empty. */
function Panel({
  id,
  title,
  description,
  loading,
  error,
  onRetry,
  empty,
  children,
}: {
  id: string;
  title: string;
  description: string;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  empty: { icon: LucideIcon; text: string } | null;
  children: ReactNode;
}) {
  const t = useTranslations('dashboard.panel');
  const Icon = empty?.icon;
  return (
    <Card className="min-w-0 gap-3 shadow-none" aria-labelledby={id}>
      <CardHeader>
        <CardTitle>
          <h3 id={id} className="text-base font-bold">
            {title}
          </h3>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {loading ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : error ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <p role="alert">{t('error')}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t('retry')}
            </Button>
          </div>
        ) : empty && Icon ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Icon aria-hidden className="size-6" />
            {empty.text}
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

/**
 * «بانتظار إجراء» (docs/40 §3 row 3, D3): the queues the viewer may open (`waiting` of
 * GET /dashboard/metrics, live and not range-bound), each a link to its filtered list. A queue at 0
 * is not listed; all at 0 says so.
 */
export function WaitingPanel({
  items,
  loading,
  error,
  onRetry,
}: {
  items: DashboardWaitingItemDto[] | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations('dashboard.waiting');
  const locale = useUiLocale();
  const open = (items ?? []).filter((i) => i.count > 0);
  const count = new Intl.NumberFormat(intlLocale(locale));
  return (
    <Panel
      id="dash-waiting"
      title={t('title')}
      description={t('description')}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={open.length === 0 ? { icon: CircleCheckIcon, text: t('empty') } : null}
    >
      <ItemGroup className="gap-1">
        {open.map((i) => (
          <div role="listitem" key={i.key}>
            <Item asChild size="sm" variant="outline">
              <Link href={i.href}>
                <ItemContent>
                  <ItemTitle>{DASHBOARD_WAITING_LABELS[i.key][locale]}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Badge variant="secondary" className="tabular-nums">
                    <bdi>{count.format(i.count)}</bdi>
                  </Badge>
                  <ChevronLeftIcon aria-hidden className="size-4 ltr:-scale-x-100" />
                </ItemActions>
              </Link>
            </Item>
          </div>
        ))}
      </ItemGroup>
    </Panel>
  );
}

/** The screen an event is about, when there is one to open. */
export function eventHref(e: DashboardEventDto): string | null {
  const id = e.subject.id;
  switch (e.kind) {
    case 'payment_received':
    case 'payment_refunded':
      return typeof e.data.invoiceId === 'number' ? `/invoices/${e.data.invoiceId}` : null;
    case 'invoice_issued':
    case 'invoice_voided':
      return id === null ? null : `/invoices/${id}`;
    case 'lead_converted':
    case 'trial_booked':
      return id === null ? null : `/leads/${id}`;
    case 'payroll_approved':
      return id === null ? null : `/payroll/runs/${id}`;
    case 'payslip_paid':
      return id === null ? null : `/payroll/payslips/${id}`;
    case 'class_cancelled':
      return id === null ? null : `/today?session=${id}`;
  }
}

/** The one or two facts of an event worth a line (never the raw record). */
function EventFacts({ e }: { e: DashboardEventDto }) {
  const locale = useUiLocale();
  const tz = useViewerTz();
  const str = (k: string) => (typeof e.data[k] === 'string' ? (e.data[k] as string) : null);
  const amount = (k: string) => {
    const v = e.data[k];
    return typeof v === 'number' || typeof v === 'string' ? String(v) : null;
  };
  switch (e.kind) {
    case 'payment_received':
    case 'payment_refunded': {
      const a = amount('amount');
      return a ? <Money amount={a} currency={str('currency')} /> : null;
    }
    case 'invoice_issued': {
      const total = amount('total');
      return (
        <>
          {str('number') && <bdi>{str('number')}</bdi>}
          {total && (
            <>
              {' · '}
              <Money amount={total} currency={str('currency')} />
            </>
          )}
        </>
      );
    }
    case 'trial_booked':
    case 'class_cancelled': {
      const at = str('startsAt');
      return at ? <>{dayAndClock(at, tz, locale)}</> : null;
    }
    case 'payroll_approved': {
      const p = str('period');
      if (!p || !/^\d{4}-\d{2}$/.test(p)) return p ? <bdi>{p}</bdi> : null;
      return (
        <>
          {new Intl.DateTimeFormat(intlLocale(locale), {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
          }).format(new Date(`${p}-01T00:00:00Z`))}
        </>
      );
    }
    case 'payslip_paid':
      return <>{formatDate(str('paidOn'), locale)}</>;
    default:
      return null;
  }
}

/**
 * «آخر الأحداث» (docs/40 §3 row 3, GET /dashboard/events): business events newest first, only the
 * kinds the viewer's modules allow (the API's rule). Staff only, so who did it is named; an event
 * without a person is the system's. Each row opens what it is about; «عرض المزيد» pages back.
 */
export function RecentEventsPanel() {
  const t = useTranslations('dashboard.events');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const now = useNow(60_000);
  const query = useInfiniteQuery({
    queryKey: dashboardKeys.events,
    queryFn: ({ pageParam, signal }) =>
      fetchDashboardEvents({ limit: EVENTS_PAGE, before: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    refetchInterval: 120_000,
  });
  const events = query.data?.pages.flatMap((p) => p.events) ?? [];
  return (
    <Panel
      id="dash-events"
      title={t('title')}
      description={t('description')}
      loading={query.isPending}
      error={query.isError && !query.data}
      onRetry={() => void query.refetch()}
      empty={events.length === 0 ? { icon: HistoryIcon, text: t('empty') } : null}
    >
      <ItemGroup className="gap-1">
        {events.map((e) => {
          const href = eventHref(e);
          const body = (
            <>
              <ItemContent className="min-w-0">
                <ItemTitle>{DASHBOARD_EVENT_LABELS[e.kind][locale]}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  <EventFacts e={e} />
                </ItemDescription>
                <ItemDescription className="line-clamp-none text-xs">
                  {e.actor ? <bdi>{e.actor.name}</bdi> : t('system')}
                  {' · '}
                  <time dateTime={e.at} title={formatInstant(e.at, tz, locale) ?? undefined}>
                    {relativeTime(e.at, now, locale)}
                  </time>
                </ItemDescription>
              </ItemContent>
              {href && (
                <ItemActions>
                  <ChevronLeftIcon aria-hidden className="size-4 ltr:-scale-x-100" />
                </ItemActions>
              )}
            </>
          );
          return (
            <div role="listitem" key={e.key}>
              {href ? (
                <Item asChild size="sm">
                  <Link href={href}>{body}</Link>
                </Item>
              ) : (
                <Item size="sm">{body}</Item>
              )}
            </div>
          );
        })}
      </ItemGroup>
      {query.isFetchNextPageError && (
        <p role="alert" className="text-sm text-muted-foreground">
          {t('moreError')}
        </p>
      )}
      {query.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage && <Spinner />}
          {t('more')}
        </Button>
      )}
    </Panel>
  );
}
