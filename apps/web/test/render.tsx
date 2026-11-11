import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import { DirectionProvider } from '@qarabic/ui/components/direction';
import { Toaster } from '@qarabic/ui/components/sonner';
import { TooltipProvider } from '@qarabic/ui/components/tooltip';
import ar from '@/messages/ar.json';
import en from '@/messages/en.json';

/** Renders with the same providers as the app (Arabic RTL by default) and a fresh query cache. */
export function renderWithProviders(
  ui: ReactElement,
  { locale = 'ar', ...options }: RenderOptions & { locale?: 'ar' | 'en' } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider
        locale={locale}
        messages={locale === 'ar' ? ar : en}
        timeZone="Africa/Cairo"
      >
        <DirectionProvider dir={locale === 'ar' ? 'rtl' : 'ltr'}>
          <TooltipProvider>
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
            <Toaster />
          </TooltipProvider>
        </DirectionProvider>
      </NextIntlClientProvider>
    );
  }
  return { queryClient, ...render(ui, { wrapper: Wrapper, ...options }) };
}
