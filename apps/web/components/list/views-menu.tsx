'use client';

import { Button } from '@qarabic/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import { ChevronDownIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useDirection } from '@/lib/use-direction';

export type ViewOption = {
  value: string;
  label: string;
  count?: number;
  /** A short alert after the view, e.g. «متأخرة: 2» on a support queue. */
  hint?: string;
};

/** More than this many statuses → a views menu on the title instead of tabs (D141 §2). */
export const MAX_STATUS_TABS = 5;

/**
 * The views menu on the page title (D141 §2, Zoho's «All Invoices ▾»): the list's title, then the
 * current view as a shadcn `DropdownMenu` trigger with the other views and their counts. Used when
 * a list has more than {@link MAX_STATUS_TABS} statuses; with fewer, keep `StatusTabs`.
 * Render it as the `PageHeader` title (it sits inside the h1).
 */
export function ViewsMenu({
  title,
  label,
  value,
  options,
  onChange,
}: {
  /** The list's name, e.g. «العملاء المحتملون». */
  title: string;
  /** What the views filter, e.g. «تصفية حسب الحالة» (menu label). */
  label: string;
  value: string;
  options: ViewOption[];
  onChange: (value: string) => void;
}) {
  const t = useTranslations('list');
  const dir = useDirection();
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      <span>{title}</span>
      <DropdownMenu dir={dir}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto gap-1 px-2 py-0.5 text-2xl font-bold text-primary"
          >
            <span>{current?.label}</span>
            {current?.count !== undefined && (
              <span className="text-lg font-semibold text-muted-foreground tabular-nums">
                (<bdi>{current.count}</bdi>)
              </span>
            )}
            {current?.hint && (
              <span className="text-sm font-semibold text-destructive">{current.hint}</span>
            )}
            <span className="sr-only">{t('viewsChange')}</span>
            <ChevronDownIcon aria-hidden className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
            {options.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value} className="gap-4">
                <span className="flex flex-col">
                  <span>{o.label}</span>
                  {o.hint && <span className="text-caption text-destructive">{o.hint}</span>}
                </span>
                {o.count !== undefined && (
                  <span className="ms-auto text-muted-foreground tabular-nums">
                    <bdi>{o.count}</bdi>
                  </span>
                )}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
