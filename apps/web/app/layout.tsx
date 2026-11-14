import '@qarabic/ui/globals.css';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { IBM_Plex_Sans_Arabic, Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { directionOf, isLocale, DEFAULT_LOCALE } from '@/i18n/config';

const arabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-arabic',
  display: 'swap',
});

const latin = Inter({
  subsets: ['latin'],
  variable: '--font-latin',
  display: 'swap',
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app');
  return {
    title: { default: t('name'), template: `%s · ${t('name')}` },
    description: t('tagline'),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const current = await getLocale();
  const locale = isLocale(current) ? current : DEFAULT_LOCALE;
  const dir = directionOf(locale);
  // The CSP nonce proxy.ts set for this request (docs/39 P0-2).
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html
      lang={locale}
      dir={dir}
      suppressHydrationWarning
      className={`${arabic.variable} ${latin.variable}`}
    >
      <body>
        <NextIntlClientProvider>
          <Providers dir={dir} nonce={nonce}>
            {children}
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
