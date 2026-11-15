'use client';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { useTranslations } from 'next-intl';
import { RowHead } from '@/components/list/report-table';
import { useUiLocale } from '@/components/sessions/times';
import type { UtilizationDayDto } from '@/lib/api/utilization';
import { dayLabel, weekdayName } from '@/lib/schedule-time';
import { intlLocale } from '@/lib/time';

type Row = { key: string; label: string; booked: number; available: number; util: number | null };

const ratio = (booked: number, available: number) => (available > 0 ? booked / available : null);

/** By weekday: the dates of each weekday added up (booked ÷ available over them). */
export function byWeekday(days: UtilizationDayDto[], locale: 'ar' | 'en'): Row[] {
  const sums = new Map<number, { booked: number; available: number }>();
  for (const d of days) {
    const s = sums.get(d.weekday) ?? { booked: 0, available: 0 };
    s.booked += d.bookedHours;
    s.available += d.availableHours;
    sums.set(d.weekday, s);
  }
  return [...sums].map(([weekday, s]) => ({
    key: String(weekday),
    label: weekdayName(weekday, locale),
    booked: s.booked,
    available: s.available,
    util: ratio(s.booked, s.available),
  }));
}

/** Busiest first; days with nothing available («—») last. */
export function ranked(rows: Row[]): Row[] {
  return [...rows].sort((a, b) =>
    a.util === null ? 1 : b.util === null ? -1 : b.util - a.util || b.booked - a.booked,
  );
}

/**
 * «الأيام الأكثر والأقل انشغالًا» (R1 follow-up, docs/42 §5, D148): the weekdays ranked by booked
 * ÷ available hours over the range, then the five busiest and the five emptiest dates.
 */
export function BusyDays({ days }: { days: UtilizationDayDto[] }) {
  const t = useTranslations('utilization.busy');
  const locale = useUiLocale();
  const num = (n: number) =>
    new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 1 }).format(n);
  const pct = (v: number | null) =>
    v === null
      ? '—'
      : new Intl.NumberFormat(intlLocale(locale), {
          style: 'percent',
          maximumFractionDigits: 0,
        }).format(v);
  const weekdays = ranked(byWeekday(days, locale));
  const dates = ranked(
    days.map((d) => ({
      key: d.date,
      label: dayLabel(d.date, locale),
      booked: d.bookedHours,
      available: d.availableHours,
      util: d.utilization,
    })),
  ).filter((r) => r.util !== null);
  // With 10 dates or fewer the two lists split them (no date in both).
  const top = Math.min(5, Math.ceil(dates.length / 2));
  const busiest = dates.slice(0, top);
  const emptiest = dates.slice(top).reverse().slice(0, 5);
  // Classes booked on a day with no available hours (e.g. Friday): outside work hours.
  const outsideOnly = weekdays.some((r) => r.available === 0 && r.booked > 0);

  const table = (label: string, rows: Row[]) => (
    <div className="overflow-x-auto">
      <Table aria-label={label} className="tabular-nums">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col">{t('day')}</TableHead>
            <TableHead scope="col" className="text-end">
              {t('booked')}
            </TableHead>
            <TableHead scope="col" className="text-end">
              {t('available')}
            </TableHead>
            <TableHead scope="col" className="text-end">
              {t('utilization')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key}>
              <RowHead className="whitespace-nowrap">{r.label}</RowHead>
              <TableCell className="text-end">{num(r.booked)}</TableCell>
              <TableCell className="text-end">{num(r.available)}</TableCell>
              <TableCell className="text-end font-semibold">{pct(r.util)}</TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="py-4 text-center text-muted-foreground">
                {t('empty')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );

  return (
    <Card className="gap-3 shadow-none" aria-labelledby="busy-title">
      <CardHeader>
        <CardTitle className="text-base font-bold">
          <h2 id="busy-title">{t('title')}</h2>
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-3">
        <section aria-labelledby="busy-weekdays" className="flex flex-col gap-2">
          <h3 id="busy-weekdays" className="font-semibold">
            {t('byWeekday')}
          </h3>
          {table(t('byWeekday'), weekdays)}
          {outsideOnly && <p className="text-sm text-muted-foreground">{t('outsideOnly')}</p>}
        </section>
        <section aria-labelledby="busy-busiest" className="flex flex-col gap-2">
          <h3 id="busy-busiest" className="font-semibold">
            {t('busiest')}
          </h3>
          {table(t('busiest'), busiest)}
        </section>
        <section aria-labelledby="busy-emptiest" className="flex flex-col gap-2">
          <h3 id="busy-emptiest" className="font-semibold">
            {t('emptiest')}
          </h3>
          {table(t('emptiest'), emptiest)}
        </section>
      </CardContent>
    </Card>
  );
}
