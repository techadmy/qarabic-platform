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
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ComponentProps } from 'react';
import { BrandLogo, BrandMark } from '@/components/brand-logo';
import { navItemsFor } from '@/lib/navigation';
import { NavMain } from './nav-main';
import { NavUser } from './nav-user';

/**
 * `app-sidebar` of the shadcn `sidebar-07` block (collapses to icons). RTL: the sidebar sits on
 * the right and gets `dir`, as in shadcn's sidebar RTL notes. The block's team switcher becomes a
 * static brand item with the Qarabic logo (the mark when collapsed to icons), and its projects group is dropped.
 */
export function AppSidebar({
  me,
  dir,
  ...props
}: ComponentProps<typeof Sidebar> & { me: Me; dir: 'rtl' | 'ltr' }) {
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
                <span className="group-data-[collapsible=icon]:hidden">
                  <BrandLogo className="w-36" />
                </span>
                {/* Icon rail: the square mark; on dark backgrounds it sits on a white tile. */}
                <span className="hidden shrink-0 rounded-md group-data-[collapsible=icon]:block dark:bg-white">
                  <BrandMark />
                </span>
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
