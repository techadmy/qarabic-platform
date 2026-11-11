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
 * Sized like the current app's menu: 44px rows, 15px text, 20px grey icons, a light hover fill,
 * and the brand colour only on the active item (tinted background, semibold).
 */
const ITEM_CLASS = [
  'h-11 gap-3 px-3 text-[0.9375rem] font-medium',
  'hover:bg-subtle hover:text-sidebar-foreground active:bg-subtle',
  '[&_svg]:size-5 [&_svg]:text-muted-foreground',
  'data-active:font-semibold data-active:[&_svg]:text-sidebar-accent-foreground',
  'data-active:hover:bg-sidebar-accent data-active:hover:text-sidebar-accent-foreground',
  'group-data-[collapsible=icon]:p-1.5!',
].join(' ');
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
    <SidebarGroup className="px-2">
      {/* Grey section label, as the current app's menu groups. */}
      <SidebarGroupLabel className="h-9 px-3 text-sm font-semibold text-muted-foreground">
        {t('group')}
      </SidebarGroupLabel>
      <SidebarMenu className="gap-0.5">
        {items.map((item) => {
          const active = isActive(item, pathname);
          return (
            <SidebarMenuItem key={item.key}>
              <SidebarMenuButton
                asChild
                isActive={active}
                className={ITEM_CLASS}
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
