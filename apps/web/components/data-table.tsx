'use client';

import { Skeleton } from '@qarabic/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { cn } from '@qarabic/ui/lib/utils';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table';
import { useRouter } from 'next/navigation';
import type { MouseEvent } from 'react';
import { ColumnChooser } from '@/components/list/column-chooser';

/** Per-column layout hints, read by `DataTable` (shadcn's documented `meta` extension point). */
export type ColumnMeta = {
  className?: string;
  numeric?: boolean;
  /** Name in the column chooser when the header is not plain text. */
  label?: string;
};

/**
 * `DataTable` from the shadcn Data Table guide (ui.shadcn.com/docs/components/data-table):
 * TanStack Table driving the shadcn `Table` component. Server pagination, search and status tabs
 * live around it (`ListToolbar`, `ListPagination`), so every list keeps one table.
 * Looks like the current app's tables: a white card with a hairline border and 10px corners, a
 * light-grey header row with 13px semibold grey labels, compact rows, tabular figures.
 * `getRowHref`: the row opens the record (docs/15 §5.3); the name cell stays a real link and row
 * actions stay real buttons, so the keyboard never depends on the row click.
 * `columnVisibility`: adds the column chooser in the header's inline-start cell (D141 §3); keep the
 * state with `useColumnVisibility('<table>:<user id>')`.
 * `selectedRowId` marks the record open in the split view (D141 §1).
 */
export function DataTable<TData, TValue>({
  columns,
  data,
  label,
  emptyText,
  loading,
  getRowHref,
  bare,
  columnVisibility,
  onColumnVisibilityChange,
  getRowId,
  selectedRowId,
}: {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  label: string;
  emptyText: string;
  loading?: boolean;
  getRowHref?: (row: TData) => string;
  /** Inside a card that already has the border (list pages). */
  bare?: boolean;
  columnVisibility?: VisibilityState;
  onColumnVisibilityChange?: (next: VisibilityState) => void;
  getRowId?: (row: TData) => string;
  selectedRowId?: string | null;
}) {
  const router = useRouter();
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table, as in the shadcn guide
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
    state: columnVisibility ? { columnVisibility } : undefined,
    onColumnVisibilityChange: onColumnVisibilityChange
      ? (updater) =>
          onColumnVisibilityChange(
            typeof updater === 'function' ? updater(columnVisibility ?? {}) : updater,
          )
      : undefined,
  });
  const chooser = !!columnVisibility && !!onColumnVisibilityChange;
  const span = table.getVisibleLeafColumns().length + (chooser ? 1 : 0);

  function onRowClick(event: MouseEvent<HTMLTableRowElement>, row: TData) {
    if (!getRowHref) return;
    // Links, buttons and menus inside the row keep their own behaviour.
    if ((event.target as HTMLElement).closest('a,button,[role="menuitem"],input,label')) return;
    router.push(getRowHref(row));
  }

  return (
    <div className={cn('overflow-x-auto', !bare && 'rounded-xl border bg-card')}>
      <Table aria-label={label} aria-busy={loading || undefined} className="tabular-nums">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className="bg-subtle hover:bg-subtle">
              {chooser && (
                <TableHead className="h-10 w-10 ps-2 pe-0">
                  <ColumnChooser table={table} />
                </TableHead>
              )}
              {headerGroup.headers.map((header) => {
                const meta = header.column.columnDef.meta as ColumnMeta | undefined;
                return (
                  <TableHead
                    key={header.id}
                    className={cn(
                      'h-10 px-3 text-[0.8125rem] font-semibold text-muted-foreground',
                      meta?.numeric && 'text-end',
                      meta?.className,
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {loading ? (
            Array.from({ length: 8 }, (_, i) => (
              <TableRow key={i} className="hover:bg-transparent">
                {Array.from({ length: span }, (_c, j) => (
                  <TableCell key={j} className="h-12 px-3">
                    <Skeleton className="h-4 w-full max-w-40" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                aria-current={selectedRowId === row.id ? 'true' : undefined}
                className={cn(
                  'hover:bg-subtle aria-[current=true]:bg-accent',
                  getRowHref && 'cursor-pointer',
                )}
                onClick={(event) => onRowClick(event, row.original)}
              >
                {chooser && <TableCell className="w-10" />}
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta as ColumnMeta | undefined;
                  return (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        'h-12 px-3 py-1.5',
                        meta?.numeric && 'text-end',
                        meta?.className,
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={span} className="h-24 text-center">
                {emptyText}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
