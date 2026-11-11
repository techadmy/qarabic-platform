'use client';

import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { setLocale } from '@/i18n/actions';
import { directionOf, isLocale, type Locale } from '@/i18n/config';

/** Saves the locale in the cookie and re-renders the page in the new language and direction. */
export function useSwitchLocale() {
  const router = useRouter();
  const current = useLocale();
  const [pending, startTransition] = useTransition();
  const locale: Locale = isLocale(current) ? current : 'ar';

  function switchTo(next: Locale) {
    startTransition(async () => {
      await setLocale(next);
      document.documentElement.lang = next;
      document.documentElement.dir = directionOf(next);
      router.refresh();
    });
  }

  return { locale, other: (locale === 'ar' ? 'en' : 'ar') as Locale, switchTo, pending };
}
