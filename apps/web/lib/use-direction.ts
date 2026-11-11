'use client';

import { useLocale } from 'next-intl';
import { directionOf, isLocale } from '@/i18n/config';

/** `rtl` in Arabic, `ltr` in English. */
export function useDirection(): 'rtl' | 'ltr' {
  const locale = useLocale();
  return directionOf(isLocale(locale) ? locale : 'ar');
}
