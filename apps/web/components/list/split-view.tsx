'use client';

import { Card } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { cn } from '@qarabic/ui/lib/utils';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useMediaQuery } from '@/hooks/use-persisted-state';
import { useListParams } from '@/lib/list-params';

/**
 * Set when a record view is shown inside the split view's detail pane (D141 §1). `PageHeader`
 * reads it: the record's title becomes an h2 (the list keeps the page's h1), the back arrow becomes
 * «إغلاق» (back to the full list) and «فتح في صفحة كاملة» links to the record's own page.
 */
export type RecordPane = { onClose: () => void; fullHref: string };
const RecordPaneContext = createContext<RecordPane | null>(null);
export const useRecordPane = () => useContext(RecordPaneContext);

/** The split view needs room for both panes: from `lg` (1024 px). Phones and tablets: full page. */
export const SPLIT_VIEW_QUERY = '(min-width: 1024px)';

/**
 * Split-view state for a list at `basePath` (D141 §1): the open record is `?id=` in the URL (with
 * the list's filters kept), so a link, Back and reload restore it. Below `lg` a row opens the
 * record's own page, as before.
 */
export function useSplitView(basePath: string) {
  const params = useListParams();
  const search = useSearchParams();
  const wide = useMediaQuery(SPLIT_VIEW_QUERY);
  const raw = params.get('id');
  const selectedId = /^\d+$/.test(raw) ? raw : null;
  const hrefFor = (id: string | number) => {
    if (!wide) return `${basePath}/${id}`;
    const next = new URLSearchParams(search.toString());
    next.set('id', String(id));
    return `${basePath}?${next.toString()}`;
  };
  return {
    wide,
    selectedId,
    hrefFor,
    fullHref: selectedId ? `${basePath}/${selectedId}` : '',
    close: () => params.set({ id: null }, { resetPage: false }),
  };
}

/**
 * Master–detail layout (D141 §1, Zoho's split view): the narrowed list at the inline-start, the
 * open record beside it. On narrow screens with a record open, only the record shows (its
 * «إغلاق» returns to the list). Focus moves to the record when it changes.
 */
export function SplitView({
  selectedId,
  wide,
  list,
  detail,
  detailLabel,
  onClose,
  fullHref,
}: {
  selectedId: string;
  wide: boolean;
  list: ReactNode;
  detail: ReactNode;
  /** Accessible name of the detail region, e.g. «تفاصيل العميل». */
  detailLabel: string;
  onClose: () => void;
  fullHref: string;
}) {
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    detailRef.current?.focus({ preventScroll: true });
  }, [selectedId]);
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
      {wide && <div className="min-w-0 lg:sticky lg:top-20">{list}</div>}
      <section
        ref={detailRef}
        tabIndex={-1}
        aria-label={detailLabel}
        className="@container flex min-w-0 flex-col gap-4 outline-none"
      >
        <RecordPaneContext.Provider value={{ onClose, fullHref }}>
          {detail}
        </RecordPaneContext.Provider>
      </section>
    </div>
  );
}

/**
 * The narrowed list in the split view: one link per row (name + status + one line), the open one
 * marked `aria-current`, scrolling inside its own card.
 */
export function SplitList<T>({
  rows,
  loading,
  label,
  emptyText,
  getRowId,
  hrefFor,
  selectedId,
  renderItem,
  header,
  footer,
}: {
  rows: T[];
  loading?: boolean;
  label: string;
  emptyText: string;
  getRowId: (row: T) => string | number;
  hrefFor: (id: string | number) => string;
  selectedId: string | null;
  renderItem: (row: T) => ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="gap-0 overflow-hidden py-0 shadow-none">
      {header}
      <div className="max-h-[calc(100svh-14rem)] overflow-y-auto">
        {loading ? (
          <div className="flex flex-col gap-2 p-3" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="p-6 text-center text-muted-foreground">{emptyText}</p>
        ) : (
          <ul aria-label={label} className="divide-y">
            {rows.map((row) => {
              const id = String(getRowId(row));
              const current = id === selectedId;
              return (
                <li key={id}>
                  <Link
                    href={hrefFor(id)}
                    scroll={false}
                    aria-current={current ? 'true' : undefined}
                    className={cn(
                      'block px-4 py-3 outline-none hover:bg-subtle focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset',
                      'aria-[current=true]:bg-accent aria-[current=true]:text-accent-foreground',
                    )}
                  >
                    {renderItem(row)}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {footer}
    </Card>
  );
}
