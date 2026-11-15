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
import type { ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
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
      month: 'short',
      year: '2-digit',
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
            {t('missingRate', { buckets: missingRate.join('، ') })}
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
      <ChartTooltip content={<ChartTooltipContent />} />
      <ChartLegend content={<ChartLegendContent />} />
    </>
  );
  return (
    <div role="img" aria-label={summary}>
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
                radius={kind === 'stacked' ? (i === keys.length - 1 ? [4, 4, 0, 0] : 0) : 4}
              />
            ))}
          </BarChart>
        )}
      </ChartContainer>
    </div>
  );
}
