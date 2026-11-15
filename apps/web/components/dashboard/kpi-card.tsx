'use client';

import { Card } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { cn } from '@qarabic/ui/lib/utils';
import { MinusIcon, TrendingDownIcon, TrendingUpIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useUiLocale } from '@/components/sessions/times';
import type { UsdMoney } from '@qarabic/shared';
import { Money } from '@/components/billing/billing-bits';
import { changePct, changePoints } from '@/lib/dashboard/range';
import { intlLocale } from '@/lib/time';

/**
 * A USD amount (D144) as the dashboard shows it: «$121,468» in both languages, one left-to-right
 * run so the sign stays with the number in an Arabic sentence.
 */
export function Usd({ amount, compact = false }: { amount: string | number; compact?: boolean }) {
  const locale = useUiLocale();
  const n = typeof amount === 'string' ? Number(amount) : amount;
  const text = new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: compact ? 1 : 0,
    notation: compact ? 'compact' : 'standard',
  }).format(Math.abs(n));
  return (
    <bdi dir="ltr" className="tabular-nums">
      {n < 0 ? '−' : ''}${text}
    </bdi>
  );
}

/**
 * A USD total (D144). When a part has no exchange rate the API sends no USD figure: the card shows
 * «—» and the amounts in their own currencies instead of a wrong total (never a silent 0).
 */
export function UsdTotal({ money }: { money: UsdMoney }) {
  if (money.usd !== null && !money.missingRate) return <Usd amount={money.usd} />;
  return <span aria-hidden>—</span>;
}

/** The original-currency parts of a total that could not be converted («€1,200 · £340»). */
export function CurrencyParts({ money }: { money: UsdMoney }) {
  if (money.usd !== null && !money.missingRate) return null;
  return (
    <span className="flex flex-wrap gap-x-2">
      {money.byCurrency.map((p) => (
        <Money key={p.currency} amount={p.amount} currency={p.currency} />
      ))}
    </span>
  );
}

/** A share 0–100 as «92%» (Intl, Latin digits like every other number in the app). */
export function Pct({ value }: { value: number }) {
  const locale = useUiLocale();
  return (
    <bdi className="tabular-nums">
      {new Intl.NumberFormat(intlLocale(locale), {
        style: 'percent',
        maximumFractionDigits: 1,
      }).format(value / 100)}
    </bdi>
  );
}

/**
 * The change against the previous period: an arrow and a signed figure («+12%», «−5%»), said in
 * words for screen readers too. A ratio (attendance) changes in percentage points («+3.2 نقطة»),
 * not in % of itself. `goodWhenDown` turns the tone for numbers that should fall (outstanding).
 */
export function Change({
  value,
  previous,
  goodWhenDown = false,
  points = false,
}: {
  value: number;
  previous: number | null | undefined;
  goodWhenDown?: boolean;
  /** `value`/`previous` are ratios 0–1: show the difference in percentage points. */
  points?: boolean;
}) {
  const t = useTranslations('dashboard.kpi');
  const locale = useUiLocale();
  const change = points ? changePoints(value, previous) : changePct(value, previous);
  if (change === null) return null;
  const signed = new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
    ...(points ? {} : { style: 'percent' as const }),
  }).format(points ? change : change / 100);
  const flat = change === 0;
  const up = change > 0;
  const good = flat ? null : up !== goodWhenDown;
  const Icon = flat ? MinusIcon : up ? TrendingUpIcon : TrendingDownIcon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-sm font-medium',
        good === true && 'text-status-green-emphasis',
        good === false && 'text-status-red-emphasis',
        good === null && 'text-muted-foreground',
      )}
    >
      <Icon aria-hidden className="size-4" />
      <bdi className="tabular-nums">{points ? t('points', { value: signed }) : signed}</bdi>
      <span className="sr-only">{t(flat ? 'flat' : up ? 'up' : 'down')}</span>
    </span>
  );
}

/** A count in the UI's digits (Latin, grouped). */
export function Count({ value }: { value: number }) {
  const locale = useUiLocale();
  return (
    <bdi className="tabular-nums">{new Intl.NumberFormat(intlLocale(locale)).format(value)}</bdi>
  );
}

/**
 * One KPI (docs/40 §3 row 1): the number, its change against the previous period, an optional
 * second line, and the whole card opens the list behind it (docs/40 §2.5).
 */
export function KpiCard({
  label,
  href,
  value,
  change,
  detail,
  missingRate,
  loading,
}: {
  label: string;
  href: string;
  value: ReactNode;
  change?: ReactNode;
  detail?: ReactNode;
  missingRate?: boolean;
  loading?: boolean;
}) {
  const t = useTranslations('dashboard.kpi');
  return (
    <Card size="sm" className="gap-0 p-0 shadow-none transition-colors hover:bg-accent">
      <Link
        href={href}
        className="flex h-full flex-col gap-1 rounded-xl px-4 py-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="text-sm text-muted-foreground">{label}</span>
        {loading ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-2xl font-bold">{value}</span>
            {change}
          </span>
        )}
        {!loading && detail && <span className="text-sm text-muted-foreground">{detail}</span>}
        {!loading && missingRate && (
          <span className="flex items-center gap-1 text-sm text-status-orange-emphasis">
            <TriangleAlertIcon aria-hidden className="size-4" />
            {t('missingRate')}
          </span>
        )}
      </Link>
    </Card>
  );
}
