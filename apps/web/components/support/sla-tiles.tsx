'use client';

import type { QueueCountsDto } from '@qarabic/shared';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Toggle } from '@qarabic/ui/components/toggle';
import { cn } from '@qarabic/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { ClockAlertIcon, InboxIcon, UserRoundXIcon, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { fetchSupportSummary, supportKeys } from '@/lib/api/support';

export type SlaTile = 'open' | 'breached' | 'unassigned';
const TILES: SlaTile[] = ['open', 'breached', 'unassigned'];
const ICONS: Record<SlaTile, LucideIcon> = {
  open: InboxIcon,
  breached: ClockAlertIcon,
  unassigned: UserRoundXIcon,
};

/**
 * The inbox's «الآن» tiles (S4, docs/32 §8): open requests, those past their first-response
 * deadline and those with nobody on them. A tile is a filter and its number is what that filter
 * shows (docs/15 §3.1): with a queue tab open the numbers are that queue's (from the list's own
 * counts), otherwise all of my queues (`/support/summary`, the menu badge's query). Pressing a tile
 * clears the other filters; «مفتوحة» is pressed only when nothing else narrows the list. A failed
 * refresh keeps the last counts.
 */
export function SlaTiles({
  active,
  queueCounts,
  onPick,
}: {
  /** The tile the list shows right now, or null when other filters narrow it. */
  active: SlaTile | null;
  /** The open queue tab's counts; undefined for «كل الأقسام». */
  queueCounts?: QueueCountsDto;
  onPick: (tile: SlaTile) => void;
}) {
  const t = useTranslations('support.inbox');
  const summary = useQuery({
    queryKey: supportKeys.summary,
    queryFn: ({ signal }) => fetchSupportSummary(signal),
    refetchInterval: 60_000,
    enabled: !queueCounts,
  });
  const s = summary.data;
  // Without any count (first load failed) the tiles step aside; the list says what went wrong.
  if (!queueCounts && !s && summary.isError) return null;
  const value: Record<SlaTile, number> = queueCounts
    ? queueCounts
    : {
        open: s?.openTotal ?? 0,
        breached: s?.breachedTotal ?? 0,
        unassigned: s?.unassignedTotal ?? 0,
      };
  const loading = !queueCounts && summary.isPending;
  return (
    <nav aria-label={t('tilesLabel')} className="grid grid-cols-3 gap-2 md:max-w-xl">
      {TILES.map((k) => {
        const Icon = ICONS[k];
        const alarm = k === 'breached' && value.breached > 0;
        return (
          <Toggle
            key={k}
            variant="outline"
            pressed={active === k}
            // Pressing the shown tile again goes back to all open requests.
            onPressedChange={(on) => onPick(on ? k : 'open')}
            className="h-auto min-h-14 flex-col items-start justify-center gap-0.5 bg-card px-3 py-2 whitespace-normal data-[state=on]:border-primary data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
          >
            {loading ? (
              <Skeleton className="h-6 w-8" />
            ) : (
              <span className="flex items-center gap-2">
                <Icon aria-hidden className={cn('size-4', alarm && 'text-status-red-emphasis')} />
                <bdi
                  className={cn(
                    'text-xl font-bold tabular-nums',
                    alarm && 'text-status-red-emphasis',
                  )}
                >
                  {value[k]}
                </bdi>
              </span>
            )}
            <span className="text-start text-sm leading-tight font-medium text-muted-foreground">
              {t(`tiles.${k}`)}
            </span>
          </Toggle>
        );
      })}
    </nav>
  );
}
