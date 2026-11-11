'use client';

import { FieldDescription } from '@qarabic/ui/components/field';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandLogo } from '@/components/brand-logo';
import { useSwitchLocale } from '@/hooks/use-switch-locale';

/**
 * Page frame of the official shadcn `login-03` block: the Qarabic logo above the card on a muted
 * background. The block's terms line under the card holds the language switch instead.
 */
export function AuthPage({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const { other, switchTo, pending } = useSwitchLocale();
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <main className="flex w-full max-w-sm flex-col gap-6">
        <Link href="/login" className="self-center">
          <BrandLogo className="w-44" priority />
        </Link>
        {children}
        <FieldDescription className="px-6 text-center">
          <button
            type="button"
            lang={other}
            onClick={() => switchTo(other)}
            disabled={pending}
            aria-label={t('languages.switchToLabel')}
            className="underline underline-offset-4 hover:text-primary"
          >
            {t('languages.switchTo')}
          </button>
        </FieldDescription>
      </main>
    </div>
  );
}
