'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useCurrentUser } from '@/components/shell/app-shell';
import { clock, dayAndClock, instantDayShift } from '@/lib/schedule-time';
import { browserTimeZone, cityOf, isValidTimeZone } from '@/lib/time';

/** The viewer's zone (D30): the account's, else the browser's. */
export function useViewerTz(): string {
  const me = useCurrentUser();
  return isValidTimeZone(me.timezone) ? me.timezone : browserTimeZone();
}

export function useUiLocale(): 'ar' | 'en' {
  return useLocale() === 'en' ? 'en' : 'ar';
}

/** Re-renders every `ms` so "now" markers stay right. */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * The other party's labelled time of a class (D30, docs/15 §5.12):
 * «الطالب 11:00 ص (نيويورك) +1 يوم». Shown under a name; the viewer's own time is the row's time.
 */
export function OtherTime({
  at,
  tz,
  party,
  showParty = true,
}: {
  at: string;
  tz: string;
  party: 'student' | 'teacher';
  showParty?: boolean;
}) {
  const t = useTranslations('classes');
  const locale = useUiLocale();
  const viewerTz = useViewerTz();
  if (!isValidTimeZone(tz)) return null;
  const shift = instantDayShift(at, viewerTz, tz);
  return (
    <span className="text-sm whitespace-nowrap text-muted-foreground">
      {showParty && <>{t(`party.${party}`)} </>}
      <bdi>{clock(at, tz, locale)}</bdi> ({cityOf(tz, locale)})
      {shift !== 0 && (
        <strong className="font-semibold text-foreground">
          {' '}
          <bdi>{t('dayShift', { n: shift > 0 ? `+${shift}` : `${shift}` })}</bdi>
        </strong>
      )}
    </span>
  );
}

/**
 * Viewer's time first, then the other party's labelled time:
 * «الأربعاء، 11 نوفمبر، 6:00 م (القاهرة) · الطالب 11:00 ص (نيويورك)».
 */
export function BothClassTimes({
  at,
  otherTz,
  party,
}: {
  at: string;
  otherTz: string;
  party: 'student' | 'teacher';
}) {
  const locale = useUiLocale();
  const viewerTz = useViewerTz();
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium">
        <bdi>{dayAndClock(at, viewerTz, locale)}</bdi>{' '}
        <span className="text-muted-foreground">({cityOf(viewerTz, locale)})</span>
      </span>
      {otherTz !== viewerTz && <OtherTime at={at} tz={otherTz} party={party} />}
    </span>
  );
}
