import type { LedgerAccountDto } from '@qarabic/shared';
import { describe, expect, it } from 'vitest';
import { depths, filterAccounts } from './tree';

const acc = (
  id: number,
  code: string,
  parentId: number | null,
  p: Partial<LedgerAccountDto> = {},
) =>
  ({
    id,
    code,
    parentId,
    nameAr: `حساب ${code}`,
    nameEn: `Account ${code}`,
    type: 'asset',
    isGroup: false,
    isCash: false,
    currency: null,
    systemKey: null,
    isActive: true,
    description: null,
    ...p,
  }) as LedgerAccountDto;

const chart = [
  acc(1, '1', null, { isGroup: true }),
  acc(2, '11', 1, { isGroup: true }),
  acc(3, '1120', 2, { nameAr: 'البنك', nameEn: 'Bank' }),
  acc(4, '5150', null, { type: 'expense', nameAr: 'الإنترنت', nameEn: 'Internet' }),
  acc(5, '1530', 1, { isActive: false, nameEn: 'Goodwill' }),
];

describe('chart of accounts', () => {
  it('depth follows the parents', () => {
    const d = depths(chart);
    expect([d.get(1), d.get(2), d.get(3), d.get(4)]).toEqual([0, 1, 2, 0]);
  });

  it('search: code prefix, Arabic name, English name in any case', () => {
    const codes = (q: string) => filterAccounts(chart, { q, archived: false }).map((a) => a.code);
    expect(codes('11')).toEqual(['11', '1120']);
    expect(codes('البنك')).toEqual(['1120']);
    expect(codes('INTER')).toEqual(['5150']);
  });

  it('type and archived filters', () => {
    expect(
      filterAccounts(chart, { q: '', type: 'expense', archived: false }).map((a) => a.id),
    ).toEqual([4]);
    expect(filterAccounts(chart, { q: '', archived: true }).map((a) => a.id)).toEqual([5]);
  });
});
