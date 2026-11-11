'use client';

import type { Me } from '@qarabic/shared';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '@qarabic/ui/components/breadcrumb';
import { Separator } from '@qarabic/ui/components/separator';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@qarabic/ui/components/sidebar';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { directionOf, isLocale } from '@/i18n/config';
import { loginPathFor } from '@/lib/auth/redirect';
import { useMe } from '@/lib/auth/use-me';
import { isActive, NAV_ITEMS } from '@/lib/navigation';
import { ErrorState } from '@/components/states';
import { AppSidebar } from './app-sidebar';

const MeContext = createContext<Me | null>(null);

/** The signed-in user inside the app shell (always set there). */
export function useCurrentUser(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useCurrentUser must be used inside <AppShell>');
  return me;
}

/**
 * Authenticated shell: page layout of the shadcn `sidebar-07` block (SidebarProvider + AppSidebar +
 * SidebarInset with the header row). No session → `/login?next=…`.
 */
export function AppShell({ defaultOpen, children }: { defaultOpen: boolean; children: ReactNode }) {
  const t = useTranslations();
  const locale = useLocale();
  const dir = directionOf(isLocale(locale) ? locale : 'ar');
  const { data: me, isPending, isError, refetch } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useEffect(() => {
    if (!isPending && !isError && !me) {
      router.replace(loginPathFor(pathname, search ? `?${search}` : ''));
    }
  }, [isPending, isError, me, pathname, search, router]);

  if (isError) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <ErrorState onRetry={() => void refetch()} />
      </div>
    );
  }

  if (!me) {
    return (
      <div className="flex min-h-svh" aria-busy="true">
        <span className="sr-only">{t('common.loading')}</span>
        <Skeleton className="hidden h-svh w-64 rounded-none md:block" />
        <div className="flex flex-1 flex-col gap-4 p-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const current = NAV_ITEMS.find((item) => isActive(item, pathname));

  return (
    <MeContext.Provider value={me}>
      <SidebarProvider defaultOpen={defaultOpen}>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:start-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
        >
          {t('common.skipToContent')}
        </a>
        <AppSidebar me={me} dir={dir} />
        <SidebarInset>
          <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
            <div className="flex items-center gap-2 px-4">
              <SidebarTrigger className="-ms-1" aria-label={t('common.toggleSidebar')} />
              <Separator
                orientation="vertical"
                className="me-2 data-vertical:h-4 data-vertical:self-auto"
              />
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage>
                      {current ? t(`nav.${current.key}`) : t('app.name')}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </div>
          </header>
          <main
            id="main"
            tabIndex={-1}
            className="flex flex-1 flex-col gap-4 p-4 pt-0 outline-none"
          >
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </MeContext.Provider>
  );
}
