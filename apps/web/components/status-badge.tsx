'use client';

import { Badge } from '@qarabic/ui/components/badge';
import { cn } from '@qarabic/ui/lib/utils';
import {
  CircleCheckIcon,
  CircleMinusIcon,
  CirclePauseIcon,
  InfoIcon,
  PlaneIcon,
  type LucideIcon,
} from 'lucide-react';
import { useLocale } from 'next-intl';
import type { PeopleKind } from '@/lib/api/people';
import { KINDS } from '@/lib/people/kinds';

/**
 * One status chip per domain (docs/15 §5.14): fixed colour + icon + label, never colour alone, the
 * English term in the tooltip. Same hues as the current app's chips (green regular/active, blue
 * trial, purple leave, red suspended, grey inactive). shadcn `Badge`, outline variant.
 */
const STYLES: Record<string, { icon: LucideIcon; className: string }> = {
  regular: {
    icon: CircleCheckIcon,
    className:
      'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  },
  active: {
    icon: CircleCheckIcon,
    className:
      'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  },
  trial: {
    icon: InfoIcon,
    className:
      'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300',
  },
  on_leave: {
    icon: PlaneIcon,
    className:
      'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300',
  },
  suspended: {
    icon: CirclePauseIcon,
    className:
      'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
  },
  deactivated: {
    icon: CircleMinusIcon,
    className: 'border-border bg-muted text-muted-foreground',
  },
  inactive: {
    icon: CircleMinusIcon,
    className: 'border-border bg-muted text-muted-foreground',
  },
};

export function StatusBadge({
  kind,
  status,
  className,
}: {
  kind: PeopleKind;
  status: string;
  className?: string;
}) {
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const label = KINDS[kind].labels[status];
  const style = STYLES[status] ?? STYLES.inactive!;
  const Icon = style.icon;
  return (
    <Badge
      variant="outline"
      title={label?.en}
      className={cn('h-6 rounded-md px-2 text-[0.8125rem] font-medium', style.className, className)}
    >
      <Icon aria-hidden />
      {label?.[locale] ?? status}
    </Badge>
  );
}
