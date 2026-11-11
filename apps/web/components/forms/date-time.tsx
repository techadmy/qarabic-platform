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
import { CalendarIcon } from 'lucide-react';
import { useLocale } from 'next-intl';
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
          className={cn('h-10 justify-start gap-2 font-normal md:text-[0.9375rem]', className)}
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
}: {
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
      <SelectTrigger id={id} aria-invalid={invalid} className={cn('h-10! w-full', className)}>
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
