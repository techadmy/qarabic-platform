'use client';

import { Button } from '@qarabic/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import type { Table, VisibilityState } from '@tanstack/react-table';
import { Columns3Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePersistedState } from '@/hooks/use-persisted-state';
import { useDirection } from '@/lib/use-direction';

/**
 * Hidden columns of one table, saved per user in this browser (D141 §3). `key` = table + user,
 * e.g. `leads:12`. Only hidden columns are stored, so new columns show up by default.
 */
export function useColumnVisibility(key: string) {
  return usePersistedState<VisibilityState>(`qarabic.columns.${key}`, {});
}

/**
 * The column chooser (the shadcn Data Table "View" menu, D141 §3): an icon button in the table
 * header's inline-start cell; one checkbox per column that may be hidden. A column stays fixed with
 * `enableHiding: false` (the record name, the row checkbox). Its menu label is `meta.label`, else the
 * header when it is a string.
 */
export function ColumnChooser<T>({ table }: { table: Table<T> }) {
  const t = useTranslations('list');
  const dir = useDirection();
  const columns = table.getAllLeafColumns().filter((c) => c.getCanHide());
  const hidden = columns.filter((c) => !c.getIsVisible()).length;
  return (
    <DropdownMenu dir={dir}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('columns.trigger')}>
          <Columns3Icon />
          {hidden > 0 && <span className="sr-only">{t('columns.hidden', { count: hidden })}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuLabel>{t('columns.title')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {columns.map((c) => {
          const meta = c.columnDef.meta as { label?: string } | undefined;
          const header = c.columnDef.header;
          return (
            <DropdownMenuCheckboxItem
              key={c.id}
              checked={c.getIsVisible()}
              // Keep the menu open while picking several columns.
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(v) => c.toggleVisibility(!!v)}
            >
              {meta?.label ?? (typeof header === 'string' ? header : c.id)}
            </DropdownMenuCheckboxItem>
          );
        })}
        {hidden > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => table.resetColumnVisibility(true)}>
              {t('columns.showAll')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
