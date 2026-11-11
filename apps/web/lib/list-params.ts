'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

export const PER_PAGE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PER_PAGE = 25;
const SEARCH_DEBOUNCE_MS = 300;

type Updates = Record<string, string | number | null | undefined>;

/**
 * List state in the URL (docs/15 §5.1, §5.4.1): `q` (instant search, debounced 300 ms), `status`,
 * `archived`, `page`, `perPage`, `sort`, `order` and each list's filters. Search or filter changes
 * go back to page 1; Back restores the previous state. Defaults are left out of the URL.
 */
export function useListParams() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const search = params.toString();

  const get = useCallback((key: string) => params.get(key) ?? '', [params]);
  const q = get('q');

  const set = useCallback(
    (updates: Updates, { resetPage = true }: { resetPage?: boolean } = {}) => {
      const next = new URLSearchParams(search);
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === undefined || value === '') next.delete(key);
        else next.set(key, String(value));
      }
      if (resetPage && !('page' in updates)) next.delete('page');
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [search, pathname, router],
  );

  // The search box updates at once; the URL (and the request) 300 ms after the last key.
  const [searchInput, setSearchInput] = useState(q);
  const [lastQ, setLastQ] = useState(q);
  if (q !== lastQ) {
    // The URL changed from outside the box (Back, «مسح الكل»): follow it.
    setLastQ(q);
    setSearchInput(q);
  }
  useEffect(() => {
    if (searchInput.trim() === q) return;
    const timer = setTimeout(() => set({ q: searchInput.trim() || null }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput, q, set]);

  const pageNumber = Math.max(1, Number.parseInt(get('page'), 10) || 1);
  const perPageRaw = Number.parseInt(get('perPage'), 10);
  const perPage = (PER_PAGE_OPTIONS as readonly number[]).includes(perPageRaw)
    ? perPageRaw
    : DEFAULT_PER_PAGE;
  const archived = get('archived') === '1';

  return useMemo(
    () => ({
      get,
      set,
      q,
      searchInput,
      setSearchInput,
      page: pageNumber,
      perPage,
      archived,
      /** Number of active filters other than search and status (for «مسح الكل»). */
      clear: (keys: string[]) =>
        set(Object.fromEntries([...keys, 'q', 'status'].map((k) => [k, null]))),
    }),
    [get, set, q, searchInput, pageNumber, perPage, archived],
  );
}

export type ListParams = ReturnType<typeof useListParams>;
