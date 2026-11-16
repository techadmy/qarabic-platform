'use client';

import { Label } from '@qarabic/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Switch } from '@qarabic/ui/components/switch';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { DatePicker } from '@/components/forms/date-time';
import { useUiLocale } from '@/components/sessions/times';
import {
  MAX_RANGE_DAYS,
  RANGE_PRESETS,
  type DashboardRange,
  type RangePreset,
} from '@/lib/dashboard/range';
import { addDays, dayLabel } from '@/lib/schedule-time';

/**
 * The dashboard's one time control (docs/40 §2.4): a preset, or from/to for «مخصّص», and «قارن
 * بالفترة السابقة». The parent keeps it in the URL; this only says what changed. The chosen dates
 * (and the previous period when comparing) are written out, so a shared link reads the same.
 */
export function RangeBar({
  range,
  previous,
  today,
  onChange,
  presets = RANGE_PRESETS,
  maxDays = MAX_RANGE_DAYS,
  showCompare = true,
}: {
  range: DashboardRange;
  /** Another report's choices and limit (R1: up to 92 days); the dashboard's by default. */
  presets?: readonly RangePreset[];
  maxDays?: number;
  /** A report that always compares (its API answers the previous period) hides the switch. */
  showCompare?: boolean;
  /** The period the API compared with (its `range.previous`), once the answer is in. */
  previous: { from: string; to: string } | null | undefined;
  today: string;
  onChange: (next: { preset: RangePreset; from?: string; to?: string; compare: boolean }) => void;
}) {
  const t = useTranslations('dashboard.range');
  const locale = useUiLocale();
  const ids = { preset: useId(), from: useId(), to: useId(), compare: useId() };
  const span = (from: string, to: string) =>
    from === to
      ? dayLabel(from, locale, true)
      : t('span', { from: dayLabel(from, locale, true), to: dayLabel(to, locale, true) });
  const set = (
    patch: Partial<{ preset: RangePreset; from: string; to: string; compare: boolean }>,
  ) =>
    onChange({
      preset: range.preset,
      from: range.from,
      to: range.to,
      compare: range.compare,
      ...patch,
    });
  return (
    <section
      aria-label={t('label')}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 md:flex-row md:flex-wrap md:items-end"
    >
      <div className="flex min-w-48 flex-col gap-2">
        <Label htmlFor={ids.preset} className="text-sm text-muted-foreground">
          {t('period')}
        </Label>
        <Select value={range.preset} onValueChange={(v) => set({ preset: v as RangePreset })}>
          <SelectTrigger id={ids.preset} className="h-10! w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {presets.map((p) => (
              <SelectItem key={p} value={p}>
                {t(`presets.${p}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {range.preset === 'custom' && (
        <>
          <div className="flex min-w-40 flex-col gap-2">
            <Label htmlFor={ids.from} className="text-sm text-muted-foreground">
              {t('from')}
            </Label>
            <DatePicker
              id={ids.from}
              value={range.from}
              min={addDays(range.to, -(maxDays - 1))}
              max={range.to}
              invalid={!!range.invalid}
              onChange={(v) => v && set({ from: v })}
            />
          </div>
          <div className="flex min-w-40 flex-col gap-2">
            <Label htmlFor={ids.to} className="text-sm text-muted-foreground">
              {t('to')}
            </Label>
            <DatePicker
              id={ids.to}
              value={range.to}
              min={range.from}
              max={today}
              invalid={!!range.invalid}
              onChange={(v) => v && set({ to: v })}
            />
          </div>
        </>
      )}
      {showCompare && (
        <div className="flex h-10 items-center gap-2">
          <Switch
            id={ids.compare}
            checked={range.compare}
            onCheckedChange={(on) => set({ compare: on })}
          />
          <Label htmlFor={ids.compare}>{t('compare')}</Label>
        </div>
      )}
      <p role="status" className="text-sm text-muted-foreground md:ms-auto md:self-center">
        <bdi>{span(range.from, range.to)}</bdi>
        {range.compare && previous && (
          <>
            {' · '}
            {t('versus', { span: span(previous.from, previous.to) })}
          </>
        )}
      </p>
      {range.invalid && (
        <p role="alert" className="basis-full text-sm text-destructive">
          {t(`invalid.${range.invalid}`, { max: maxDays })}
        </p>
      )}
    </section>
  );
}
