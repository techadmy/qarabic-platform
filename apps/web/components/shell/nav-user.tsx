'use client';

import type { Me } from '@qarabic/shared';
import { Avatar, AvatarFallback } from '@qarabic/ui/components/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@qarabic/ui/components/sidebar';
import { ChevronsUpDownIcon, LanguagesIcon, LogOutIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSwitchLocale } from '@/hooks/use-switch-locale';
import { isLocale, LOCALES } from '@/i18n/config';
import { useLogout } from '@/lib/auth/use-me';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('');
}

/** `nav-user` of the shadcn `sidebar-07` block: name, email, language and logout. */
export function NavUser({ user, dir }: { user: Pick<Me, 'name' | 'email'>; dir: 'rtl' | 'ltr' }) {
  const { isMobile } = useSidebar();
  const t = useTranslations();
  const logout = useLogout();
  const { locale, switchTo, pending } = useSwitchLocale();
  const userBlock = (
    <>
      <Avatar className="h-8 w-8 rounded-lg">
        <AvatarFallback className="rounded-lg">{initials(user.name)}</AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-start text-sm leading-tight">
        <span className="truncate font-medium">{user.name}</span>
        <span className="truncate text-xs" dir="ltr">
          <bdi>{user.email}</bdi>
        </span>
      </div>
    </>
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu dir={dir}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label={t('nav.account')}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              {userBlock}
              <ChevronsUpDownIcon className="ms-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
            side={isMobile ? 'bottom' : dir === 'rtl' ? 'left' : 'right'}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-start text-sm">
                {userBlock}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <LanguagesIcon />
                  {t('common.language')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={locale}
                    onValueChange={(value) => {
                      if (isLocale(value) && value !== locale && !pending) switchTo(value);
                    }}
                  >
                    {LOCALES.map((l) => (
                      <DropdownMenuRadioItem key={l} value={l} lang={l}>
                        {t(`languages.${l}`)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => logout.mutate()} disabled={logout.isPending}>
              <LogOutIcon />
              {t('common.logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
