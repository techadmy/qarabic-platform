'use client';

import type { Me } from '@qarabic/shared';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@qarabic/ui/components/sidebar';
import { BookOpenTextIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ComponentProps } from 'react';
import { navItemsFor } from '@/lib/navigation';
import { NavMain } from './nav-main';
import { NavUser } from './nav-user';

/**
 * `app-sidebar` of the shadcn `sidebar-07` block (collapses to icons). RTL: the sidebar sits on
 * the right and gets `dir`, as in shadcn's sidebar RTL notes. The block's team switcher becomes a
 * static brand item (we have one academy), and its projects group is dropped.
 */
export function AppSidebar({
  me,
  dir,
  ...props
}: ComponentProps<typeof Sidebar> & { me: Me; dir: 'rtl' | 'ltr' }) {
  const t = useTranslations('app');
  const tn = useTranslations('nav');
  return (
    <Sidebar
      collapsible="icon"
      dir={dir}
      side={dir === 'rtl' ? 'right' : 'left'}
      mobileTitle={tn('menuTitle')}
      mobileDescription={tn('menuDescription')}
      {...props}
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <BookOpenTextIcon className="size-4" aria-hidden />
                </div>
                <div className="grid flex-1 text-start text-sm leading-tight">
                  <span className="truncate font-medium">{t('name')}</span>
                  <span className="truncate text-xs">{t('tagline')}</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navItemsFor(me)} tooltipSide={dir === 'rtl' ? 'left' : 'right'} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={me} dir={dir} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
