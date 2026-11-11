'use client';

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@qarabic/ui/components/sidebar';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isActive, type NavItem } from '@/lib/navigation';

/**
 * `nav-main` of the shadcn `sidebar-07` block. Our items have no sub-items yet, so each one is a
 * plain `SidebarMenuButton` link (the block's collapsible group comes back when groups do).
 */
export function NavMain({
  items,
  tooltipSide,
}: {
  items: NavItem[];
  tooltipSide: 'left' | 'right';
}) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t('group')}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const active = isActive(item, pathname);
          return (
            <SidebarMenuItem key={item.key}>
              <SidebarMenuButton
                asChild
                isActive={active}
                tooltip={{ children: t(item.key), side: tooltipSide }}
              >
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  // The mobile sidebar is a sheet: close it once the user picks a page.
                  onClick={() => isMobile && setOpenMobile(false)}
                >
                  <item.icon />
                  <span>{t(item.key)}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}
