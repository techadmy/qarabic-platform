import { TableHead } from '@qarabic/ui/components/table';
import { cn } from '@qarabic/ui/lib/utils';
import type { ReactNode } from 'react';

/**
 * Header cells of a report table: `th` with a scope, and the first column kept in place while the
 * rest scrolls sideways on a phone.
 */
export const STICKY_COL = 'sticky start-0 z-10 bg-card';

export function Col({ children, end }: { children: ReactNode; end?: boolean }) {
  return (
    <TableHead scope="col" className={cn(end ? 'text-end' : STICKY_COL)}>
      {children}
    </TableHead>
  );
}

export function RowHead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <TableHead scope="row" className={cn('font-medium', STICKY_COL, className)}>
      {children}
    </TableHead>
  );
}
