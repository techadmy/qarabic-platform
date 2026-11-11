import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/auth.types.js';
import type { StudentTest } from '../generated/prisma/client.js';
import { coverage } from './progress.service.js';
import { monthRange, testCan } from './tests.service.js';

const range = (fs: number, fa: number, ts: number, ta: number, grade: string | null = null) =>
  ({ fromSurah: fs, fromAyah: fa, toSurah: ts, toAyah: ta, grade }) as Parameters<
    typeof coverage
  >[0][number];

describe('hifz coverage', () => {
  it('unions overlapping ranges, in either direction, and skips not_memorised rows', () => {
    const c = coverage([
      range(114, 1, 112, 4),
      range(113, 2, 113, 4),
      range(78, 1, 78, 10),
      range(78, 5, 78, 12),
      range(2, 1, 2, 286, 'not_memorised'),
    ]);
    expect(c.memorisedAyahs).toBe(15 + 12);
    expect(c.completeSurahs).toBe(3);
    expect(c.surahs.map((s) => s.number)).toEqual([78, 112, 113, 114]);
    expect(c.percent).toBe(0.4);
  });

  it('is empty without reports', () => {
    expect(coverage([])).toEqual({
      memorisedAyahs: 0,
      totalAyahs: 6236,
      percent: 0,
      completeSurahs: 0,
      surahs: [],
    });
  });
});

describe('student tests', () => {
  it('cuts a month in the academy zone (D119)', () => {
    const [from, to] = monthRange('2026-12', 'Africa/Cairo');
    expect(from.toISOString()).toBe('2026-11-30T22:00:00.000Z');
    expect(to.toISOString()).toBe('2026-12-31T22:00:00.000Z');
  });

  const user = (kind: 'staff' | 'teacher', permissions: string[], teacherId: number | null) =>
    ({
      id: 9,
      role: { id: 1, name: kind, kind, labelAr: '', labelEn: null },
      permissions: new Set(permissions),
      teacherId,
    }) as unknown as AuthUser;
  const test = (o: Partial<StudentTest>) =>
    ({ status: 'scheduled', teacherId: 5, createdById: 1, ...o }) as StudentTest;

  it('lets staff and the examiner act; cancel only for what the examiner scheduled (policy)', () => {
    const staff = user('staff', ['tests.manage'], null);
    const examiner = user('teacher', ['tests.conduct'], 5);
    const other = user('teacher', ['tests.conduct'], 6);
    expect(testCan(staff, test({}), 'cancel')).toBe(true);
    expect(testCan(examiner, test({}), 'record')).toBe(true);
    expect(testCan(examiner, test({}), 'cancel')).toBe(false);
    expect(testCan(examiner, test({ createdById: 9 }), 'cancel')).toBe(true);
    expect(testCan(other, test({}), 'record')).toBe(false);
    expect(testCan(examiner, test({ status: 'taken' }), 'record')).toBe(true);
    expect(testCan(examiner, test({ status: 'refused' }), 'reopen')).toBe(false);
    expect(testCan(staff, test({ status: 'refused' }), 'reopen')).toBe(true);
  });
});
