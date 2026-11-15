'use client';

import {
  CAPACITY_AUDIENCES,
  CAPACITY_GENDERS,
  UTILIZATION_MAX_DAYS,
  type FreeCapacityDto,
  type TeacherUtilizationDto,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import { Progress } from '@qarabic/ui/components/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MinusIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { RangeBar } from '@/components/dashboard/range-bar';
import { BusyDays } from './busy-days';
import { HiringCheck } from './hiring-check';
import { RefreshFailed, refreshState } from '@/components/list/refresh-failed';
import { RowHead, STICKY_COL } from '@/components/list/report-table';
import { Combobox } from '@/components/forms/fields';
import { PageHeader } from '@/components/page-header';
import { KeyFacts } from '@/components/people/detail';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState, ForbiddenState } from '@/components/states';
import { academyToday } from '@/lib/accounting/forms';
import { isApiError } from '@/lib/api/client';
import { fetchLookups } from '@/lib/api/people';
import { fetchFreeCapacity, fetchUtilization, utilizationKeys } from '@/lib/api/utilization';
import { can } from '@/lib/auth/use-me';
import { ACADEMY_TZ } from '@/lib/billing/labels';
import { paramsOf, rangeFromParams, type RangePreset } from '@/lib/dashboard/range';
import { useListParams } from '@/lib/list-params';
import { addDays, dayLabel, isDateKey, weekdayName, weekStart } from '@/lib/schedule-time';
import { cityOf, intlLocale } from '@/lib/time';

/** Ranges the API takes (at most 92 days). */
const PRESETS: readonly RangePreset[] = [
  'this_week',
  'this_month',
  'last_month',
  'this_quarter',
  'custom',
];
const SORTS = ['utilization', 'available', 'booked', 'free', 'outside', 'delta', 'name'] as const;
type Sort = (typeof SORTS)[number];
const ALL = 'all';

const pct = (v: number | null, locale: 'ar' | 'en') =>
  v === null
    ? '—'
    : new Intl.NumberFormat(intlLocale(locale), {
        style: 'percent',
        maximumFractionDigits: 0,
      }).format(v);
const hours = (v: number, locale: 'ar' | 'en') =>
  new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 1 }).format(v);

/**
 * «إشغال المعلمين» (R1, docs/42 §5, D148): for the range, each teacher's available, booked, free
 * and outside-hours time, the utilization with its change against the period before, sortable
 * (most loaded first), each opening that teacher's week on the calendar; then the free capacity of
 * one week as a weekday × hour table (how many teachers are free for the whole hour). Range and
 * filters in the URL.
 */
export function UtilizationView() {
  const t = useTranslations('utilization');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const today = academyToday();
  const range = rangeFromParams(params.get, today, {
    presets: PRESETS,
    maxDays: UTILIZATION_MAX_DAYS,
  });
  const courseId = Number(params.get('course')) || undefined;
  const genderParam = params.get('gender') as (typeof CAPACITY_GENDERS)[number];
  const gender = CAPACITY_GENDERS.includes(genderParam) ? genderParam : undefined;
  const audienceParam = params.get('audience') as (typeof CAPACITY_AUDIENCES)[number];
  const audience = CAPACITY_AUDIENCES.includes(audienceParam) ? audienceParam : undefined;
  const sortParam = params.get('sort') as Sort;
  const sort: Sort = SORTS.includes(sortParam) ? sortParam : 'utilization';
  const asc = params.get('dir') === 'asc';
  const week = isDateKey(params.get('week')) ? params.get('week') : weekStart(today);
  const allowed = can(me, 'reports.view');

  const lookups = useQuery({
    queryKey: ['people', 'lookups'],
    queryFn: ({ signal }) => fetchLookups(signal),
    staleTime: 5 * 60_000,
    enabled: allowed,
  });
  const query = { from: range.from, to: range.to, courseId, gender };
  const report = useQuery({
    queryKey: utilizationKeys.report(query),
    queryFn: ({ signal }) => fetchUtilization(query, signal),
    enabled: allowed && !range.invalid,
    placeholderData: keepPreviousData,
  });
  const capQuery = { from: week, to: addDays(week, 6), courseId, gender, audience, tz: ACADEMY_TZ };
  const capacity = useQuery({
    queryKey: utilizationKeys.capacity(capQuery),
    queryFn: ({ signal }) => fetchFreeCapacity(capQuery, signal),
    enabled: allowed,
    placeholderData: keepPreviousData,
  });

  if (!allowed || isApiError(report.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }

  const d = report.data;
  const live = refreshState(report);
  const value = (r: TeacherUtilizationDto): number | string => {
    switch (sort) {
      case 'name':
        return r.teacher.name;
      case 'available':
        return r.availableHours;
      case 'booked':
        return r.bookedHours;
      case 'free':
        return r.freeHours;
      case 'outside':
        return r.outsideHours;
      case 'delta':
        return r.utilizationDelta ?? -Infinity;
      default:
        return r.utilization ?? -Infinity;
    }
  };
  const rows = [...(d?.teachers ?? [])].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    // Nothing to measure («—») stays last, whichever way the column is sorted.
    if (x === -Infinity || y === -Infinity) return x === y ? 0 : x === -Infinity ? 1 : -1;
    const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number);
    // Numbers: biggest first by default; names A→Z.
    return (sort === 'name' ? c : -c) * (asc ? -1 : 1);
  });
  const sortBy = (s: Sort) =>
    params.set({ sort: s === 'utilization' ? null : s, dir: s === sort && !asc ? 'asc' : null });
  const head = (s: Sort, label: string, end = false) => {
    const active = sort === s;
    return (
      <TableHead
        scope="col"
        aria-sort={active ? (asc ? 'ascending' : 'descending') : undefined}
        className={end ? 'text-end' : s === 'name' ? STICKY_COL : undefined}
      >
        <Button variant="ghost" size="sm" className="-mx-2 h-8" onClick={() => sortBy(s)}>
          {label}
          {active ? (
            asc ? (
              <ArrowUpIcon aria-hidden />
            ) : (
              <ArrowDownIcon aria-hidden />
            )
          ) : (
            <ArrowUpDownIcon aria-hidden className="opacity-50" />
          )}
        </Button>
      </TableHead>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('title')} description={t('description')} />
      <RangeBar
        range={range}
        previous={report.isPlaceholderData ? undefined : d?.range.previous}
        today={today}
        presets={PRESETS}
        maxDays={UTILIZATION_MAX_DAYS}
        showCompare={false}
        onChange={(next) => params.set(paramsOf({ ...next, compare: false }), { resetPage: false })}
      />
      <div role="group" aria-label={t('filters')} className="flex flex-wrap items-center gap-2">
        <Combobox
          id="util-course"
          ariaLabel={t('course')}
          className="w-full sm:w-56"
          value={courseId ? String(courseId) : null}
          onChange={(v) => params.set({ course: v })}
          options={(lookups.data?.courses ?? []).map((c) => ({
            value: String(c.id),
            label: locale === 'ar' ? c.nameAr : c.nameEn,
          }))}
          placeholder={t('allCourses')}
          searchPlaceholder={t('searchCourse')}
          clearable
        />
        <Select
          value={gender ?? ALL}
          onValueChange={(v) => params.set({ gender: v === ALL ? null : v })}
        >
          <SelectTrigger aria-label={t('gender')} className="h-10! w-full bg-card sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={ALL}>{t('allGenders')}</SelectItem>
            {CAPACITY_GENDERS.map((g) => (
              <SelectItem key={g} value={g}>
                {t(`genders.${g}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {live.failed ? (
        <ErrorState onRetry={() => void report.refetch()} />
      ) : (
        <>
          {d ? (
            <KeyFacts
              items={[
                { label: t('available'), value: hours(d.totals.availableHours, locale) },
                { label: t('booked'), value: hours(d.totals.bookedHours, locale) },
                { label: t('free'), value: hours(d.totals.freeHours, locale) },
                { label: t('utilization'), value: pct(d.totals.utilization, locale) },
              ]}
            />
          ) : range.invalid ? null : (
            <Skeleton className="h-20" />
          )}
          {/* Compare is always on here: say which period «التغيّر» compares with. */}
          {d && !report.isPlaceholderData && (
            <p className="text-sm text-muted-foreground">
              {t('comparedWith', {
                span: t('span', {
                  from: dayLabel(d.range.previous.from, locale, true),
                  to: dayLabel(d.range.previous.to, locale, true),
                }),
              })}
            </p>
          )}
          {live.stale && <RefreshFailed onRetry={() => void report.refetch()} />}
          <Card className="gap-0 overflow-x-auto py-0 shadow-none">
            <Table aria-label={t('tableLabel')} aria-busy={report.isFetching || undefined}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {head('name', t('teacher'))}
                  {head('utilization', t('utilization'))}
                  {head('delta', t('delta'))}
                  {head('available', t('availableShort'), true)}
                  {head('booked', t('bookedShort'), true)}
                  {head('free', t('freeShort'), true)}
                  {head('outside', t('outside'), true)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.teacher.id}>
                    <RowHead className="whitespace-nowrap">
                      <Link
                        href={`/schedule?view=week&teachers=${r.teacher.id}&date=${range.from}`}
                        className="text-primary hover:underline"
                      >
                        {r.teacher.name}
                      </Link>
                      <span className="block text-sm font-normal text-muted-foreground">
                        {t('classes', { count: r.classes })}
                      </span>
                    </RowHead>
                    <TableCell className="min-w-40">
                      <span className="flex items-center gap-2">
                        <Progress
                          value={Math.min(100, (r.utilization ?? 0) * 100)}
                          aria-label={t('utilizationOf', { name: r.teacher.name })}
                          className="h-2 w-24"
                        />
                        <span className="tabular-nums">{pct(r.utilization, locale)}</span>
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Delta value={r.utilizationDelta} />
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {hours(r.availableHours, locale)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {hours(r.bookedHours, locale)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {hours(r.freeHours, locale)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {r.outsideHours > 0 ? (
                        <span className="inline-flex items-center gap-1 font-semibold text-status-orange-emphasis">
                          <TriangleAlertIcon aria-hidden className="size-3.5" />
                          {hours(r.outsideHours, locale)}
                        </span>
                      ) : (
                        hours(r.outsideHours, locale)
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {range.invalid && !d && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                      {t('invalidRange')}
                    </TableCell>
                  </TableRow>
                )}
                {report.isPending &&
                  !range.invalid &&
                  Array.from({ length: 6 }, (_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={7}>
                        <Skeleton className="h-6" />
                      </TableCell>
                    </TableRow>
                  ))}
                {d && rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                      {t('empty')}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </>
      )}

      {d && d.days.length > 0 && <BusyDays days={d.days} />}
      <Card className="gap-3 shadow-none">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="text-base font-bold">
              <h2>{t('capacity.title')}</h2>
            </CardTitle>
            <CardDescription>
              {t('capacity.description', { city: cityOf(ACADEMY_TZ, locale) })}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={audience ?? ALL}
              onValueChange={(v) => params.set({ audience: v === ALL ? null : v })}
            >
              <SelectTrigger aria-label={t('audience')} className="h-10! w-40 bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value={ALL}>{t('allAudiences')}</SelectItem>
                {CAPACITY_AUDIENCES.map((a) => (
                  <SelectItem key={a} value={a}>
                    {t(`audiences.${a}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon-lg"
              aria-label={t('capacity.prevWeek')}
              onClick={() => params.set({ week: addDays(week, -7) })}
            >
              <ChevronRightIcon className="ltr:rotate-180" />
            </Button>
            <Button
              variant="outline"
              size="icon-lg"
              aria-label={t('capacity.nextWeek')}
              onClick={() => params.set({ week: addDays(week, 7) })}
            >
              <ChevronLeftIcon className="ltr:rotate-180" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {capacity.isError && !capacity.data ? (
            <ErrorState onRetry={() => void capacity.refetch()} />
          ) : capacity.data ? (
            <CapacityTable data={capacity.data} />
          ) : (
            <Skeleton className="h-64" />
          )}
        </CardContent>
      </Card>
      {capacity.data && <HiringCheck grid={capacity.data} />}
    </div>
  );
}

/** «▲ 4 نقاط» / «▼ 2 نقطة»: the change in utilization, in words too. */
function Delta({ value }: { value: number | null }) {
  const t = useTranslations('utilization');
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const points = Math.round(value * 100);
  const Icon = points > 0 ? ArrowUpIcon : points < 0 ? ArrowDownIcon : MinusIcon;
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <Icon aria-hidden className="size-3.5" />
      {t(points > 0 ? 'deltaUp' : points < 0 ? 'deltaDown' : 'deltaFlat', {
        count: Math.abs(points),
      })}
    </span>
  );
}

/**
 * The free capacity as a weekday × hour table: each cell is how many teachers are free for that
 * whole hour, shaded by share of the teachers (chart token, never colour alone: the number is in
 * the cell). The table is the accessible form; it scrolls sideways inside its card on phones.
 */
function CapacityTable({ data }: { data: FreeCapacityDto }) {
  const t = useTranslations('utilization.capacity');
  const locale = useUiLocale();
  const max = Math.max(1, data.teacherCount);
  // «5 م» / «5 PM»: the hour in the UI language.
  const hourLabel = (h: number) =>
    new Intl.DateTimeFormat(intlLocale(locale), { hour: 'numeric', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 0, 1, h)),
    );
  return (
    <div className="overflow-x-auto">
      <Table aria-label={t('tableLabel', { count: data.teacherCount })} className="tabular-nums">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col" className={STICKY_COL}>
              {t('day')}
            </TableHead>
            {Array.from({ length: 24 }, (_, h) => (
              <TableHead key={h} scope="col" className="px-1 text-center text-xs whitespace-nowrap">
                <bdi>{hourLabel(h)}</bdi>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.days.map((day) => (
            <TableRow key={day.date} className="hover:bg-transparent">
              <RowHead className="whitespace-nowrap">
                {weekdayName(day.weekday, locale)}{' '}
                <span className="text-xs font-normal text-muted-foreground">
                  {new Intl.DateTimeFormat(intlLocale(locale), {
                    day: 'numeric',
                    month: 'short',
                    timeZone: 'UTC',
                  }).format(new Date(`${day.date}T00:00:00Z`))}
                </span>
              </RowHead>
              {day.free.map((n, h) => (
                <TableCell
                  key={h}
                  className="h-8 min-w-8 px-1 text-center text-xs"
                  style={{
                    backgroundColor: `color-mix(in oklch, var(--chart-2) ${Math.round((n / max) * 70)}%, transparent)`,
                  }}
                >
                  <span aria-hidden>{n || <span className="text-muted-foreground">0</span>}</span>
                  <span className="sr-only">{t('free', { count: n })}</span>
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The teacher's own utilization this month (portal «جدولي»): their row only, from the API. */
export function MyUtilizationCard() {
  const t = useTranslations('utilization');
  const locale = useUiLocale();
  const today = academyToday();
  const query = { from: `${today.slice(0, 7)}-01`, to: today };
  const report = useQuery({
    queryKey: utilizationKeys.report(query),
    queryFn: ({ signal }) => fetchUtilization(query, signal),
  });
  const r = report.data?.teachers[0];
  if (report.isError || (report.isSuccess && !r)) return null;
  return (
    <Card className="gap-3 shadow-none" aria-labelledby="my-utilization-title">
      <CardHeader>
        <CardTitle className="text-base font-bold">
          <h2 id="my-utilization-title">{t('mine.title')}</h2>
        </CardTitle>
        <CardDescription>{t('mine.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {r ? (
          <KeyFacts
            items={[
              { label: t('available'), value: hours(r.availableHours, locale) },
              { label: t('booked'), value: hours(r.bookedHours, locale) },
              { label: t('free'), value: hours(r.freeHours, locale) },
              { label: t('utilization'), value: pct(r.utilization, locale) },
            ]}
          />
        ) : (
          <Skeleton className="h-20" />
        )}
      </CardContent>
    </Card>
  );
}
