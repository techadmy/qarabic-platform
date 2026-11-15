import type { SessionDto } from '@qarabic/shared';
import { describe, expect, it } from 'vitest';
import { applyFilters, orderRows, rowTone } from './board';

const row = (id: number, startsAt: string, extra: Partial<SessionDto> = {}) =>
  ({
    id,
    startsAt,
    stage: 'scheduled',
    stageReason: null,
    kind: 'regular',
    attention: [],
    pendingRequests: [],
    course: { id: 1, nameAr: 'قرآن', nameEn: 'Quran' },
    student: { id: 1, name: 'A' },
    teacher: { id: 1, name: 'T' },
    ...extra,
  }) as unknown as SessionDto;

describe('board order and look (D148, docs/42 §2)', () => {
  it('orders by start time only: a late class keeps its place; «الآن» before the next start', () => {
    const now = new Date('2026-11-15T13:10:00Z');
    const { rows, nowIndex } = orderRows(
      [
        row(3, '2026-11-15T13:30:00Z'),
        row(2, '2026-11-15T13:00:00Z', { attention: ['late'] }),
        row(1, '2026-11-15T12:30:00Z', { stage: 'in_progress' }),
        row(4, '2026-11-15T15:00:00Z'),
      ],
      now,
    );
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(nowIndex).toBe(2);
    expect(orderRows([row(1, '2026-11-15T09:00:00Z')], now).nowIndex).toBe(1);
    expect(orderRows([], now).nowIndex).toBe(-1);
  });

  it('tints a row by its state; a problem wins over the stage', () => {
    expect(rowTone(row(1, 'x', { attention: ['late'] }))).toBe('urgent');
    expect(rowTone(row(1, 'x', { attention: ['zoom_failed'] }))).toBe('urgent');
    expect(rowTone(row(1, 'x', { stage: 'ended', attention: ['report_missing'] }))).toBe(
      'attention',
    );
    expect(rowTone(row(1, 'x', { stage: 'in_progress' }))).toBe('running');
    expect(rowTone(row(1, 'x', { stage: 'taken' }))).toBe('done');
    expect(rowTone(row(1, 'x', { stage: 'cancelled' }))).toBe('off');
    expect(rowTone(row(1, 'x'))).toBe('plain');
  });

  it('filters by course, kind, state and problems only', () => {
    const all = [
      row(1, 'a', { kind: 'trial' }),
      row(2, 'b', { course: { id: 2, nameAr: 'عربي', nameEn: 'Arabic' } }),
      row(3, 'c', { attention: ['needs_entry'] }),
      row(4, 'd', { stage: 'taken' }),
    ];
    const base = { tile: null, teacher: null, stage: null, q: '' };
    const ids = (f: object) => applyFilters(all, { ...base, ...f }).map((r) => r.id);
    expect(ids({ kind: 'trial' })).toEqual([1]);
    expect(ids({ course: 2 })).toEqual([2]);
    expect(ids({ problems: true })).toEqual([3]);
    expect(ids({ stage: 'taken' })).toEqual([4]);
  });
});
