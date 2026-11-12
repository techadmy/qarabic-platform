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
import { createContext, useContext, useEffect, type CSSProperties, type ReactNode } from 'react';
import { directionOf, isLocale } from '@/i18n/config';
import { loginPathFor } from '@/lib/auth/redirect';
import { useMe } from '@/lib/auth/use-me';
import { currentPage } from '@/lib/navigation';
import { useSwitchLocale } from '@/hooks/use-switch-locale';
import { GlobalSearch } from '@/components/shell/global-search';
import { LanguageSwitch } from '@/components/language-switch';
import { ErrorState } from '@/components/states';
import { ContactButton } from '@/components/support/contact-button';
import { AppSidebar } from './app-sidebar';
import { NotificationBell } from './notification-bell';
import { UserMenu } from './user-menu';

const MeContext = createContext<Me | null>(null);

/** The signed-in user inside the app shell (always set there). */
export function useCurrentUser(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useCurrentUser must be used inside <AppShell>');
  return me;
}

/** Current app: 248px sidebar (shadcn default is 256px). */
const SIDEBAR_STYLE = { '--sidebar-width': '15.5rem' } as CSSProperties;

/**
 * Authenticated shell: page layout of the shadcn `sidebar-07` block (SidebarProvider + AppSidebar +
 * SidebarInset), laid out like the current app: a white 64px top bar with a hairline under it
 * (sidebar trigger and page name at the start; language and the account avatar at the end) over
 * the warm-grey canvas, with 24px page padding. No session → `/login?next=…`.
 */
export function AppShell({ defaultOpen, children }: { defaultOpen: boolean; children: ReactNode }) {
  const t = useTranslations();
  const locale = useLocale();
  const dir = directionOf(isLocale(locale) ? locale : 'ar');
  const { data: me, isPending, isError, refetch } = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const { switchTo, pending: switchingLocale } = useSwitchLocale();

  // The account's language wins after login (N0 gap): a cookie from another session or the login
  // page's switch is replaced by `me.locale`. The top-bar switch saves to the account, so they agree.
  useEffect(() => {
    if (me && !switchingLocale && me.locale !== locale) switchTo(me.locale);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run when the account or page language changes
  }, [me?.locale, locale]);

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
        <Skeleton className="hidden h-svh w-62 rounded-none md:block" />
        <div className="flex flex-1 flex-col gap-4 p-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const current = currentPage(me, pathname);

  return (
    <MeContext.Provider value={me}>
      <SidebarProvider defaultOpen={defaultOpen} style={SIDEBAR_STYLE}>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:start-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
        >
          {t('common.skipToContent')}
        </a>
        <AppSidebar me={me} dir={dir} />
        {/* min-w-0: wide tables scroll inside their own card instead of widening the page. */}
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-2 border-b bg-card px-3 md:px-4">
            <SidebarTrigger className="size-9" aria-label={t('common.toggleSidebar')} />
            <Separator
              orientation="vertical"
              className="mx-1 data-vertical:h-5 data-vertical:self-auto"
            />
            <Breadcrumb className="min-w-0">
              <BreadcrumbList>
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbPage className="truncate text-[1.0625rem] font-semibold">
                    {current ? t(`nav.${current.key}`) : t('app.name')}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <div className="ms-auto flex shrink-0 items-center gap-1">
              <GlobalSearch />
              <ContactButton />
              <NotificationBell />
              <LanguageSwitch persist />
              <UserMenu user={me} dir={dir} />
            </div>
          </header>
          <main
            id="main"
            tabIndex={-1}
            className="flex min-w-0 flex-1 flex-col gap-4 p-4 outline-none md:p-6"
          >
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </MeContext.Provider>
  );
}
