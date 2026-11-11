'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { useCurrentUser } from '@/components/shell/app-shell';
import { cityOf, dayShift, formatTime, isValidTimeZone } from '@/lib/time';

/** Re-renders once a minute so local clocks stay right. */
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The other party's local time now, labelled with their city (D30, docs/15 §5.12): «5:22 م · نيويورك»,
 * with «اليوم التالي» / «اليوم السابق» when their date differs from the viewer's.
 */
export function LocalTime({ timeZone }: { timeZone: string | null | undefined }) {
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const t = useTranslations('time');
  const me = useCurrentUser();
  const now = useNow();
  if (!isValidTimeZone(timeZone)) return <span className="text-muted-foreground">—</span>;
  const shift = isValidTimeZone(me.timezone) ? dayShift(me.timezone, timeZone, now) : 0;
  return (
    <span className="whitespace-nowrap">
      <bdi>{formatTime(timeZone, locale, now)}</bdi>
      <span className="text-muted-foreground"> · {cityOf(timeZone, locale)}</span>
      {shift !== 0 && (
        <span className="text-muted-foreground">
          {' '}
          ({shift > 0 ? t('dayAhead') : t('dayBehind')})
        </span>
      )}
    </span>
  );
}

/**
 * Viewer's time first, then the other party's labelled time (D30):
 * «عندك 12:22 م (القاهرة) · ولي الأمر 5:22 م (نيويورك)».
 */
export function BothTimes({ timeZone, party }: { timeZone: string; party: string }) {
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const t = useTranslations('time');
  const me = useCurrentUser();
  const now = useNow();
  const viewerTz = isValidTimeZone(me.timezone) ? me.timezone : 'UTC';
  return (
    <span className="flex flex-col gap-0.5">
      <span>
        {t('yours')}: <bdi>{formatTime(viewerTz, locale, now)}</bdi>{' '}
        <span className="text-muted-foreground">({cityOf(viewerTz, locale)})</span>
      </span>
      {isValidTimeZone(timeZone) && (
        <span>
          {party}: <bdi>{formatTime(timeZone, locale, now)}</bdi>{' '}
          <span className="text-muted-foreground">({cityOf(timeZone, locale)})</span>
        </span>
      )}
    </span>
  );
}
