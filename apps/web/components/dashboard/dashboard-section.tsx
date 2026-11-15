'use client';

import type { ChartConfig } from '@qarabic/ui/components/chart';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { RefreshFailed, refreshState } from '@/components/list/refresh-failed';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { academyToday } from '@/lib/accounting/forms';
import { dashboardKeys, fetchDashboardMetrics } from '@/lib/api/dashboard';
import { paramsOf, rangeFromParams } from '@/lib/dashboard/range';
import { CHART_WIDGETS, KPI_WIDGETS, visibleWidgets } from '@/lib/dashboard/widgets';
import { useListParams } from '@/lib/list-params';
import { bucketLabel, ChartCard, SeriesChart } from './charts';
import { Change, KpiCard, Pct, Usd } from './kpi-card';
import { RangeBar } from './range-bar';

/**
 * The management dashboard on the staff home (docs/40, D144): one time control drives every
 * widget; KPI cards with the change against the previous period, each opening the list behind it;
 * then the four main charts. Only the widgets this person's role may see are shown (the API sends
 * `null` for the others). All money in USD.
 */
export function DashboardSection() {
  const t = useTranslations('dashboard');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const today = academyToday();
  const range = rangeFromParams(params.get, today);
  const kpis = visibleWidgets(KPI_WIDGETS, me.permissions);
  const charts = visibleWidgets(CHART_WIDGETS, me.permissions);
  const query = { from: range.from, to: range.to, compare: range.compare, bucket: range.bucket };
  const metrics = useQuery({
    queryKey: dashboardKeys.metrics(query),
    queryFn: ({ signal }) => fetchDashboardMetrics(query, signal),
    enabled: kpis.length + charts.length > 0,
    placeholderData: keepPreviousData,
  });
  if (kpis.length + charts.length === 0) return null;
  const live = refreshState(metrics);
  const d = metrics.data;
  const loading = !d;
  const failed = live.failed;
  const retry = () => void metrics.refetch();
  const week = t('chart.week');
  const label = (b: string) => bucketLabel(b, range.bucket, locale, week);
  const noRate = (s: { bucket: string; missingRate?: boolean }[] | null | undefined) =>
    (s ?? []).filter((p) => p.missingRate).map((p) => label(p.bucket));
  const sum = (s: Record<string, unknown>[] | null | undefined, k: string) =>
    (s ?? []).reduce((a, p) => a + Number(p[k] ?? 0), 0);
  const k = d?.kpis;

  const kpiCard = (key: (typeof kpis)[number]['key'], href: string) => {
    const common = { href, label: t(`kpi.${key}`), loading: loading && !failed };
    if (failed) return <KpiCard key={key} {...common} value="—" detail={t('kpi.error')} />;
    switch (key) {
      case 'activeStudents':
      case 'newStudents':
      case 'teachersOnDuty': {
        const v = k?.[key];
        return (
          <KpiCard
            key={key}
            {...common}
            value={<bdi className="tabular-nums">{v?.value ?? '—'}</bdi>}
            change={v && <Change value={v.value} previous={v.previous} />}
          />
        );
      }
      case 'attendanceRate': {
        const v = k?.attendanceRate;
        return (
          <KpiCard
            key={key}
            {...common}
            value={v ? <Pct value={v.value} /> : '—'}
            change={v && <Change value={v.value} previous={v.previous} />}
          />
        );
      }
      case 'trials': {
        const v = k?.trials;
        return (
          <KpiCard
            key={key}
            {...common}
            value={<bdi className="tabular-nums">{v?.booked.value ?? '—'}</bdi>}
            change={v && <Change value={v.booked.value} previous={v.booked.previous} />}
            detail={
              v &&
              t.rich('kpi.trialsDetail', {
                attended: v.attended.value,
                converted: v.converted.value,
                pct: () => <Pct value={v.conversionPct ?? 0} />,
              })
            }
          />
        );
      }
      case 'collected':
      case 'grossProfit':
      case 'outstanding': {
        const v = k?.[key];
        return (
          <KpiCard
            key={key}
            {...common}
            value={v ? <Usd amount={v.value} /> : '—'}
            change={
              v && (
                <Change
                  value={Number(v.value)}
                  previous={v.previous === null ? null : Number(v.previous)}
                  goodWhenDown={key === 'outstanding'}
                />
              )
            }
            detail={
              key === 'outstanding' &&
              k?.outstanding &&
              t.rich('kpi.overdue', { amount: () => <Usd amount={k.outstanding!.overdue} /> })
            }
            missingRate={v?.missingRate}
          />
        );
      }
    }
  };

  const s = d?.series;
  const chart = (key: (typeof charts)[number]['key']) => {
    const common = {
      id: `dash-${key}`,
      title: t(`chart.${key}.title`),
      description: t(`chart.${key}.description`),
      loading: loading && !failed,
      error: failed,
      onRetry: retry,
    };
    switch (key) {
      case 'finance': {
        const data = s?.finance ?? [];
        const config = {
          revenue: { label: t('chart.finance.revenue'), color: 'var(--primary)' },
          expenses: { label: t('chart.finance.expenses'), color: 'var(--chart-3)' },
          profit: { label: t('chart.finance.profit'), color: 'var(--chart-2)' },
        } satisfies ChartConfig;
        return (
          <ChartCard key={key} {...common} empty={!data.length} missingRate={noRate(s?.finance)}>
            <SeriesChart
              kind="area"
              data={data}
              config={config}
              bucket={range.bucket}
              money
              summary={summaryOf(config, data, sum)}
            />
          </ChartCard>
        );
      }
      case 'collections': {
        const data = s?.collections ?? [];
        const config = {
          collected: { label: t('chart.collections.collected'), color: 'var(--primary)' },
          invoiced: { label: t('chart.collections.invoiced'), color: 'var(--chart-3)' },
        } satisfies ChartConfig;
        return (
          <ChartCard
            key={key}
            {...common}
            empty={!data.length}
            missingRate={noRate(s?.collections)}
          >
            <SeriesChart
              kind="bar"
              data={data}
              config={config}
              bucket={range.bucket}
              money
              summary={summaryOf(config, data, sum)}
            />
          </ChartCard>
        );
      }
      case 'growth': {
        const data = s?.growth ?? [];
        const config = {
          newStudents: { label: t('chart.growth.newStudents'), color: 'var(--primary)' },
          trials: { label: t('chart.growth.trials'), color: 'var(--chart-3)' },
          converted: { label: t('chart.growth.converted'), color: 'var(--chart-2)' },
        } satisfies ChartConfig;
        return (
          <ChartCard key={key} {...common} empty={!data.length}>
            <SeriesChart
              kind="line"
              data={data}
              config={config}
              bucket={range.bucket}
              summary={summaryOf(config, data, sum)}
            />
          </ChartCard>
        );
      }
      case 'outcomes': {
        const data = s?.outcomes ?? [];
        const config = {
          taken: { label: t('chart.outcomes.taken'), color: 'var(--primary)' },
          absent: { label: t('chart.outcomes.absent'), color: 'var(--chart-2)' },
          leave: { label: t('chart.outcomes.leave'), color: 'var(--chart-3)' },
          declined: { label: t('chart.outcomes.declined'), color: 'var(--chart-4)' },
          cancelled: { label: t('chart.outcomes.cancelled'), color: 'var(--chart-5)' },
        } satisfies ChartConfig;
        return (
          <ChartCard key={key} {...common} empty={!data.length}>
            <SeriesChart
              kind="stacked"
              data={data}
              config={config}
              bucket={range.bucket}
              summary={summaryOf(config, data, sum)}
            />
          </ChartCard>
        );
      }
    }
  };

  return (
    <section aria-labelledby="dash-title" className="flex flex-col gap-4">
      <h2 id="dash-title" className="sr-only">
        {t('title')}
      </h2>
      <RangeBar
        range={range}
        today={today}
        onChange={(next) => params.set(paramsOf(next), { resetPage: false })}
      />
      {live.stale && <RefreshFailed onRetry={retry} />}
      {kpis.length > 0 && (
        <div
          className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4"
          aria-busy={loading || undefined}
        >
          {kpis.map((w) => kpiCard(w.key, w.href))}
        </div>
      )}
      {charts.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">{charts.map((w) => chart(w.key))}</div>
      )}
    </section>
  );
}

/** «الإيرادات: 12,400 · المصروفات: 7,100…»: what a chart shows, said once. */
function summaryOf(
  config: ChartConfig,
  data: Record<string, unknown>[],
  sum: (s: Record<string, unknown>[] | null | undefined, k: string) => number,
): string {
  return Object.entries(config)
    .map(([k, v]) => `${String(v.label)}: ${Math.round(sum(data, k)).toLocaleString('en')}`)
    .join(' · ');
}
