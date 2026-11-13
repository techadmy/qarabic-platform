'use client';

import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Toggle } from '@qarabic/ui/components/toggle';
import { cn } from '@qarabic/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { ClockAlertIcon, InboxIcon, UserRoundXIcon, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { fetchSupportSummary, supportKeys } from '@/lib/api/support';

type Tile = 'open' | 'breached' | 'unassigned';
const ICONS: Record<Tile, LucideIcon> = {
  open: InboxIcon,
  breached: ClockAlertIcon,
  unassigned: UserRoundXIcon,
};

/**
 * The inbox's «الآن» tiles (S4, docs/32 §8): open requests in my queues, those past their
 * first-response deadline and those with nobody on them. A tile filters the list; pressed again it
 * clears. Counts come from `/support/summary` (the same query as the menu badge); a failed refresh
 * keeps the last counts.
 */
export function SlaTiles({
  breached,
  unassigned,
  onPick,
}: {
  breached: boolean;
  unassigned: boolean;
  onPick: (tile: Tile | null) => void;
}) {
  const t = useTranslations('support.inbox');
  const summary = useQuery({
    queryKey: supportKeys.summary,
    queryFn: ({ signal }) => fetchSupportSummary(signal),
    refetchInterval: 60_000,
  });
  const s = summary.data;
  // Without any count (first load failed) the tiles step aside; the list says what went wrong.
  if (!s && summary.isError) return null;
  const value: Record<Tile, number> = {
    open: s?.openTotal ?? 0,
    breached: s?.breachedTotal ?? 0,
    unassigned: s?.unassignedTotal ?? 0,
  };
  const active: Record<Tile, boolean> = {
    open: !breached && !unassigned,
    breached,
    unassigned,
  };
  return (
    <nav aria-label={t('tilesLabel')} className="grid grid-cols-3 gap-2 md:max-w-xl">
      {(['open', 'breached', 'unassigned'] as const).map((k) => {
        const Icon = ICONS[k];
        const alarm = k === 'breached' && value.breached > 0;
        return (
          <Toggle
            key={k}
            variant="outline"
            pressed={active[k]}
            onPressedChange={(on) => onPick(on && k !== 'open' ? k : null)}
            className="h-auto min-h-14 flex-col items-start justify-center gap-0.5 bg-card px-4 py-2 data-[state=on]:border-primary data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
          >
            {summary.isPending ? (
              <Skeleton className="h-6 w-8" />
            ) : (
              <span className="flex items-center gap-2">
                <Icon aria-hidden className={cn('size-4', alarm && 'text-destructive')} />
                <bdi className={cn('text-xl font-bold tabular-nums', alarm && 'text-destructive')}>
                  {value[k]}
                </bdi>
              </span>
            )}
            <span className="text-start text-sm font-medium text-muted-foreground">
              {t(`tiles.${k}`)}
            </span>
          </Toggle>
        );
      })}
    </nav>
  );
}
