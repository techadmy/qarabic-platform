'use client';

import type { Me } from '@qarabic/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { setLocale } from '@/i18n/actions';
import { directionOf, isLocale, type Locale } from '@/i18n/config';
import { updateMe } from '@/lib/api/auth';
import { meQueryKey } from '@/lib/auth/use-me';

/**
 * Saves the locale in the cookie and re-renders the page in the new language and direction.
 * `persist` (signed in): also saves it on the account (`PATCH /me`), so the next login on any
 * device opens in the same language.
 */
export function useSwitchLocale() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const current = useLocale();
  const [pending, startTransition] = useTransition();
  const locale: Locale = isLocale(current) ? current : 'ar';

  function switchTo(next: Locale, { persist = false }: { persist?: boolean } = {}) {
    startTransition(async () => {
      if (persist) {
        try {
          queryClient.setQueryData<Me | null>(meQueryKey, await updateMe({ locale: next }));
        } catch {
          // The cookie still switches the page; the account keeps its language until next time.
        }
      }
      await setLocale(next);
      document.documentElement.lang = next;
      document.documentElement.dir = directionOf(next);
      router.refresh();
    });
  }

  return { locale, other: (locale === 'ar' ? 'en' : 'ar') as Locale, switchTo, pending };
}
