import type { AccountType, LedgerAccountDto } from '@qarabic/shared';

/** Depth of each account in its tree (0 = a top heading), for the indentation. */
export function depths(accounts: LedgerAccountDto[]): Map<number, number> {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out = new Map<number, number>();
  const depth = (a: LedgerAccountDto, guard = 0): number => {
    if (out.has(a.id)) return out.get(a.id)!;
    const parent = a.parentId ? byId.get(a.parentId) : undefined;
    const d = parent && guard < 10 ? depth(parent, guard + 1) + 1 : 0;
    out.set(a.id, d);
    return d;
  };
  accounts.forEach((a) => depth(a));
  return out;
}

/**
 * The chart's filters: archived or active, one type, and a search that matches a code prefix, the
 * Arabic name or the English name (case-insensitive).
 */
export function filterAccounts(
  accounts: LedgerAccountDto[],
  { q, type, archived }: { q: string; type?: AccountType; archived: boolean },
): LedgerAccountDto[] {
  const raw = q.trim();
  const needle = raw.toLowerCase();
  return accounts
    .filter((a) => a.isActive !== archived)
    .filter((a) => !type || a.type === type)
    .filter(
      (a) =>
        !needle ||
        a.code.startsWith(needle) ||
        a.nameAr.includes(raw) ||
        a.nameEn.toLowerCase().includes(needle),
    );
}
