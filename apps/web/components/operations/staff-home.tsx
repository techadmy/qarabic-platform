'use client';

import { SESSION_STAGE_LABELS, SESSION_STAGES, type SessionStage } from '@qarabic/shared';
import { Card } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { cn } from '@qarabic/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboardIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@qarabic/ui/components/button';
import { Money } from '@/components/billing/billing-bits';
import { PageHeader } from '@/components/page-header';
import { useNow, useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState } from '@/components/states';
import { fetchDashboardSummary, operationsKeys } from '@/lib/api/operations';
import {
  boardHref,
  isEmptyDashboard,
  isUrgent,
  QUEUE_LINKS,
  visibleQueues,
} from '@/lib/operations/dashboard';
import { dayLabel, relativeTime } from '@/lib/schedule-time';

function Tile({
  href,
  label,
  value,
  urgent,
}: {
  href: string;
  label: string;
  value: ReactNode;
  urgent?: boolean;
}) {
  const t = useTranslations('operations.home');
  return (
    <Card size="sm" className="gap-0 p-0 shadow-none transition-colors hover:bg-accent">
      <Link
        href={href}
        className="flex flex-col gap-1 rounded-xl px-4 py-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span
          className={cn(
            'flex items-center gap-1 text-lg font-bold tabular-nums',
            urgent && 'text-destructive',
          )}
        >
          {/* Urgent is said with an icon and words too, never by colour alone (§5.14). */}
          {urgent && <TriangleAlertIcon className="size-4" aria-hidden />}
          <bdi>{value}</bdi>
          {urgent && <span className="sr-only">{t('urgent')}</span>}
        </span>
        <span className="text-sm text-muted-foreground">{label}</span>
      </Link>
    </Card>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-lg font-bold">
        {title}
      </h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">{children}</div>
    </section>
  );
}

/**
 * The staff home (M8, `GET /dashboard/summary`; the old admin home and its header counters, docs/15
 * §3.1): what needs action first (only the queues this person may open; overdue in red), today's
 * classes by stage, then the people and the money. Every tile opens the list it counts. A number
 * the viewer may not see is `null` and its tile is not shown.
 */
export function StaffHomeView() {
  const t = useTranslations('operations.home');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const now = useNow(60_000);
  const query = useQuery({
    queryKey: operationsKeys.dashboard,
    queryFn: ({ signal }) => fetchDashboardSummary(signal),
    refetchInterval: 120_000,
  });
  const d = query.data;
  const header = (
    <PageHeader
      title={t('welcome', { name: me.name })}
      description={d ? dayLabel(d.today, locale, true) : undefined}
      meta={d ? t('updated', { ago: relativeTime(d.generatedAt, now, locale) }) : undefined}
      actions={
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label={t('refresh')}
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCwIcon className={cn(query.isFetching && 'animate-spin')} />
        </Button>
      }
    />
  );
  // A failed background refresh keeps the numbers on screen (below: a quiet note).
  if (query.isError && !d) {
    return (
      <>
        {header}
        <ErrorState onRetry={() => void query.refetch()} />
      </>
    );
  }
  if (!d) {
    return (
      <>
        {header}
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      </>
    );
  }
  const queues = visibleQueues(d);
  const f = d.finance;
  return (
    <div className="flex flex-col gap-6">
      {header}
      {query.isRefetchError && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('stale')}
        </p>
      )}
      {isEmptyDashboard(d) && (
        <EmptyState
          icon={LayoutDashboardIcon}
          title={t('emptyTitle')}
          description={t('emptyHint')}
        />
      )}
      {queues.length > 0 && (
        <Section id="home-queues" title={t('queuesTitle')}>
          {queues.map((q) => (
            <Tile
              key={q}
              href={QUEUE_LINKS[q]}
              label={t(`queues.${q}`)}
              value={d.queues[q]}
              urgent={isUrgent(q, d.queues[q])}
            />
          ))}
        </Section>
      )}
      {d.classesToday && (
        <Section id="home-classes" title={t('classesTitle')}>
          <Tile
            href="/today"
            label={t('classesTotal')}
            value={Object.values(d.classesToday).reduce((a, b) => a + b, 0)}
          />
          {SESSION_STAGES.filter((s) => (d.classesToday![s] ?? 0) > 0).map((s: SessionStage) => (
            <Tile
              key={s}
              href={boardHref(s)}
              label={SESSION_STAGE_LABELS[s][locale]}
              value={d.classesToday![s]}
            />
          ))}
        </Section>
      )}
      {d.people && (
        <Section id="home-people" title={t('peopleTitle')}>
          <Tile href="/families" label={t('people.families')} value={d.people.families} />
          <Tile href="/students" label={t('people.students')} value={d.people.students} />
          <Tile href="/teachers" label={t('people.teachers')} value={d.people.teachers} />
        </Section>
      )}
      {f && (
        <Section id="home-finance" title={t('financeTitle')}>
          {f.overdueInvoices.map((o) => (
            <Tile
              key={`o-${o.currency}`}
              href="/invoices?status=overdue"
              label={t('finance.overdue', { count: o.count })}
              value={<Money amount={o.amount} currency={o.currency} className="text-destructive" />}
            />
          ))}
          {f.receivedThisMonth.map((r) => (
            <Tile
              key={`r-${r.currency}`}
              href="/invoices"
              label={t('finance.received')}
              value={<Money amount={r.amount} currency={r.currency} />}
            />
          ))}
          <Tile href="/payroll" label={t('finance.payroll')} value={f.payrollAwaitingApproval} />
          {f.ledgerPending !== null && (
            <Tile href="/accounting/periods" label={t('finance.ledger')} value={f.ledgerPending} />
          )}
        </Section>
      )}
    </div>
  );
}
