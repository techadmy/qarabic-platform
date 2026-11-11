import type { PageMeta } from '@qarabic/shared';

/** `skip`/`take` for a page of a list. */
export function pageArgs(q: { page: number; perPage: number }): { skip: number; take: number } {
  return { skip: (q.page - 1) * q.perPage, take: q.perPage };
}

export function pageMeta(
  q: { page: number; perPage: number },
  total: number,
  counts: Record<string, number>,
): PageMeta {
  return {
    page: q.page,
    perPage: q.perPage,
    total,
    lastPage: Math.max(1, Math.ceil(total / q.perPage)),
    counts,
  };
}

/** `{ all, <status>: n, … }` from a `groupBy` on status; statuses with no rows count 0. */
export function statusCounts(
  statuses: readonly string[],
  rows: Array<{ status: string; _count: { _all: number } }>,
): Record<string, number> {
  const counts: Record<string, number> = { all: 0 };
  for (const s of statuses) counts[s] = 0;
  for (const row of rows) {
    counts[row.status] = row._count._all;
    counts.all! += row._count._all;
  }
  return counts;
}
