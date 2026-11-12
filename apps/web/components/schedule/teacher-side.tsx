'use client';

import { SunMoonIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useUiLocale } from '@/components/sessions/times';
import { otherSideOf, wallTime, weekdayName } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';

/**
 * The teacher's side of a weekly time (D30, D38): «المعلم: الأحد 12:00 ص (القاهرة)», shown when it
 * differs, with the DST note when that local time changes during the year.
 */
export function TeacherSide({
  slot,
  teacher,
  from,
  variesWithDst,
}: {
  slot: { weekday: number; localStartTime: string; timezone: string };
  teacher: { timezone: string };
  from: string;
  /** From the API (`teacherLocal.variesWithDst`) when known. */
  variesWithDst?: boolean;
}) {
  const t = useTranslations('schedule');
  const locale = useUiLocale();
  const side = otherSideOf(slot, teacher.timezone, from);
  const dst = variesWithDst ?? side.variesWithDst;
  const same =
    teacher.timezone === slot.timezone ||
    (side.weekday === slot.weekday && side.time === slot.localStartTime && !dst);
  if (same) return null;
  return (
    <span className="flex flex-col gap-0.5 text-sm text-muted-foreground">
      <span>
        {t('teacherSees', {
          day: weekdayName(side.weekday, locale),
          time: wallTime(side.time, locale),
          city: cityOf(teacher.timezone, locale),
        })}
      </span>
      {dst && (
        <span className="inline-flex items-center gap-1 font-medium text-status-brown-emphasis">
          <SunMoonIcon aria-hidden className="size-4" />
          {t('dstNote')}
        </span>
      )}
    </span>
  );
}
