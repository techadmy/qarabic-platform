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
import { RANGE_PRESETS, type DashboardRange, type RangePreset } from '@/lib/dashboard/range';
import { dayLabel } from '@/lib/schedule-time';

/**
 * The dashboard's one time control (docs/40 §2.4): a preset, or from/to for «مخصّص», and «قارن
 * بالفترة السابقة». The parent keeps it in the URL; this only says what changed. The chosen dates
 * (and the previous period when comparing) are written out, so a shared link reads the same.
 */
export function RangeBar({
  range,
  today,
  onChange,
}: {
  range: DashboardRange;
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
            {RANGE_PRESETS.map((p) => (
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
              max={range.to}
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
              onChange={(v) => v && set({ to: v })}
            />
          </div>
        </>
      )}
      <div className="flex h-10 items-center gap-2">
        <Switch
          id={ids.compare}
          checked={range.compare}
          onCheckedChange={(on) => set({ compare: on })}
        />
        <Label htmlFor={ids.compare}>{t('compare')}</Label>
      </div>
      <p role="status" className="text-sm text-muted-foreground md:ms-auto md:self-center">
        <bdi>{span(range.from, range.to)}</bdi>
        {range.previous && (
          <>
            {' · '}
            {t('versus', { span: span(range.previous.from, range.previous.to) })}
          </>
        )}
      </p>
    </section>
  );
}
