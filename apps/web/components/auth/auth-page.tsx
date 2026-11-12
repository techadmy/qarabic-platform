'use client';

import { CardDescription, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandLogo } from '@/components/brand-logo';
import { LanguageSwitch } from '@/components/language-switch';

/**
 * Page frame of the auth screens, composed like the current app's login: the language switch in
 * the top corner, and one centred 420px card on the warm-grey canvas. The card itself is the
 * shadcn `login-01` Card (see the forms); its header is `AuthCardHeader`.
 */
export function AuthPage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <div className="flex justify-end p-4">
        <LanguageSwitch />
      </div>
      <main className="flex flex-1 items-center justify-center px-4 pb-12">
        <div className="w-full max-w-[420px]">{children}</div>
      </main>
    </div>
  );
}

/** Card classes of the auth forms: 24px padding on phones, 32px from `sm`, hairline border. */
export const AUTH_CARD_CLASS =
  'gap-6 ring-border [--card-spacing:--spacing(6)] sm:[--card-spacing:--spacing(8)]';

/**
 * Header of the auth card (current app): the logo with the tagline under it, then the page title
 * (the one h1) centred, and an optional hint.
 */
export function AuthCardHeader({ title, description }: { title: string; description?: string }) {
  const t = useTranslations('app');
  return (
    <CardHeader className="justify-items-center gap-0 text-center">
      <Link href="/login" className="rounded-md">
        <BrandLogo className="w-50" priority />
      </Link>
      <p className="mt-2 text-sm text-muted-foreground">{t('tagline')}</p>
      <CardTitle className="mt-6 text-[1.375rem] leading-snug font-bold">
        <h1>{title}</h1>
      </CardTitle>
      {description && <CardDescription className="mt-2 text-body">{description}</CardDescription>}
    </CardHeader>
  );
}
