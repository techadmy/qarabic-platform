'use client';

import { Card } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { useIsMobile } from '@qarabic/ui/hooks/use-mobile';
import type { ColumnDef } from '@tanstack/react-table';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { DataTable } from '@/components/data-table';

/**
 * Table on tablet/desktop, one compact shadcn `Card` per row on phones (< 768 px), like the current
 * app's mobile lists (docs/15 §5.3): no horizontal scrolling, the whole card opens the record.
 */
export function ResponsiveList<T>({
  columns,
  rows,
  loading,
  label,
  emptyText,
  getRowId,
  getRowHref,
  renderCard,
}: {
  columns: ColumnDef<T, unknown>[];
  rows: T[];
  loading?: boolean;
  label: string;
  emptyText: string;
  getRowId: (row: T) => string | number;
  getRowHref?: (row: T) => string;
  renderCard: (row: T) => ReactNode;
}) {
  const isMobile = useIsMobile();
  if (!isMobile) {
    return (
      <DataTable
        bare
        columns={columns}
        data={rows}
        label={label}
        emptyText={emptyText}
        loading={loading}
        getRowHref={getRowHref}
      />
    );
  }
  if (loading) {
    return (
      <div className="flex flex-col gap-3 p-3" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (!rows.length) {
    return <p className="p-6 text-center text-muted-foreground">{emptyText}</p>;
  }
  return (
    <ul aria-label={label} className="flex flex-col gap-3 p-3">
      {rows.map((row) => {
        const href = getRowHref?.(row);
        return (
          <li key={getRowId(row)}>
            <Card className="gap-0 py-0 shadow-none">
              {href ? (
                <Link
                  href={href}
                  className="block rounded-xl p-4 outline-none hover:bg-subtle focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {renderCard(row)}
                </Link>
              ) : (
                <div className="p-4">{renderCard(row)}</div>
              )}
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
