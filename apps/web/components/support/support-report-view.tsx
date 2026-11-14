'use client';

import {
  TICKET_CATEGORY_LABELS,
  TICKET_CHANNEL_LABELS,
  TICKET_QUEUE_LABELS,
  type SupportReportRowDto,
} from '@qarabic/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { ChartNoAxesColumnIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { DateRangeFilters } from '@/components/accounting/accounting-bits';
import { RefreshFailed, refreshState } from '@/components/list/refresh-failed';
import { Col, RowHead } from '@/components/list/report-table';
import { PageHeader } from '@/components/page-header';
import { KeyFacts } from '@/components/people/detail';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchSupportReport, supportKeys } from '@/lib/api/support';
import { can } from '@/lib/auth/use-me';
import { ACADEMY_TZ } from '@/lib/billing/labels';
import { useListParams } from '@/lib/list-params';
import { addDays, dateKeyIn, dayLabel } from '@/lib/schedule-time';
import { intlLocale } from '@/lib/time';

const MAX_DAYS = 366;
const COLS = ['created', 'open', 'firstResponse', 'slaMet', 'resolve'] as const;

/**
 * «تقرير تواصل معنا» (S4, docs/32 §8): the requests that came in a period, in the viewer's queues —
 * how many, how many still open, how fast the first answer came and how often inside the deadline,
 * and how long they took to close; by queue, category and channel, and week by week. A rate with
 * nothing to divide shows «—», never 0 %.
 */
export function SupportReportView() {
  const t = useTranslations('support.reports');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const allowed = can(me, 'support.view');
  const today = dateKeyIn(ACADEMY_TZ);
  const to = params.get('to') || today;
  const from = params.get('from') || addDays(to, -29);
  const bad = from > to;
  const tooLong = !bad && (Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_DAYS;
  const query = { from, to };
  const report = useQuery({
    queryKey: supportKeys.report(query),
    queryFn: ({ signal }) => fetchSupportReport(query, signal),
    enabled: allowed && !bad && !tooLong,
  });
  const live = refreshState(report);
  const header = (
    <PageHeader
      title={t('title')}
      description={t('description')}
      back={{ href: '/support', label: t('back') }}
    />
  );
  if (!allowed || isApiError(report.error, 403)) {
    return (
      <>
        {header}
        <ForbiddenState />
      </>
    );
  }

  const percent = new Intl.NumberFormat(intlLocale(locale), {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const dash = <span className="text-muted-foreground">—</span>;
  const first = (m: number | null): ReactNode =>
    m === null
      ? dash
      : m >= 120
        ? t('hours', { count: Math.round(m / 60) })
        : t('minutes', { count: m });
  const sla = (r: SupportReportRowDto): ReactNode =>
    r.slaMet.pct === null ? (
      dash
    ) : (
      <span>
        <bdi className="font-semibold tabular-nums">{percent.format(r.slaMet.pct / 100)}</bdi>{' '}
        <span className="text-sm text-muted-foreground">
          ({t('ofTotal', { n: r.slaMet.numerator, total: r.slaMet.denominator })})
        </span>
      </span>
    );
  const resolve = (h: number | null): ReactNode =>
    h === null
      ? dash
      : h >= 48
        ? t('days', { count: Math.round(h / 24) })
        : t('hours', { count: Math.round(h) });
  const cells = (r: SupportReportRowDto): ReactNode[] => [
    <TableCell key="created" className="text-end tabular-nums">
      {r.created}
    </TableCell>,
    <TableCell key="open" className="text-end tabular-nums">
      {r.open}
    </TableCell>,
    <TableCell key="first" className="text-end">
      {first(r.firstResponseMedianMinutes)}
    </TableCell>,
    <TableCell key="sla" className="text-end">
      {sla(r)}
    </TableCell>,
    <TableCell key="resolve" className="text-end">
      {resolve(r.resolveMedianHours)}
    </TableCell>,
  ];
  const head = (first: string) => (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <Col>{first}</Col>
        {COLS.map((c) => (
          <Col key={c} end>
            {t(`cols.${c}`)}
          </Col>
        ))}
      </TableRow>
    </TableHeader>
  );
  const section = (id: string, title: string, body: ReactNode) => (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="border-b py-4">
        <CardTitle className="text-base font-bold">
          <h2 id={id}>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">{body}</CardContent>
    </Card>
  );
  const grouped = <T extends SupportReportRowDto>(
    id: string,
    title: string,
    first: string,
    rows: T[],
    label: (r: T) => string,
    key: (r: T) => string,
    total?: SupportReportRowDto,
  ) =>
    section(
      id,
      title,
      <Table aria-labelledby={id}>
        {head(first)}
        <TableBody>
          {rows.map((r) => (
            <TableRow key={key(r)}>
              <RowHead>{label(r)}</RowHead>
              {cells(r)}
            </TableRow>
          ))}
        </TableBody>
        {total && (
          <TableFooter>
            <TableRow className="font-semibold">
              <RowHead className="bg-muted">{t('total')}</RowHead>
              {cells(total)}
            </TableRow>
          </TableFooter>
        )}
      </Table>,
    );

  const d = report.data;
  return (
    <div className="flex flex-col gap-4">
      {header}
      <div className="flex flex-wrap items-end gap-3" role="search">
        <DateRangeFilters
          from={from}
          to={to}
          onChange={(v) => params.set(v, { resetPage: false })}
        />
      </div>
      {live.stale && <RefreshFailed onRetry={() => void report.refetch()} />}
      {bad ? null : tooLong || isApiError(report.error, 422) ? (
        <p role="alert" className="text-sm text-destructive">
          {t('rangeTooLong')}
        </p>
      ) : live.failed ? (
        <ErrorState onRetry={() => void report.refetch()} />
      ) : !d ? (
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
      ) : d.total.created === 0 ? (
        <EmptyState icon={ChartNoAxesColumnIcon} title={t('emptyTitle')} description={t('empty')} />
      ) : (
        <>
          <section aria-label={t('summary')}>
            <KeyFacts
              items={[
                { label: t('cols.created'), value: d.total.created },
                { label: t('cols.open'), value: d.total.open },
                {
                  label: t('cols.firstResponse'),
                  value: first(d.total.firstResponseMedianMinutes),
                },
                { label: t('cols.slaMet'), value: sla(d.total) },
                { label: t('cols.resolve'), value: resolve(d.total.resolveMedianHours) },
              ]}
            />
          </section>
          {grouped(
            'report-queues',
            t('byQueue'),
            t('cols.queue'),
            d.byQueue,
            (r) => TICKET_QUEUE_LABELS[r.queue][locale],
            (r) => r.queue,
            d.total,
          )}
          <div className="grid gap-4 xl:grid-cols-2">
            {grouped(
              'report-categories',
              t('byCategory'),
              t('cols.category'),
              d.byCategory,
              (r) => TICKET_CATEGORY_LABELS[r.category][locale],
              (r) => r.category,
              d.total,
            )}
            {grouped(
              'report-channels',
              t('byChannel'),
              t('cols.channel'),
              d.byChannel,
              (r) => TICKET_CHANNEL_LABELS[r.channel][locale],
              (r) => r.channel,
              d.total,
            )}
          </div>
          {section(
            'report-weeks',
            t('byWeek'),
            <Table aria-labelledby="report-weeks">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <Col>{t('cols.week')}</Col>
                  <Col end>{t('cols.created')}</Col>
                  <Col end>{t('cols.closed')}</Col>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.byWeek.map((w) => (
                  <TableRow key={w.weekStart}>
                    <RowHead>{t('weekOf', { date: dayLabel(w.weekStart, locale) })}</RowHead>
                    <TableCell className="text-end tabular-nums">{w.created}</TableCell>
                    <TableCell className="text-end tabular-nums">{w.closed}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>,
          )}
        </>
      )}
    </div>
  );
}
