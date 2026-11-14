'use client';

import type { Me } from '@qarabic/shared';
import { Avatar, AvatarFallback } from '@qarabic/ui/components/avatar';
import { Button } from '@qarabic/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import { LogOutIcon, UserRoundIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useLogout } from '@/lib/auth/use-me';

/** First letter of the name, as on the current app's avatar. */
function initial(name: string): string {
  return Array.from(name.trim())[0] ?? '';
}

/**
 * Account menu at the end of the top bar (current app layout): a round brand-coloured avatar that
 * opens name + email, «إعدادات الحساب» and logout. Built from the shadcn `nav-user` parts (DropdownMenu + Avatar).
 */
export function UserMenu({ user, dir }: { user: Pick<Me, 'name' | 'email'>; dir: 'rtl' | 'ltr' }) {
  const t = useTranslations();
  const logout = useLogout();
  return (
    <DropdownMenu dir={dir}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label={t('nav.account')}
          className="size-11 rounded-full"
        >
          <Avatar className="size-9 after:border-0">
            <AvatarFallback className="bg-primary text-base font-medium text-primary-foreground">
              {initial(user.name)}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5 px-3 py-2 text-start font-normal">
          <span className="truncate text-sm font-semibold text-foreground">{user.name}</span>
          <span className="truncate text-sm text-muted-foreground">
            <bdi dir="ltr">{user.email}</bdi>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <UserRoundIcon />
            {t('nav.accountSettings')}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => logout.mutate()} disabled={logout.isPending}>
          <LogOutIcon className="rtl:-scale-x-100" />
          {t('common.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
