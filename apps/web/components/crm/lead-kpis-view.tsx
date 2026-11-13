'use client';

import {
  LEAD_SOURCE_LABELS,
  LOST_REASON_LABELS,
  type LeadKpiRowDto,
  type RateDto,
} from '@qarabic/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { ChartNoAxesColumnIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { DateRangeFilters } from '@/components/accounting/accounting-bits';
import { PageHeader } from '@/components/page-header';
import { KeyFacts } from '@/components/people/detail';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { crmKeys, fetchLeadKpis } from '@/lib/api/crm';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';
import { addDays, dateKeyIn } from '@/lib/schedule-time';

/**
 * «مؤشرات العملاء المحتملين» (T5, docs/33 §6): for the leads that came in a period, how fast they
 * were answered, how many booked a trial, came to it and became regular, and how long that took —
 * in total and by source, owner, teacher and course; and why leads were lost. Real data only: a
 * rate with nothing to divide shows «—», never 0 %.
 */
export function LeadKpisView() {
  const t = useTranslations('crm.kpis');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const allowed = can(me, 'leads.view');
  const today = dateKeyIn('Africa/Cairo');
  const to = params.get('to') || today;
  const from = params.get('from') || addDays(to, -29);
  const bad = from > to;
  const query = { from, to };
  const kpis = useQuery({
    queryKey: crmKeys.kpis(query),
    queryFn: ({ signal }) => fetchLeadKpis(query, signal),
    enabled: allowed && !bad,
  });
  const header = (
    <PageHeader
      title={t('title')}
      description={t('description')}
      back={{ href: '/leads', label: t('back') }}
    />
  );
  if (!allowed || isApiError(kpis.error, 403)) {
    return (
      <>
        {header}
        <ForbiddenState />
      </>
    );
  }

  const pct = (r: RateDto): ReactNode =>
    r.pct === null ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      <span>
        <bdi className="font-semibold tabular-nums">{t('pct', { pct: r.pct })}</bdi>{' '}
        <span className="text-sm text-muted-foreground">
          ({t('ofTotal', { n: r.numerator, total: r.denominator })})
        </span>
      </span>
    );
  const minutes = (m: number | null) =>
    m === null
      ? '—'
      : m >= 120
        ? t('hours', { count: Math.round(m / 60) })
        : t('minutes', { count: m });
  const days = (d: number | null) => (d === null ? '—' : t('days', { count: Math.round(d) }));

  const leadColumns = (row: LeadKpiRowDto) => [
    <TableCell key="leads" className="text-end tabular-nums">
      {row.leads}
    </TableCell>,
    <TableCell key="first" className="text-end">
      {minutes(row.firstResponse.medianMinutes)}
    </TableCell>,
    <TableCell key="sla" className="text-end">
      {pct(row.firstResponse.withinSla)}
    </TableCell>,
    <TableCell key="trial" className="text-end">
      {pct(row.leadToTrial)}
    </TableCell>,
    <TableCell key="show" className="text-end">
      {pct(row.trialShowUp)}
    </TableCell>,
    <TableCell key="regular" className="text-end">
      {pct(row.trialToRegular)}
    </TableCell>,
    <TableCell key="daysTo" className="text-end">
      {days(row.medianDaysToRegular)}
    </TableCell>,
  ];
  const leadHead = (first: string) => (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <TableHead>{first}</TableHead>
        <TableHead className="text-end">{t('cols.leads')}</TableHead>
        <TableHead className="text-end">{t('cols.firstResponse')}</TableHead>
        <TableHead className="text-end">{t('cols.withinSla')}</TableHead>
        <TableHead className="text-end">{t('cols.leadToTrial')}</TableHead>
        <TableHead className="text-end">{t('cols.showUp')}</TableHead>
        <TableHead className="text-end">{t('cols.toRegular')}</TableHead>
        <TableHead className="text-end">{t('cols.daysToRegular')}</TableHead>
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

  const d = kpis.data;
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
      {bad ? null : kpis.isError ? (
        <ErrorState onRetry={() => void kpis.refetch()} />
      ) : !d ? (
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
      ) : d.total.leads === 0 && d.lostTotal === 0 ? (
        <EmptyState icon={ChartNoAxesColumnIcon} title={t('emptyTitle')} description={t('empty')} />
      ) : (
        <>
          <section aria-label={t('summary')}>
            <KeyFacts
              items={[
                { label: t('cols.leads'), value: d.total.leads },
                {
                  label: t('cols.firstResponse'),
                  value: minutes(d.total.firstResponse.medianMinutes),
                },
                { label: t('cols.leadToTrial'), value: pct(d.total.leadToTrial) },
                { label: t('cols.toRegular'), value: pct(d.total.trialToRegular) },
              ]}
            />
          </section>
          {section(
            'kpi-sources',
            t('bySource'),
            <Table aria-labelledby="kpi-sources">
              {leadHead(t('cols.source'))}
              <TableBody>
                {d.bySource.map((r) => (
                  <TableRow key={r.source}>
                    <TableCell className="font-medium">
                      {LEAD_SOURCE_LABELS[r.source][locale]}
                    </TableCell>
                    {leadColumns(r)}
                  </TableRow>
                ))}
                <TableRow className="font-semibold">
                  <TableCell>{t('total')}</TableCell>
                  {leadColumns(d.total)}
                </TableRow>
              </TableBody>
            </Table>,
          )}
          {section(
            'kpi-owners',
            t('byAssignee'),
            <Table aria-labelledby="kpi-owners">
              {leadHead(t('cols.owner'))}
              <TableBody>
                {d.byAssignee.map((r) => (
                  <TableRow key={r.user?.id ?? 'none'}>
                    <TableCell className="font-medium">
                      {r.user ? <bdi>{r.user.name}</bdi> : t('unassigned')}
                    </TableCell>
                    {leadColumns(r)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>,
          )}
          <div className="grid gap-4 xl:grid-cols-2">
            {section(
              'kpi-teachers',
              t('byTeacher'),
              <Table aria-labelledby="kpi-teachers">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t('cols.teacher')}</TableHead>
                    <TableHead className="text-end">{t('cols.trials')}</TableHead>
                    <TableHead className="text-end">{t('cols.showUp')}</TableHead>
                    <TableHead className="text-end">{t('cols.toRegular')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.byTeacher.map((r) => (
                    <TableRow key={r.teacher.id}>
                      <TableCell className="font-medium">
                        <bdi>{r.teacher.name}</bdi>
                      </TableCell>
                      <TableCell className="text-end tabular-nums">{r.trials}</TableCell>
                      <TableCell className="text-end">{pct(r.showUp)}</TableCell>
                      <TableCell className="text-end">{pct(r.toRegular)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>,
            )}
            {section(
              'kpi-courses',
              t('byCourse'),
              <Table aria-labelledby="kpi-courses">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t('cols.course')}</TableHead>
                    <TableHead className="text-end">{t('cols.trials')}</TableHead>
                    <TableHead className="text-end">{t('cols.showUp')}</TableHead>
                    <TableHead className="text-end">{t('cols.toRegular')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.byCourse.map((r) => (
                    <TableRow key={r.course.id}>
                      <TableCell className="font-medium">
                        {locale === 'ar' ? r.course.nameAr : r.course.nameEn}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">{r.trials}</TableCell>
                      <TableCell className="text-end">{pct(r.showUp)}</TableCell>
                      <TableCell className="text-end">{pct(r.toRegular)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>,
            )}
          </div>
          {section(
            'kpi-lost',
            t('lostReasons', { count: d.lostTotal }),
            <Table aria-labelledby="kpi-lost">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('cols.reason')}</TableHead>
                  <TableHead className="text-end">{t('cols.count')}</TableHead>
                  <TableHead>{t('cols.bySource')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.lostReasons.map((r) => (
                  <TableRow key={r.reason}>
                    <TableCell className="font-medium">
                      {LOST_REASON_LABELS[r.reason][locale]}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{r.count}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.bySource.length ? (
                        <span className="flex flex-wrap gap-x-3 gap-y-1">
                          {r.bySource.map((x) => (
                            <span key={x.source}>
                              {LEAD_SOURCE_LABELS[x.source][locale]}{' '}
                              <bdi className="tabular-nums">{x.count}</bdi>
                            </span>
                          ))}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
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
