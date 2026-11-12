'use client';

import { Button } from '@qarabic/ui/components/button';
import { Calendar } from '@qarabic/ui/components/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@qarabic/ui/components/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { cn } from '@qarabic/ui/lib/utils';
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { arSA, enGB } from 'react-day-picker/locale';
import { QUARTER_TIMES, wallTime } from '@/lib/schedule-time';
import { formatDate } from '@/lib/time';

const toKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromKey = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

/**
 * The shadcn Date Picker (Popover + Calendar): a `YYYY-MM-DD` value, the date written with the
 * month name (D32), the calendar in the UI language and direction, week from Saturday.
 */
export function DatePicker({
  id,
  value,
  onChange,
  label,
  min,
  max,
  invalid,
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Accessible name when no visible label points at the button. */
  label?: string;
  min?: string;
  max?: string;
  invalid?: boolean;
  className?: string;
}) {
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const [open, setOpen] = useState(false);
  const disabled = [
    ...(min ? [{ before: fromKey(min) }] : []),
    ...(max ? [{ after: fromKey(max) }] : []),
  ];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          aria-label={label ? `${label}: ${formatDate(value, locale) ?? ''}` : undefined}
          aria-invalid={invalid}
          className={cn('h-10 justify-start gap-2 bg-card font-normal md:text-body', className)}
        >
          <CalendarIcon className="text-muted-foreground" />
          <span>{value ? formatDate(value, locale) : ''}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          locale={locale === 'ar' ? arSA : enGB}
          dir={locale === 'ar' ? 'rtl' : 'ltr'}
          weekStartsOn={6}
          numerals="latn"
          selected={value ? fromKey(value) : undefined}
          defaultMonth={value ? fromKey(value) : undefined}
          disabled={disabled}
          onSelect={(d) => {
            if (d) onChange(toKey(d));
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** A wall time `HH:MM` from a shadcn `Select` every 15 minutes, written «5:30 م». */
export function TimeSelect({
  id,
  value,
  onChange,
  invalid,
  className,
  times = QUARTER_TIMES,
  label,
}: {
  /** Accessible name when the visible label points at another control (e.g. a date + time pair). */
  label?: string;
  id?: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  className?: string;
  times?: string[];
}) {
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const options = times.includes(value) || !value ? times : [...times, value].sort();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        id={id}
        aria-label={label}
        aria-invalid={invalid}
        className={cn('h-10! w-full', className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-72">
        {options.map((time) => (
          <SelectItem key={time} value={time}>
            <bdi>{wallTime(time, locale)}</bdi>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;

/** «نوفمبر 2026» / «November 2026» for a `YYYY-MM`, Latin digits (D32). */
export function formatMonth(value: string, locale: 'ar' | 'en'): string {
  const [y, m] = value.split('-').map(Number);
  if (!y || !m) return '';
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    month: 'long',
    year: 'numeric',
    numberingSystem: 'latn',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/**
 * A `YYYY-MM` month picker in the UI language (replaces `<input type="month">`, which shows the
 * browser's language and no Arabic month names): the shadcn Date Picker pattern (Popover + outline
 * Button) with a year header and the twelve months as buttons; `min`/`max` disable months outside.
 */
export function MonthPicker({
  id,
  value,
  onChange,
  label,
  min,
  max,
  invalid,
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Accessible name when no visible label points at the button. */
  label?: string;
  min?: string;
  max?: string;
  invalid?: boolean;
  className?: string;
}) {
  const t = useTranslations('form.month');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const [open, setOpen] = useState(false);
  const thisYear = new Date().getFullYear();
  const valueYear = Number(value.slice(0, 4)) || thisYear;
  const [year, setYear] = useState(valueYear);
  const names = Array.from({ length: 12 }, (_, i) =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
      month: 'long',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2000, i, 1))),
  );
  const outside = (key: string) => (!!min && key < min) || (!!max && key > max);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setYear(valueYear);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          aria-label={label ? `${label}: ${value ? formatMonth(value, locale) : ''}` : undefined}
          aria-invalid={invalid}
          className={cn('h-10 justify-start gap-2 bg-card font-normal md:text-body', className)}
        >
          <CalendarIcon className="text-muted-foreground" />
          <span>{value ? formatMonth(value, locale) : t('choose')}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        <div className="mb-2 flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('prevYear')}
            disabled={!!min && monthKey(year - 1, 12) < min}
            onClick={() => setYear((y) => y - 1)}
          >
            <ChevronRightIcon className="ltr:rotate-180" />
          </Button>
          <span className="font-semibold tabular-nums" aria-live="polite">
            {year}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('nextYear')}
            disabled={!!max && monthKey(year + 1, 1) > max}
            onClick={() => setYear((y) => y + 1)}
          >
            <ChevronLeftIcon className="ltr:rotate-180" />
          </Button>
        </div>
        <div role="group" aria-label={String(year)} className="grid grid-cols-3 gap-1">
          {names.map((name, i) => {
            const key = monthKey(year, i + 1);
            const selected = key === value;
            return (
              <Button
                key={key}
                type="button"
                size="sm"
                variant={selected ? 'default' : 'ghost'}
                aria-pressed={selected}
                aria-label={`${name} ${year}`}
                disabled={outside(key)}
                onClick={() => {
                  onChange(key);
                  setOpen(false);
                }}
                className="h-9"
              >
                {name}
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
