'use client';

import type { FreeCapacityDto } from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@qarabic/ui/components/card';
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { CircleCheckIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { useUiLocale } from '@/components/sessions/times';
import { STAFF_WEEK, weekdayName } from '@/lib/schedule-time';
import { cityOf, intlLocale } from '@/lib/time';
import { useDirection } from '@/lib/use-direction';
import { hiringCheck, hourRanges } from '@/lib/utilization/hiring';

const MINUTES = [30, 45, 60, 90, 120, 180] as const;
/** Arabic-Indic digits typed as a count («١٢» → 12). */
const digits = (v: string) => v.trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

/**
 * «هل نحتاج معلمًا جديدًا؟» (R1 hiring check, docs/42 §5, D148): N new students of M minutes a
 * week, on these weekdays within this hour window — can the teachers free this week take them
 * (the course, gender and age-group filters above apply), and which hours have nobody free.
 */
export function HiringCheck({ grid }: { grid: FreeCapacityDto }) {
  const t = useTranslations('utilization.hiring');
  const locale = useUiLocale();
  const dir = useDirection();
  const ids = { students: useId(), minutes: useId(), from: useId(), to: useId(), days: useId() };
  const [weekdays, setWeekdays] = useState<string[]>(['6', '7', '1', '2', '3']);
  const [fromHour, setFromHour] = useState(15);
  const [toHour, setToHour] = useState(22);
  const [students, setStudents] = useState('10');
  const [minutes, setMinutes] = useState(60);
  const count = Number(digits(students));
  const validCount = Number.isInteger(count) && count > 0 && count <= 1000;
  const valid = validCount && weekdays.length > 0 && fromHour < toHour;
  const result = valid
    ? hiringCheck(grid, {
        weekdays: weekdays.map(Number),
        fromHour,
        toHour,
        students: count,
        minutesPerWeek: minutes,
      })
    : null;
  const hour = (h: number) =>
    new Intl.DateTimeFormat(intlLocale(locale), { hour: 'numeric', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 0, 1, h % 24)),
    );
  const num = (n: number) =>
    new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 1 }).format(n);

  return (
    <Card className="gap-3 shadow-none" aria-labelledby="hiring-title">
      <CardHeader>
        <CardTitle className="text-base font-bold">
          <h2 id="hiring-title">{t('title')}</h2>
        </CardTitle>
        <CardDescription>
          {t('description', { city: cityOf(grid.range.timezone, locale) })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FieldGroup className="grid gap-4 md:grid-cols-4">
          <Field data-invalid={!validCount}>
            <FieldLabel htmlFor={ids.students}>{t('students')}</FieldLabel>
            <Input
              id={ids.students}
              inputMode="numeric"
              dir="ltr"
              className="h-10 text-start"
              value={students}
              aria-invalid={!validCount}
              onChange={(e) => setStudents(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={ids.minutes}>{t('minutes')}</FieldLabel>
            <Select value={String(minutes)} onValueChange={(v) => setMinutes(Number(v))}>
              <SelectTrigger id={ids.minutes} className="h-10! w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {MINUTES.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {t('minutesOption', { count: m })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field data-invalid={fromHour >= toHour}>
            <FieldLabel htmlFor={ids.from}>{t('from')}</FieldLabel>
            <Select value={String(fromHour)} onValueChange={(v) => setFromHour(Number(v))}>
              <SelectTrigger id={ids.from} className="h-10! w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {Array.from({ length: 24 }, (_, h) => (
                  <SelectItem key={h} value={String(h)}>
                    {hour(h)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field data-invalid={fromHour >= toHour}>
            <FieldLabel htmlFor={ids.to}>{t('to')}</FieldLabel>
            <Select value={String(toHour)} onValueChange={(v) => setToHour(Number(v))}>
              <SelectTrigger id={ids.to} className="h-10! w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    {h === 24 ? t('midnight') : hour(h)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        <FieldSet>
          <FieldLegend id={ids.days} variant="label">
            {t('days')}
          </FieldLegend>
          <ToggleGroup
            type="multiple"
            variant="outline"
            dir={dir}
            aria-labelledby={ids.days}
            value={weekdays}
            onValueChange={setWeekdays}
            className="flex-wrap"
          >
            {STAFF_WEEK.map((d) => (
              <ToggleGroupItem key={d} value={String(d)} className="h-10 px-3">
                {weekdayName(d, locale)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </FieldSet>
        {!valid ? (
          <p role="alert" className="text-sm text-destructive">
            {t('invalid')}
          </p>
        ) : result ? (
          <Alert variant={result.enough ? 'default' : 'warning'} role="status">
            {result.enough ? <CircleCheckIcon /> : <TriangleAlertIcon />}
            <AlertTitle>
              {result.enough
                ? t('enough', { load: num((result.load ?? 0) * 100) })
                : t('short', { hours: num(result.shortHours) })}
            </AlertTitle>
            <AlertDescription className="flex flex-col gap-1">
              <span>
                {t('numbers', { needed: num(result.neededHours), free: num(result.freeHours) })}
              </span>
              {result.gaps.length > 0 && (
                <span className="flex flex-col gap-0.5">
                  <span className="font-semibold">{t('gaps')}</span>
                  {result.gaps.map((g) => (
                    <span key={g.date}>
                      {weekdayName(g.weekday, locale)}:{' '}
                      {hourRanges(g.hours)
                        .map(([a, b]) => `${hour(a)} – ${b === 24 ? t('midnight') : hour(b)}`)
                        .join('، ')}
                    </span>
                  ))}
                </span>
              )}
              <span className="text-muted-foreground">{t('caveat')}</span>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
