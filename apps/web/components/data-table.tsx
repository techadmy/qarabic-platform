'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';

/**
 * `DataTable` from the shadcn Data Table guide (ui.shadcn.com/docs/components/data-table):
 * TanStack Table driving the shadcn `Table` component. Sorting, filters and pagination are added
 * here when a list needs them (docs/15 §5.4.1), so every list keeps one table.
 * Looks like the current app's tables: a white card with a hairline border and 10px corners, a
 * light-grey header row with 13px semibold grey labels, compact 40px rows, tabular figures.
 */
export function DataTable<TData, TValue>({
  columns,
  data,
  label,
  emptyText,
}: {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  label: string;
  emptyText: string;
}) {
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table, as in the shadcn guide
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Table aria-label={label} className="tabular-nums">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className="bg-subtle hover:bg-subtle">
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className="h-10 px-3 text-[0.8125rem] font-semibold text-muted-foreground"
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} className="hover:bg-subtle">
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="h-10 px-3 py-1.5">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center">
                {emptyText}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
