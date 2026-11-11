'use client';

import type { Me } from '@qarabic/shared';
import {
  Sidebar,
  SidebarContent,
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
import { navFor } from '@/lib/navigation';
import { NavMain } from './nav-main';

/**
 * `app-sidebar` of the shadcn `sidebar-07` block (collapses to icons), styled like the current
 * app's sidebar: white, full height, the logo in a 64px header row that lines up with the top bar.
 * RTL: the sidebar sits on the right and gets `dir`, as in shadcn's sidebar RTL notes. The block's
 * team switcher becomes the Qarabic logo (the mark when collapsed to icons); its projects group is
 * dropped, and its user menu moved to the top bar (`UserMenu`), as in the current app. The menu is
 * the portal of the user's role kind (staff groups, «طلابي» for a teacher, «عائلتي» for a parent).
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
      <SidebarHeader className="h-16 shrink-0 justify-center border-b border-sidebar-border px-3 py-0 group-data-[collapsible=icon]:px-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              asChild
              className="hover:bg-transparent active:bg-transparent"
            >
              <Link href="/">
                <span className="group-data-[collapsible=icon]:hidden">
                  <BrandLogo className="w-33" />
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
        <NavMain entries={navFor(me)} tooltipSide={dir === 'rtl' ? 'left' : 'right'} />
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
