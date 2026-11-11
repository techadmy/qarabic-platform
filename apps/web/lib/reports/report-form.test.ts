import { describe, expect, it } from 'vitest';
import {
  continueFromLast,
  emptyRow,
  initialValues,
  isBlankRow,
  serverKeyToPath,
  toReportInput,
  validateReport,
  type ReportFormValues,
} from './report-form';
import { rangeText } from './format';

const base = (): ReportFormValues => ({ ...initialValues(null), summary: 'Good lesson.' });
const withRow = (row: Partial<ReportFormValues['hifz'][number]>, i = 0) => {
  const v = base();
  v.hifz[i] = { ...v.hifz[i]!, ...row };
  return v;
};

describe('lesson report form', () => {
  it('needs the summary; blank hifz rows are skipped', () => {
    const v = initialValues(null);
    expect(v.hifz.map((r) => r.type)).toEqual(['sabaq', 'sabaqi', 'manzil']);
    expect(v.hifz.every(isBlankRow)).toBe(true);
    expect(validateReport(v)).toEqual([{ path: 'summary', key: 'summaryRequired' }]);
    expect(validateReport(base())).toEqual([]);
    expect(toReportInput(base()).input.hifz).toEqual([]);
  });

  it('checks each ayah against its surah (shared Quran data)', () => {
    // An-Naba has 40 ayahs.
    expect(
      validateReport(withRow({ fromSurah: 78, fromAyah: 1, toSurah: 78, toAyah: 41 })),
    ).toEqual([{ path: 'hifz.0.toAyah', key: 'ayahRange', values: { max: 40 } }]);
    expect(validateReport(withRow({ fromSurah: 78, fromAyah: 0, toSurah: 78, toAyah: 5 }))).toEqual(
      [{ path: 'hifz.0.fromAyah', key: 'ayahRange', values: { max: 40 } }],
    );
    // A filled row needs both ends.
    expect(validateReport(withRow({ fromSurah: 78, fromAyah: 1 }))).toEqual([
      { path: 'hifz.0.toSurah', key: 'surahRequired' },
    ]);
    expect(validateReport(withRow({ grade: 'good' }, 2))).toEqual([
      { path: 'hifz.2.fromSurah', key: 'surahRequired' },
      { path: 'hifz.2.toSurah', key: 'surahRequired' },
    ]);
  });

  it('keeps one surah in order but allows any direction across surahs', () => {
    expect(
      validateReport(withRow({ fromSurah: 78, fromAyah: 20, toSurah: 78, toAyah: 10 })),
    ).toEqual([expect.objectContaining({ path: 'hifz.0.toAyah', key: 'ayahOrder' })]);
    // Juz Amma backwards: An-Nas 1 → Al-Falaq 5.
    const v = withRow({ fromSurah: 114, fromAyah: 1, toSurah: 113, toAyah: 5 });
    expect(validateReport(v)).toEqual([]);
    expect(rangeText({ from: { surah: 114, ayah: 1 }, to: { surah: 113, ayah: 5 } }, 'ar')).toBe(
      'الناس 1 – الفلق 5',
    );
  });

  it('accepts quarter pages only and sends the row in API shape', () => {
    const row = { fromSurah: 78, fromAyah: 1, toSurah: 78, toAyah: 16, mistakes: 2 };
    expect(validateReport(withRow({ ...row, pages: 0.3 }))).toEqual([
      { path: 'hifz.0.pages', key: 'pages' },
    ]);
    const v = withRow({ ...row, pages: 0.75, grade: 'very_good' }, 1);
    const { input, rowIndex } = toReportInput(v, 'ended');
    expect(rowIndex).toEqual([1]);
    expect(input).toMatchObject({
      expectedStage: 'ended',
      summary: 'Good lesson.',
      homework: null,
      hifz: [
        {
          type: 'sabaqi',
          from: { surah: 78, ayah: 1 },
          to: { surah: 78, ayah: 16 },
          pages: 0.75,
          grade: 'very_good',
          mistakes: 2,
        },
      ],
    });
  });

  it('maps server errors back to the form row and continues from the last position', () => {
    expect(serverKeyToPath('hifz.0.to.ayah', [2])).toBe('hifz.2.toAyah');
    expect(serverKeyToPath('hifz.0.pages', [1])).toBe('hifz.1.pages');
    expect(serverKeyToPath('summary', [])).toBe('summary');
    expect(serverKeyToPath('lessonId', [])).toBeNull();
    const last = [
      {
        ...emptyRow('sabaq'),
        type: 'sabaq' as const,
        from: { surah: 78, ayah: 31 },
        to: { surah: 78, ayah: 40 },
        ayahs: 10,
        pages: null,
        grade: null,
        mistakes: null,
        notes: null,
        sessionId: 1,
        date: '2026-11-01T10:00:00Z',
      },
    ];
    // An-Naba is finished: the next surah, from its first ayah.
    expect(continueFromLast('sabaq', last)).toMatchObject({
      fromSurah: 79,
      fromAyah: 1,
      toSurah: 79,
    });
  });
});
