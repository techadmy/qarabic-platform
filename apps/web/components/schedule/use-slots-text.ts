'use client';

import type { EnrollmentDto } from '@qarabic/shared';
import { useUiLocale } from '@/components/sessions/times';
import { wallTime, weekdayName } from '@/lib/schedule-time';

/** «السبت 5:00 م، الإثنين 5:00 م» in the enrollment's zone. */
export function useSlotsText() {
  const locale = useUiLocale();
  return (e: Pick<EnrollmentDto, 'slots'>) =>
    e.slots
      .filter((s) => !s.validTo)
      .map((s) => `${weekdayName(s.weekday, locale)} ${wallTime(s.localStartTime, locale)}`)
      .join('، ');
}
