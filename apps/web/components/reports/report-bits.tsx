'use client';

import {
  HIFZ_GRADE_LABELS,
  HIFZ_TYPE_LABELS,
  REPORT_STATE_LABELS,
  type HifzEntryDto,
  type ReportState,
} from '@qarabic/shared';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { cn } from '@qarabic/ui/lib/utils';
import {
  AlarmClockIcon,
  CircleCheckIcon,
  HourglassIcon,
  StarIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ToneBadge, type Tone } from '@/components/sessions/badges';
import { useUiLocale } from '@/components/sessions/times';
import { rangeText } from '@/lib/reports/format';

const STATE: Record<ReportState, { tone: Tone; icon: LucideIcon }> = {
  pending: { tone: 'amber', icon: HourglassIcon },
  missing: { tone: 'red', icon: TriangleAlertIcon },
  on_time: { tone: 'green', icon: CircleCheckIcon },
  late: { tone: 'orange', icon: AlarmClockIcon },
};

/** Where a class stands on its report (`REPORT_STATES`), icon + text like the class chips. */
export function ReportStateBadge({ state }: { state: ReportState }) {
  const locale = useUiLocale();
  const label = REPORT_STATE_LABELS[state];
  return (
    <ToneBadge
      tone={STATE[state].tone}
      icon={STATE[state].icon}
      label={label[locale]}
      title={label.en}
    />
  );
}

/** The 1–5 class rating, read-only: five stars with the value in words for screen readers. */
export function RatingStars({ value, className }: { value: number; className?: string }) {
  const t = useTranslations('reports');
  return (
    <span
      role="img"
      aria-label={t('ratingValue', { value })}
      className={cn('inline-flex items-center gap-0.5', className)}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <StarIcon
          key={n}
          aria-hidden
          className={cn(
            'size-4',
            n <= value ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground/40',
          )}
        />
      ))}
    </span>
  );
}

/** The 1–5 rating as a shadcn `ToggleGroup` of stars (clicking the chosen star clears it). */
export function RatingInput({
  id,
  value,
  onChange,
  disabled,
  labelledBy,
}: {
  id?: string;
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
  labelledBy?: string;
}) {
  const t = useTranslations('reports');
  return (
    <ToggleGroup
      id={id}
      type="single"
      variant="outline"
      spacing={0}
      value={value ? String(value) : ''}
      onValueChange={(v) => onChange(v ? Number(v) : null)}
      aria-labelledby={labelledBy}
      disabled={disabled}
      className="bg-card"
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <ToggleGroupItem
          key={n}
          value={String(n)}
          aria-label={t('ratingValue', { value: n })}
          className="size-11 data-[state=on]:bg-accent"
        >
          <StarIcon
            aria-hidden
            className={cn(
              'size-5',
              value && n <= value ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground',
            )}
          />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** One hifz row in words: «الدرس الجديد (سبق): النبأ 1–16 (16 آية) · ممتاز · الأخطاء: 2». */
export function HifzLine({ h }: { h: HifzEntryDto }) {
  const t = useTranslations('reports');
  const locale = useUiLocale();
  const parts = [
    h.grade ? HIFZ_GRADE_LABELS[h.grade][locale] : null,
    h.mistakes !== null ? t('mistakesCount', { count: h.mistakes }) : null,
    h.pages !== null ? t('pagesCount', { count: h.pages }) : null,
    h.notes,
  ].filter(Boolean);
  return (
    <>
      <span className="font-semibold">{HIFZ_TYPE_LABELS[h.type][locale]}:</span>{' '}
      <bdi>{rangeText(h, locale)}</bdi>{' '}
      <span className="text-muted-foreground">({t('ayahsCount', { count: h.ayahs })})</span>
      {parts.length > 0 && <> · {parts.join(' · ')}</>}
    </>
  );
}
