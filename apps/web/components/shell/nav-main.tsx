'use client';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@qarabic/ui/components/collapsible';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@qarabic/ui/components/sidebar';
import { useQuery } from '@tanstack/react-query';
import { ChevronDownIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { crmKeys, fetchLeadSummary } from '@/lib/api/crm';
import { fetchRequestCounts, requestKeys } from '@/lib/api/requests';
import { fetchFeedbackSummary, fetchSupportSummary, supportKeys } from '@/lib/api/support';
import { useViewerTz } from '@/components/sessions/times';
import { isActive, isGroup, type NavEntry, type NavItem } from '@/lib/navigation';

function CountBadge({ n, suffix }: { n: number; suffix: string }) {
  if (!n) return null;
  return (
    <SidebarMenuBadge className="top-3! rounded-full bg-accent text-accent-foreground peer-hover/menu-button:text-accent-foreground peer-data-active/menu-button:text-accent-foreground">
      {n}
      <span className="sr-only"> {suffix}</span>
    </SidebarMenuBadge>
  );
}

/** «طلبات الحصص (4)»: pending requests, refreshed every minute (K3). */
function PendingBadge() {
  const t = useTranslations('nav');
  const counts = useQuery({
    queryKey: requestKeys.counts,
    queryFn: ({ signal }) => fetchRequestCounts(signal),
    refetchInterval: 60_000,
  });
  return <CountBadge n={counts.data?.pending ?? 0} suffix={t('pendingSuffix')} />;
}

/** «العملاء المحتملون»: new leads + follow-ups due today (docs/26 §9), in the viewer's zone. */
function LeadsBadge() {
  const t = useTranslations('nav');
  const tz = useViewerTz();
  const summary = useQuery({
    queryKey: crmKeys.summary(tz),
    queryFn: ({ signal }) => fetchLeadSummary(tz, signal),
    refetchInterval: 60_000,
  });
  const n = (summary.data?.new ?? 0) + (summary.data?.followUpsDue ?? 0);
  return <CountBadge n={n} suffix={t('leadsSuffix')} />;
}

/** «صندوق الطلبات»: open requests of my queues (`/support/summary`). */
function SupportBadge() {
  const t = useTranslations('nav');
  const summary = useQuery({
    queryKey: supportKeys.summary,
    queryFn: ({ signal }) => fetchSupportSummary(signal),
    refetchInterval: 60_000,
  });
  return <CountBadge n={summary.data?.openTotal ?? 0} suffix={t('openSuffix')} />;
}

/** «طلباتي» (requests with news) and «فرز البلاغات» (new reports) from `/feedback/summary`. */
function FeedbackBadge({ kind }: { kind: 'mineUpdates' | 'triageNew' }) {
  const t = useTranslations('nav');
  const summary = useQuery({
    queryKey: supportKeys.feedbackSummary,
    queryFn: ({ signal }) => fetchFeedbackSummary(signal),
    refetchInterval: 60_000,
  });
  return (
    <CountBadge
      n={summary.data?.[kind] ?? 0}
      suffix={t(kind === 'mineUpdates' ? 'updatesSuffix' : 'newSuffix')}
    />
  );
}

/**
 * `nav-main` of the shadcn `sidebar-07` block, with the documented collapsible `SidebarGroup`
 * for «المستخدمون» and «الإعدادات», as the current app groups its menu. Sized like the current
 * app's menu: 44px rows, 15px text, 20px grey icons, a light hover fill, and the brand colour only
 * on the active item (tinted background, semibold). Groups start open, as in the current app.
 */
const ITEM_CLASS = [
  'h-11 gap-3 px-3 text-[0.9375rem] font-medium',
  'hover:bg-subtle hover:text-sidebar-foreground active:bg-subtle',
  '[&_svg]:size-5 [&_svg]:text-muted-foreground',
  'data-active:font-semibold data-active:[&_svg]:text-sidebar-accent-foreground',
  'data-active:hover:bg-sidebar-accent data-active:hover:text-sidebar-accent-foreground',
  'group-data-[collapsible=icon]:p-1.5!',
].join(' ');

function Items({ items, tooltipSide }: { items: NavItem[]; tooltipSide: 'left' | 'right' }) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
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
            {item.badge === 'pendingRequests' && <PendingBadge />}
            {item.badge === 'supportOpen' && <SupportBadge />}
            {item.badge === 'leads' && <LeadsBadge />}
            {(item.badge === 'mineUpdates' || item.badge === 'triageNew') && (
              <FeedbackBadge kind={item.badge} />
            )}
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

export function NavMain({
  entries,
  tooltipSide,
}: {
  entries: NavEntry[];
  tooltipSide: 'left' | 'right';
}) {
  const t = useTranslations('nav');
  const top = entries.filter((e): e is NavItem => !isGroup(e));
  const groups = entries.filter(isGroup);
  return (
    <>
      <SidebarGroup className="px-2 pt-3">
        <SidebarGroupContent>
          <Items items={top} tooltipSide={tooltipSide} />
        </SidebarGroupContent>
      </SidebarGroup>
      {groups.map((group) => (
        <Collapsible key={group.group} defaultOpen className="group/collapsible">
          <SidebarGroup className="px-2 py-1">
            <SidebarGroupLabel
              asChild
              className="h-9 px-3 text-sm font-semibold text-muted-foreground hover:bg-subtle"
            >
              <CollapsibleTrigger>
                {t(`groups.${group.group}`)}
                <ChevronDownIcon className="ms-auto transition-transform group-data-[state=open]/collapsible:rotate-180" />
              </CollapsibleTrigger>
            </SidebarGroupLabel>
            <CollapsibleContent>
              <SidebarGroupContent>
                <Items items={group.items} tooltipSide={tooltipSide} />
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>
      ))}
    </>
  );
}
