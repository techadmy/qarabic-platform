'use client';

import { BOARD_COUNTER_LABELS, type BoardCounter, type SessionDto } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Toggle } from '@qarabic/ui/components/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@qarabic/ui/components/tooltip';
import { cn } from '@qarabic/ui/lib/utils';
import { ChevronDownIcon, ListChecksIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Fragment, useId } from 'react';
import { useUiLocale } from '@/components/sessions/times';
import {
  ATTENTION_TILES,
  PRIMARY_TILES,
  STATUS_TILES,
  tileCount,
  type BoardTile,
} from '@/lib/sessions/board';

/** Number colour of a tile when it is above zero (the old dashboard's hues, D35). */
const TILE_TEXT: Partial<Record<BoardTile, string>> = {
  taken: 'text-emerald-700 dark:text-emerald-400',
  running: 'text-amber-700 dark:text-amber-400',
  needs_action: 'text-orange-700 dark:text-orange-400',
  late: 'text-orange-700 dark:text-orange-400',
  absent: 'text-red-700 dark:text-red-400',
  leave: 'text-violet-700 dark:text-violet-400',
  declined: 'text-sky-700 dark:text-sky-400',
  suspended: 'text-rose-800 dark:text-rose-400',
  trial: 'text-amber-800 dark:text-amber-400',
  advance: 'text-indigo-700 dark:text-indigo-400',
  rescheduled: 'text-teal-700 dark:text-teal-400',
  extra: 'text-emerald-700 dark:text-emerald-400',
};

/**
 * Today's status tiles (docs/15 §3.1 K1–K2; the current app's `BoardTiles`): one row with the five
 * tiles a monitor watches, «كل الحالات» revealing the other old statuses, and one attention bar
 * with the follow-ups above zero. Every tile is a shadcn `Toggle` (`aria-pressed`) that filters
 * the rows; keys 1–5 pick the main tiles.
 */
export function BoardTiles({
  counters,
  rows,
  selected,
  onSelect,
  loading,
  showAll,
  onToggleAll,
  reportsHref,
}: {
  counters: Partial<Record<BoardCounter, number>> | undefined;
  rows: SessionDto[];
  selected: BoardTile | null;
  onSelect: (tile: BoardTile | null) => void;
  loading?: boolean;
  showAll: boolean;
  onToggleAll: () => void;
  /** «بلا تقرير» also links to every class without a report (`/lesson-reports?state=missing`). */
  reportsHref?: string;
}) {
  const t = useTranslations('today');
  const locale = useUiLocale();
  const statusesId = useId();
  const value = (k: BoardTile) => tileCount(k, counters, rows);
  const label = (k: BoardTile) =>
    k === 'needs_action'
      ? t('tiles.needsAction')
      : k === 'running'
        ? t('tiles.runningNow')
        : BOARD_COUNTER_LABELS[k][locale];
  const breakdown = STATUS_TILES.filter((k) => value(k) > 0)
    .map((k) => `${label(k)}: ${value(k)}`)
    .join(' · ');
  const attention = ATTENTION_TILES.filter((k) => value(k) > 0);

  const tile = (key: BoardTile, small: boolean, index?: number) => {
    const n = value(key);
    const active = selected === key;
    const toggle = (
      <Toggle
        key={key}
        variant="outline"
        pressed={active}
        onPressedChange={(on) => onSelect(on ? key : null)}
        aria-keyshortcuts={index !== undefined ? String(index + 1) : undefined}
        className={cn(
          'shrink-0 justify-start gap-2 bg-card px-3 data-[state=on]:border-primary data-[state=on]:bg-accent data-[state=on]:text-accent-foreground',
          small ? 'h-9' : 'h-12',
        )}
      >
        {loading ? (
          <Skeleton className="h-5 w-6" />
        ) : (
          <span
            className={cn(
              'font-bold tabular-nums',
              small ? 'text-base' : 'text-xl',
              n > 0 && key !== 'total' && key !== 'remaining' && TILE_TEXT[key],
            )}
          >
            <bdi>{n}</bdi>
          </span>
        )}
        <span className="text-sm font-medium text-muted-foreground">{label(key)}</span>
      </Toggle>
    );
    return key === 'total' && breakdown ? (
      <Tooltip key={key}>
        <TooltipTrigger asChild>{toggle}</TooltipTrigger>
        <TooltipContent>{breakdown}</TooltipContent>
      </Tooltip>
    ) : (
      toggle
    );
  };

  return (
    <nav aria-label={t('tiles.label')} className="flex flex-col gap-2">
      <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1 lg:flex-wrap lg:overflow-visible">
        {PRIMARY_TILES.map((k, i) => tile(k, false, i))}
        <Button
          variant="ghost"
          className="h-10 shrink-0 text-primary"
          aria-expanded={showAll}
          aria-controls={statusesId}
          onClick={onToggleAll}
        >
          {showAll ? t('tiles.hideStatuses') : t('tiles.allStatuses')}
          <ChevronDownIcon className={cn('transition-transform', showAll && 'rotate-180')} />
        </Button>
        {attention.length > 0 && (
          <div
            role="group"
            aria-label={t('tiles.attention')}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-warning-border bg-warning px-2 py-1 text-warning-foreground lg:ms-auto"
          >
            <TriangleAlertIcon aria-hidden className="size-4" />
            <span className="text-sm font-semibold whitespace-nowrap">{t('tiles.attention')}:</span>
            {attention.map((k) => (
              <Fragment key={k}>
                <Toggle
                  size="sm"
                  pressed={selected === k}
                  onPressedChange={(on) => onSelect(on ? k : null)}
                  className="h-8 text-sm hover:bg-warning-hover data-[state=on]:bg-warning-active data-[state=on]:underline"
                >
                  <bdi className="font-bold">{value(k)}</bdi> {label(k)}
                </Toggle>
                {k === 'ended' && reportsHref && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        asChild
                        variant="ghost"
                        size="icon-sm"
                        className="hover:bg-warning-hover"
                      >
                        <Link href={reportsHref} aria-label={t('tiles.allMissingReports')}>
                          <ListChecksIcon />
                        </Link>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{t('tiles.allMissingReports')}</TooltipContent>
                  </Tooltip>
                )}
              </Fragment>
            ))}
          </div>
        )}
      </div>
      {showAll && (
        <div
          id={statusesId}
          role="group"
          aria-label={t('tiles.allStatuses')}
          className="flex flex-wrap gap-2"
        >
          {STATUS_TILES.map((k) => tile(k, true))}
        </div>
      )}
    </nav>
  );
}
