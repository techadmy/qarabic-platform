import { describe, expect, it } from 'vitest';
import {
  allowedMistakes,
  ayahCountOf,
  ayahsInRange,
  createTestSchema,
  HIFZ_GRADE_LABELS,
  HIFZ_GRADES,
  HIFZ_TYPE_LABELS,
  HIFZ_TYPES,
  hifzEntryInputSchema,
  lessonReportInputSchema,
  orderedSections,
  overallScore,
  QURAN_AYAH_COUNT,
  QURAN_SURAHS,
  rangePieces,
  recordTestResultSchema,
  REPORT_STATE_LABELS,
  REPORT_STATES,
  tajweedScore,
  TEST_MISTAKE_LABELS,
  TEST_SECTION_LABELS,
  TEST_SECTIONS,
  TEST_STATUS_LABELS,
  TEST_STATUSES,
  TEST_TRACK_LABELS,
  TEST_TRACKS,
  testListQuerySchema,
} from './index.js';

describe('Quran reference', () => {
  it('has the 114 surahs of the Hafs numbering, 6,236 ayahs', () => {
    expect(QURAN_SURAHS).toHaveLength(114);
    expect(QURAN_SURAHS.map((s) => s.number)).toEqual(Array.from({ length: 114 }, (_, i) => i + 1));
    expect(QURAN_SURAHS.reduce((n, s) => n + s.ayahCount, 0)).toBe(QURAN_AYAH_COUNT);
    expect(QURAN_SURAHS[1]).toEqual({
      number: 2,
      nameAr: 'البقرة',
      nameEn: 'Al-Baqarah',
      ayahCount: 286,
      juzStart: 1,
    });
    expect(ayahCountOf(114)).toBe(6);
    expect(ayahCountOf(115)).toBe(0);
  });

  it('counts ayahs across surahs in both directions (ProgressController::ayahs)', () => {
    const p = (surah: number, ayah: number) => ({ surah, ayah });
    expect(ayahsInRange(p(78, 1), p(78, 16))).toBe(16);
    expect(ayahsInRange(p(114, 1), p(112, 4))).toBe(6 + 5 + 4);
    expect(ayahsInRange(p(112, 1), p(114, 6))).toBe(4 + 5 + 6);
    expect(rangePieces(p(114, 2), p(112, 3))).toEqual([
      { surah: 114, first: 2, last: 6 },
      { surah: 113, first: 1, last: 5 },
      { surah: 112, first: 1, last: 3 },
    ]);
  });
});

describe('lesson report input', () => {
  it('checks ayah bounds and order like LessonReportRequest', () => {
    const entry = (from: [number, number], to: [number, number]) => ({
      type: 'sabaq',
      from: { surah: from[0], ayah: from[1] },
      to: { surah: to[0], ayah: to[1] },
    });
    expect(hifzEntryInputSchema.safeParse(entry([1, 1], [1, 7])).success).toBe(true);
    expect(hifzEntryInputSchema.safeParse(entry([114, 1], [112, 4])).success).toBe(true);
    const over = hifzEntryInputSchema.safeParse(entry([1, 1], [1, 8]));
    expect(over.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['to.ayah', 'This surah has 7 ayahs.'],
    ]);
    const back = hifzEntryInputSchema.safeParse(entry([78, 10], [78, 5]));
    expect(back.error?.issues[0]?.path).toEqual(['to', 'ayah']);
    expect(hifzEntryInputSchema.safeParse(entry([0, 1], [1, 1])).success).toBe(false);
  });

  it('requires a summary, a 1–5 rating and at most 10 hifz rows; blank text clears', () => {
    expect(lessonReportInputSchema.safeParse({ summary: '  ' }).success).toBe(false);
    expect(lessonReportInputSchema.safeParse({ summary: 'ok', rating: 0 }).success).toBe(false);
    const ok = lessonReportInputSchema.parse({ summary: ' ok ', homework: ' ', rating: 5 });
    expect(ok).toMatchObject({ summary: 'ok', homework: null, rating: 5 });
    const many = Array.from({ length: 11 }, () => ({
      type: 'sabaq',
      from: { surah: 1, ayah: 1 },
      to: { surah: 1, ayah: 1 },
    }));
    expect(lessonReportInputSchema.safeParse({ summary: 'ok', hifz: many }).success).toBe(false);
  });
});

describe('test scoring (D115)', () => {
  it('keeps the old weights and mistake codes 1–26', () => {
    expect(TEST_SECTIONS.reduce((n, s) => n + s.weight, 0)).toBe(26);
    expect(TEST_SECTIONS.flatMap((s) => s.mistakes)).toEqual(
      Array.from({ length: 26 }, (_, i) => i + 1),
    );
    expect(allowedMistakes(['madd'])).toEqual([22, 23, 24, 25, 26]);
    expect(orderedSections(['madd', 'makharij', 'madd'])).toEqual(['makharij', 'madd']);
  });

  it('computes tajweed and overall like the server tests', () => {
    const all = TEST_SECTIONS.map((s) => s.key);
    expect(tajweedScore(all, [1, 7, 26])).toBe(88);
    expect(overallScore('hifz', 88, 75, 50)).toBe(71);
    expect(tajweedScore(['makharij', 'madd'], [2, 22])).toBe(82);
    // A mistake outside the sections does not count (the server refuses it).
    expect(tajweedScore(['makharij'], [1, 13])).toBe(83);
    expect(overallScore('nazra', 100, 25)).toBe(63);
    expect(overallScore('qaida', 82)).toBe(82);
    expect(tajweedScore([], [])).toBe(0);
  });

  it('validates the test inputs', () => {
    const base = {
      studentId: 1,
      track: 'hifz',
      sections: ['madd'],
      scheduledAt: '2026-11-12T16:00:00+02:00',
    };
    expect(createTestSchema.parse(base).scheduledAt).toBe('2026-11-12T14:00:00Z');
    expect(createTestSchema.safeParse({ ...base, durationMinutes: 25 }).success).toBe(false);
    expect(createTestSchema.safeParse({ ...base, sections: [] }).success).toBe(false);
    expect(recordTestResultSchema.safeParse({ mistakes: [1, 1] }).success).toBe(false);
    expect(recordTestResultSchema.safeParse({ mistakes: [27] }).success).toBe(false);
    expect(recordTestResultSchema.safeParse({ mistakes: [], readingScore: 60 }).success).toBe(
      false,
    );
    expect(testListQuerySchema.parse({ status: 'scheduled,taken' }).status).toEqual([
      'scheduled',
      'taken',
    ]);
    expect(testListQuerySchema.safeParse({ month: '2026-13' }).success).toBe(false);
  });
});

describe('labels', () => {
  it('has an Arabic and an English label for every N3 value', () => {
    const cases: Array<[readonly string[], Record<string, { ar: string; en: string }>]> = [
      [HIFZ_TYPES, HIFZ_TYPE_LABELS],
      [HIFZ_GRADES, HIFZ_GRADE_LABELS],
      [REPORT_STATES, REPORT_STATE_LABELS],
      [TEST_STATUSES, TEST_STATUS_LABELS],
      [TEST_TRACKS, TEST_TRACK_LABELS],
      [TEST_SECTIONS.map((s) => s.key), TEST_SECTION_LABELS],
    ];
    for (const [values, labels] of cases) {
      expect(Object.keys(labels).sort()).toEqual([...values].sort());
      for (const v of values) {
        expect(labels[v]!.ar).toMatch(/[؀-ۿ]/);
        expect(labels[v]!.en.length).toBeGreaterThan(1);
      }
    }
    expect(Object.keys(TEST_MISTAKE_LABELS)).toHaveLength(26);
  });
});
