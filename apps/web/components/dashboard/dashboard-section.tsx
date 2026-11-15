'use client';

import type { DashboardMetricsDto, DashboardWidget, UsdMoney } from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import type { ChartConfig } from '@qarabic/ui/components/chart';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { RefreshFailed, refreshState } from '@/components/list/refresh-failed';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { academyToday } from '@/lib/accounting/forms';
import { dashboardKeys, fetchDashboardMetrics } from '@/lib/api/dashboard';
import { paramsOf, rangeFromParams } from '@/lib/dashboard/range';
import { dashboardLayout, KPI_HREF, usdOf, type MainChart } from '@/lib/dashboard/widgets';
import { useListParams } from '@/lib/list-params';
import { intlLocale } from '@/lib/time';
import { bucketLabel, ChartCard, SeriesChart } from './charts';
import { Change, CurrencyParts, KpiCard, Pct, Usd, UsdTotal } from './kpi-card';
import { RangeBar } from './range-bar';

type CardBase = { key: string; href: string; label: string; loading: boolean };

/**
 * The management dashboard on the staff home (docs/40, D144): one time control drives every
 * widget; KPI cards with the change against the previous period, each opening the list behind it;
 * then the four main charts. Only the widgets this person's permissions allow are shown
 * (`visibleWidgets()` from `@qarabic/shared`, the API's own rule). All money in USD; an amount
 * without an exchange rate is said, with its original currencies, never shown as 0.
 */
export function DashboardSection() {
  const t = useTranslations('dashboard');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const today = academyToday();
  const range = rangeFromParams(params.get, today);
  const { kpis, charts } = dashboardLayout(me.permissions);
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
  const failed = live.failed;
  const loading = !d && !failed;
  const retry = () => void metrics.refetch();
  const label = (b: string) => bucketLabel(b, range.bucket, locale, t('chart.week'));

  const moneyCard = (
    base: CardBase,
    value: UsdMoney | undefined,
    previous: UsdMoney | null,
    opts: { goodWhenDown?: boolean; extra?: ReactNode } = {},
  ) => {
    const now = usdOf(value);
    const { key, ...rest } = base;
    return (
      <KpiCard
        key={key}
        {...rest}
        value={value ? <UsdTotal money={value} /> : '—'}
        change={
          now !== null && (
            <Change value={now} previous={usdOf(previous)} goodWhenDown={opts.goodWhenDown} />
          )
        }
        detail={
          value && (value.missingRate || opts.extra) ? (
            <span className="flex flex-col gap-0.5">
              {value.missingRate && <CurrencyParts money={value} />}
              {opts.extra && <span>{opts.extra}</span>}
            </span>
          ) : undefined
        }
        missingRate={value?.missingRate}
      />
    );
  };

  const kpiCard = (widget: DashboardWidget) => {
    const base: CardBase = {
      key: widget,
      href: KPI_HREF[widget]!,
      label: t(`kpi.${widget}`),
      loading,
    };
    const { key, ...rest } = base;
    if (failed) return <KpiCard key={key} {...rest} value="—" detail={t('kpi.error')} />;
    const k = d?.kpis;
    switch (widget) {
      case 'active_students':
      case 'new_students':
      case 'teachers_on_duty': {
        const v = k?.[widget];
        return (
          <KpiCard
            key={key}
            {...rest}
            value={<bdi className="tabular-nums">{v?.value ?? '—'}</bdi>}
            change={v && <Change value={v.value} previous={v.previous} />}
          />
        );
      }
      case 'attendance_rate': {
        const v = k?.attendance_rate;
        return (
          <KpiCard
            key={key}
            {...rest}
            value={v && v.value !== null ? <Pct value={v.value * 100} /> : '—'}
            change={v && v.value !== null && <Change value={v.value} previous={v.previous} />}
          />
        );
      }
      case 'trials': {
        const v = k?.trials;
        return (
          <KpiCard
            key={key}
            {...rest}
            value={<bdi className="tabular-nums">{v?.value.booked ?? '—'}</bdi>}
            change={v && <Change value={v.value.booked} previous={v.previous?.booked} />}
            detail={
              v &&
              t.rich('kpi.trialsDetail', {
                attended: v.value.attended,
                converted: v.value.converted,
                pct: () => <Pct value={(v.value.conversionRate ?? 0) * 100} />,
              })
            }
          />
        );
      }
      case 'collected':
      case 'gross_profit':
      case 'net_profit':
        return moneyCard(base, k?.[widget]?.value, k?.[widget]?.previous ?? null);
      case 'outstanding': {
        const v = k?.outstanding;
        const overdue = v?.value.overdue;
        return moneyCard(base, v?.value.total, v?.previous?.total ?? null, {
          goodWhenDown: true,
          extra:
            overdue &&
            t.rich('kpi.overdue', {
              amount: () => (usdOf(overdue) !== null ? <Usd amount={overdue.usd!} /> : '—'),
            }),
        });
      }
      default:
        return null;
    }
  };

  const s = d?.series;
  const chart = (widget: MainChart) => {
    const common = {
      id: `dash-${widget}`,
      title: t(`chart.${widget}.title`),
      description: t(`chart.${widget}.description`),
      loading,
      error: failed,
      onRetry: retry,
    };
    switch (widget) {
      case 'revenue_expenses': {
        const pts = s?.revenue_expenses ?? [];
        const data = pts.map((p) => ({
          bucket: p.bucket,
          revenue: usdOf(p.revenue),
          expenses: sumUsd(p.teacherPay, p.otherExpenses),
          profit: usdOf(p.netProfit),
        }));
        const config = {
          revenue: { label: t('chart.revenue_expenses.revenue'), color: 'var(--primary)' },
          expenses: { label: t('chart.revenue_expenses.expenses'), color: 'var(--chart-3)' },
          profit: { label: t('chart.revenue_expenses.profit'), color: 'var(--chart-2)' },
        } satisfies ChartConfig;
        const missing = pts
          .filter((p) => [p.revenue, p.teacherPay, p.otherExpenses].some((m) => m.missingRate))
          .map((p) => label(p.bucket));
        return (
          <ChartCard key={widget} {...common} empty={!pts.length} missingRate={missing}>
            <SeriesChart
              kind="area"
              data={data}
              config={config}
              bucket={range.bucket}
              money
              summary={summaryOf(config, data, locale)}
            />
          </ChartCard>
        );
      }
      case 'collections': {
        const pts = s?.collections?.points ?? [];
        const data = pts.map((p) => ({
          bucket: p.bucket,
          collected: usdOf(p.collected),
          invoiced: usdOf(p.invoiced),
        }));
        const config = {
          collected: { label: t('chart.collections.collected'), color: 'var(--primary)' },
          invoiced: { label: t('chart.collections.invoiced'), color: 'var(--chart-3)' },
        } satisfies ChartConfig;
        const missing = pts
          .filter((p) => p.collected.missingRate || p.invoiced.missingRate)
          .map((p) => label(p.bucket));
        return (
          <ChartCard key={widget} {...common} empty={!pts.length} missingRate={missing}>
            <SeriesChart
              kind="bar"
              data={data}
              config={config}
              bucket={range.bucket}
              money
              summary={summaryOf(config, data, locale)}
            />
          </ChartCard>
        );
      }
      case 'students_trials': {
        const pts = s?.students_trials ?? [];
        const data = pts.map((p) => ({
          bucket: p.bucket,
          newStudents: p.newStudents,
          trials: p.trialsBooked,
          converted: p.trialsConverted,
        }));
        const config = {
          newStudents: { label: t('chart.students_trials.newStudents'), color: 'var(--primary)' },
          trials: { label: t('chart.students_trials.trials'), color: 'var(--chart-3)' },
          converted: { label: t('chart.students_trials.converted'), color: 'var(--chart-2)' },
        } satisfies ChartConfig;
        return (
          <ChartCard key={widget} {...common} empty={!pts.length}>
            <SeriesChart
              kind="line"
              data={data}
              config={config}
              bucket={range.bucket}
              summary={summaryOf(config, data, locale)}
            />
          </ChartCard>
        );
      }
      case 'class_outcomes': {
        const data = s?.class_outcomes ?? [];
        const config = {
          taken: { label: t('chart.class_outcomes.taken'), color: 'var(--primary)' },
          absent: { label: t('chart.class_outcomes.absent'), color: 'var(--chart-2)' },
          leave: { label: t('chart.class_outcomes.leave'), color: 'var(--chart-3)' },
          declined: { label: t('chart.class_outcomes.declined'), color: 'var(--chart-4)' },
          cancelled: { label: t('chart.class_outcomes.cancelled'), color: 'var(--chart-5)' },
        } satisfies ChartConfig;
        return (
          <ChartCard key={widget} {...common} empty={!data.length}>
            <SeriesChart
              kind="stacked"
              data={data}
              config={config}
              bucket={range.bucket}
              summary={summaryOf(config, data, locale)}
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
      {d && d.missingRates.length > 0 && <MissingRates rates={d.missingRates} />}
      {kpis.length > 0 && (
        <div
          className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4"
          aria-busy={loading || undefined}
        >
          {kpis.map(kpiCard)}
        </div>
      )}
      {charts.length > 0 && <div className="grid gap-4 lg:grid-cols-2">{charts.map(chart)}</div>}
    </section>
  );
}

/** The months and currencies with no rate to USD (D144): said once, on top. */
function MissingRates({ rates }: { rates: DashboardMetricsDto['missingRates'] }) {
  const t = useTranslations('dashboard');
  const locale = useUiLocale();
  const month = (m: string) =>
    new Intl.DateTimeFormat(intlLocale(locale), {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${m}-01T00:00:00Z`));
  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>{t('missingRates.title')}</AlertTitle>
      <AlertDescription>
        {t('missingRates.body', {
          list: rates.map((r) => `${r.currency} · ${month(r.month)}`).join('، '),
        })}
      </AlertDescription>
    </Alert>
  );
}

/** Teacher pay + other expenses in USD, or null when either lacks a rate. */
function sumUsd(a: UsdMoney, b: UsdMoney): number | null {
  const x = usdOf(a);
  const y = usdOf(b);
  return x === null || y === null ? null : x + y;
}

/** «الإيرادات: 12,400 · المصروفات: 7,100…»: what a chart shows, said once. */
function summaryOf(
  config: ChartConfig,
  data: Record<string, unknown>[],
  locale: 'ar' | 'en',
): string {
  const fmt = new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 0 });
  return Object.entries(config)
    .map(([k, v]) => {
      const total = data.reduce<number>(
        (a, p) => a + (typeof p[k] === 'number' ? (p[k] as number) : 0),
        0,
      );
      return `${String(v.label)}: ${fmt.format(total)}`;
    })
    .join(' · ');
}
