'use client';

import { Button } from '@qarabic/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@qarabic/ui/components/chart';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { ChartNoAxesColumnIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Label,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts';
import { useUiLocale } from '@/components/sessions/times';
import type { Bucket } from '@/lib/dashboard/range';
import { intlLocale } from '@/lib/time';

/** A bucket's values; `null` is a gap (an amount without an exchange rate), never a 0. */
type Point = Record<string, string | number | boolean | null> & { bucket: string };

/** «18 نوف» / «أسبوع 14 نوف» / «نوف 26»: a bucket's start in the UI language. */
export function bucketLabel(key: string, bucket: Bucket, locale: 'ar' | 'en', week: string) {
  const d = new Date(`${key}T00:00:00Z`);
  if (bucket === 'month') {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      // «أكتوبر 2026»: a month and its year (never read as a date).
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(d);
  }
  const day = new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(d);
  return bucket === 'week' ? `${week} ${day}` : day;
}

/**
 * A chart widget (docs/40 §3 row 2): title, what it shows, then the chart, or its own loading,
 * error or empty state. Points without an exchange rate are listed above the chart (D144: a
 * missing rate is said, never shown as 0).
 */
export function ChartCard({
  id,
  title,
  description,
  loading,
  error,
  onRetry,
  empty,
  missingRate,
  children,
}: {
  id: string;
  title: string;
  description: string;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  empty: boolean;
  missingRate?: string[];
  children: ReactNode;
}) {
  const t = useTranslations('dashboard.chart');
  const locale = useUiLocale();
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
        {missingRate && missingRate.length > 0 && (
          <p className="flex items-start gap-1.5 text-sm text-status-orange-emphasis">
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            {t('missingRate', {
              buckets: new Intl.ListFormat(intlLocale(locale), { type: 'conjunction' }).format(
                missingRate,
              ),
            })}
          </p>
        )}
        {loading ? (
          <Skeleton className="h-56 w-full" aria-busy="true" />
        ) : error ? (
          <div className="flex h-56 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <p role="alert">{t('error')}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t('retry')}
            </Button>
          </div>
        ) : empty ? (
          <div className="flex h-56 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <ChartNoAxesColumnIcon aria-hidden className="size-6" />
            {t('empty')}
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

/**
 * A series chart from the shadcn chart blocks (area, bar, stacked bar or line). The canvas is LTR
 * with the data reversed in Arabic, so time reads from the inline start; the value axis sits on
 * the inline start too. The chart is one image with a spoken summary (screen readers get the
 * totals, not every point).
 */
export function SeriesChart({
  kind,
  data,
  config,
  bucket,
  summary,
  money = false,
}: {
  kind: 'area' | 'bar' | 'stacked' | 'line';
  data: Point[];
  config: ChartConfig;
  bucket: Bucket;
  summary: string;
  money?: boolean;
}) {
  const locale = useUiLocale();
  const tw = useTranslations('dashboard.chart');
  const keys = Object.keys(config);
  const rows = data.map((p) => ({
    ...p,
    label: bucketLabel(p.bucket, bucket, locale, tw('week')),
    ...Object.fromEntries(keys.map((k) => [k, p[k] === null ? null : Number(p[k])])),
  }));
  const ordered = locale === 'ar' ? [...rows].reverse() : rows;
  // Compact ticks; money with a «$» in front (the card says it is USD).
  const tick = (v: number) =>
    `${money ? '$' : ''}${new Intl.NumberFormat(intlLocale(locale), {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(v)}`;
  const valueText = (v: number) =>
    `${money ? '$' : ''}${new Intl.NumberFormat(intlLocale(locale), {
      maximumFractionDigits: money ? 0 : 1,
    }).format(v)}`;
  const summaryId = useId();
  const axes = (
    <>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
      <YAxis
        width={money ? 64 : 40}
        tickLine={false}
        axisLine={false}
        tickFormatter={tick}
        orientation={locale === 'ar' ? 'right' : 'left'}
      />
      <ChartTooltip
        content={
          <ChartTooltipContent
            formatter={(value, name, item) => (
              <div className="flex w-full items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-[2px]"
                    style={{ background: item.color }}
                  />
                  {config[String(name)]?.label ?? name}
                </span>
                <span className="font-medium text-foreground tabular-nums">
                  {/* A gap (no exchange rate) is «—», never 0. */}
                  {value === null || value === undefined ? '—' : valueText(Number(value))}
                </span>
              </div>
            )}
          />
        }
      />
      <ChartLegend
        content={(props) => (
          // The canvas is LTR; the legend reads in the UI's direction.
          <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>
            <ChartLegendContent payload={props.payload} verticalAlign={props.verticalAlign} />
          </div>
        )}
      />
    </>
  );
  return (
    // The chart keeps recharts' keyboard layer; its spoken summary describes it (no role="img"
    // around an interactive element).
    <div aria-describedby={summaryId}>
      <p id={summaryId} className="sr-only">
        {summary}
      </p>
      <ChartContainer config={config} className="aspect-auto h-56 w-full" dir="ltr">
        {kind === 'area' ? (
          <AreaChart accessibilityLayer data={ordered} margin={{ top: 8, left: 0, right: 0 }}>
            {axes}
            {keys.map((k) => (
              <Area
                key={k}
                dataKey={k}
                isAnimationActive={false}
                type="monotone"
                fill={`var(--color-${k})`}
                fillOpacity={0.2}
                stroke={`var(--color-${k})`}
              />
            ))}
          </AreaChart>
        ) : kind === 'line' ? (
          <LineChart accessibilityLayer data={ordered} margin={{ top: 8, left: 0, right: 0 }}>
            {axes}
            {keys.map((k) => (
              <Line
                key={k}
                dataKey={k}
                isAnimationActive={false}
                type="monotone"
                stroke={`var(--color-${k})`}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        ) : (
          <BarChart accessibilityLayer data={ordered} margin={{ top: 8, left: 0, right: 0 }}>
            {axes}
            {keys.map((k, i) => (
              <Bar
                key={k}
                dataKey={k}
                isAnimationActive={false}
                fill={`var(--color-${k})`}
                stackId={kind === 'stacked' ? 'a' : undefined}
                stroke={kind === 'stacked' ? 'var(--card)' : undefined}
                strokeWidth={kind === 'stacked' ? 2 : undefined}
                radius={kind === 'stacked' ? (i === keys.length - 1 ? [4, 4, 0, 0] : 0) : 4}
              />
            ))}
          </BarChart>
        )}
      </ChartContainer>
    </div>
  );
}

/** One category's value: a reason, a source or an ageing band. */
export type CategoryPoint = { key: string; value: number | null };

/**
 * Categories as horizontal bars (shadcn «bar chart – horizontal»), one colour: lost reasons and the
 * overdue ageing. The labels sit at the inline start and the bars grow toward the inline end, in
 * both languages.
 */
export function CategoryBars({
  data,
  config,
  summary,
  money = false,
  color = 'var(--chart-1)',
}: {
  data: CategoryPoint[];
  config: ChartConfig;
  summary: string;
  money?: boolean;
  color?: string;
}) {
  const locale = useUiLocale();
  const rtl = locale === 'ar';
  const summaryId = useId();
  const valueText = (v: number) =>
    `${money ? '$' : ''}${new Intl.NumberFormat(intlLocale(locale), {
      maximumFractionDigits: 0,
    }).format(v)}`;
  const rows = data.map((p) => ({
    ...p,
    label: String(config[p.key]?.label ?? p.key),
  }));
  return (
    <div aria-describedby={summaryId}>
      <p id={summaryId} className="sr-only">
        {summary}
      </p>
      <ChartContainer
        config={{ value: { label: '', color } }}
        className="aspect-auto w-full"
        style={{ height: Math.max(rows.length * 40 + 16, 120) }}
        dir="ltr"
      >
        <BarChart
          accessibilityLayer
          data={rows}
          layout="vertical"
          // Room for the value at the bar's end.
          margin={{ top: 0, left: rtl ? 56 : 0, right: rtl ? 0 : 56 }}
        >
          <XAxis type="number" dataKey="value" hide reversed={rtl} />
          <YAxis
            type="category"
            dataKey="label"
            tickLine={false}
            axisLine={false}
            width={112}
            orientation={rtl ? 'right' : 'left'}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideLabel
                formatter={(value, _name, item) => (
                  <div className="flex w-full items-center justify-between gap-3">
                    <span className="text-muted-foreground">{item.payload.label}</span>
                    <span className="font-medium text-foreground tabular-nums">
                      {value === null || value === undefined ? '—' : valueText(Number(value))}
                    </span>
                  </div>
                )}
              />
            }
          />
          <Bar dataKey="value" isAnimationActive={false} fill="var(--color-value)" radius={4}>
            <LabelList
              dataKey="value"
              position="right"
              offset={8}
              className="fill-foreground tabular-nums"
              fontSize={12}
              formatter={(v: unknown) => (typeof v === 'number' ? valueText(v) : '—')}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  );
}

/**
 * Shares of a whole as a donut (shadcn «pie chart – donut with text»): the total in the middle,
 * the legend under it in the UI's direction. Leads by source.
 */
export function Donut({
  data,
  config,
  summary,
  totalLabel,
}: {
  data: CategoryPoint[];
  config: ChartConfig;
  summary: string;
  totalLabel: string;
}) {
  const locale = useUiLocale();
  const summaryId = useId();
  const total = data.reduce((a, p) => a + (p.value ?? 0), 0);
  const fmt = new Intl.NumberFormat(intlLocale(locale));
  return (
    <div aria-describedby={summaryId}>
      <p id={summaryId} className="sr-only">
        {summary}
      </p>
      <ChartContainer config={config} className="mx-auto aspect-square h-56" dir="ltr">
        <PieChart accessibilityLayer>
          <ChartTooltip cursor={false} content={<ChartTooltipContent nameKey="key" hideLabel />} />
          <Pie
            data={data}
            dataKey="value"
            nameKey="key"
            innerRadius={56}
            strokeWidth={2}
            stroke="var(--card)"
            isAnimationActive={false}
          >
            {data.map((p) => (
              <Cell key={p.key} fill={`var(--color-${p.key})`} />
            ))}
            <Label
              content={({ viewBox }) =>
                viewBox && 'cx' in viewBox && 'cy' in viewBox ? (
                  <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                    <tspan
                      x={viewBox.cx}
                      y={viewBox.cy}
                      className="fill-foreground text-2xl font-bold tabular-nums"
                    >
                      {fmt.format(total)}
                    </tspan>
                    <tspan
                      x={viewBox.cx}
                      y={(viewBox.cy ?? 0) + 22}
                      className="fill-muted-foreground text-xs"
                    >
                      {totalLabel}
                    </tspan>
                  </text>
                ) : null
              }
            />
          </Pie>
        </PieChart>
      </ChartContainer>
      <ul
        dir={locale === 'ar' ? 'rtl' : 'ltr'}
        className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs"
      >
        {data.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ background: config[p.key]?.color }}
            />
            <span className="text-muted-foreground">{config[p.key]?.label}</span>
            <span className="font-medium tabular-nums">{fmt.format(p.value ?? 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
