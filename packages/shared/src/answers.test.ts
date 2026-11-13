import { describe, expect, it } from 'vitest';
import { parentHomeReportSchema } from './portal.js';
import { hifzCoverageSchema, progressQuerySchema, progressTimelineItemSchema } from './progress.js';
import {
  QURAN_AYAH_COUNT,
  QURAN_SURAHS,
  SURAH_COUNT,
  ayahCountOf,
  ayahsInRange,
  rangePieces,
  surahListSchema,
} from './quran.js';
import { hifzAyahs } from './reports.js';
import { teacherWeekQuerySchema } from './teacher-portal.js';

/**
 * The read side that had no direct test: the Quran reference and its range arithmetic (hifz
 * reports, progress and coverage are built on it), and the answers whose shape is a rule
 * (what a parent may receive) rather than plain data.
 */
describe('Quran reference (Hafs)', () => {
  it('has 114 surahs, 6,236 ayahs, numbered in order, juz starts 1 → 30 never going back', () => {
    expect(QURAN_SURAHS).toHaveLength(SURAH_COUNT);
    expect(QURAN_SURAHS.reduce((n, s) => n + s.ayahCount, 0)).toBe(QURAN_AYAH_COUNT);
    expect(QURAN_SURAHS.map((s) => s.number)).toEqual(
      Array.from({ length: SURAH_COUNT }, (_, i) => i + 1),
    );
    const juz = QURAN_SURAHS.map((s) => s.juzStart);
    expect(juz[0]).toBe(1);
    expect(juz.at(-1)).toBe(30);
    expect(juz.every((j, i) => i === 0 || j >= juz[i - 1]!)).toBe(true);
    // The answer of GET /quran/surahs is this list.
    expect(surahListSchema.parse(QURAN_SURAHS)).toHaveLength(SURAH_COUNT);
  });

  it('knows each surah length; 0 outside 1–114', () => {
    expect(ayahCountOf(1)).toBe(7);
    expect(ayahCountOf(2)).toBe(286);
    expect(ayahCountOf(114)).toBe(6);
    expect(ayahCountOf(0)).toBe(0);
    expect(ayahCountOf(115)).toBe(0);
  });

  it('counts a range inside one surah, forwards across surahs, and backwards (Juz Amma)', () => {
    expect(ayahsInRange({ surah: 2, ayah: 1 }, { surah: 2, ayah: 5 })).toBe(5);
    // A reversed range inside one surah covers nothing.
    expect(ayahsInRange({ surah: 2, ayah: 5 }, { surah: 2, ayah: 1 })).toBe(0);
    // Al-Fatihah 7 → Al-Baqarah 3: 1 + 3.
    expect(ayahsInRange({ surah: 1, ayah: 7 }, { surah: 2, ayah: 3 })).toBe(4);
    // An-Nas 1 → Al-Ikhlas 4, memorised backwards: An-Nas (6) + Al-Falaq (5) + Al-Ikhlas (4).
    expect(ayahsInRange({ surah: 114, ayah: 1 }, { surah: 112, ayah: 4 })).toBe(15);
    // The whole Quran.
    expect(ayahsInRange({ surah: 1, ayah: 1 }, { surah: 114, ayah: 6 })).toBe(QURAN_AYAH_COUNT);
    // A hifz row uses the same rule as the server.
    expect(hifzAyahs({ from: { surah: 78, ayah: 1 }, to: { surah: 78, ayah: 40 } })).toBe(40);
  });

  it('splits a range into per-surah pieces that add up to the same count', () => {
    const backwards = rangePieces({ surah: 114, ayah: 1 }, { surah: 112, ayah: 4 });
    expect(backwards).toEqual([
      { surah: 114, first: 1, last: 6 },
      { surah: 113, first: 1, last: 5 },
      { surah: 112, first: 1, last: 4 },
    ]);
    for (const [from, to] of [
      [
        { surah: 2, ayah: 250 },
        { surah: 4, ayah: 10 },
      ],
      [
        { surah: 114, ayah: 1 },
        { surah: 112, ayah: 4 },
      ],
      [
        { surah: 36, ayah: 10 },
        { surah: 36, ayah: 20 },
      ],
    ] as const) {
      const sum = rangePieces(from, to).reduce((n, p) => n + p.last - p.first + 1, 0);
      expect(sum, `${from.surah}:${from.ayah} → ${to.surah}:${to.ayah}`).toBe(
        ayahsInRange(from, to),
      );
    }
    // Inside one surah the piece is in reading order whichever end comes first.
    expect(rangePieces({ surah: 36, ayah: 20 }, { surah: 36, ayah: 10 })).toEqual([
      { surah: 36, first: 10, last: 20 },
    ]);
  });
});

const report = {
  sessionId: 11,
  reportId: 4,
  startsAt: '2026-11-10T16:00:00Z',
  teacher: { id: 2, name: 'Demo Teacher' },
  summary: 'Read the new ayahs with good tajweed.',
  homework: null,
  tajweedNotes: null,
  rating: 5,
  submittedAt: '2026-11-10T16:40:00Z',
  hifz: [
    {
      type: 'sabaq',
      from: { surah: 78, ayah: 1 },
      to: { surah: 78, ayah: 16 },
      ayahs: 16,
      pages: 1,
      grade: null,
      mistakes: 0,
      notes: null,
    },
  ],
};

describe('what a parent receives (parent home, B30)', () => {
  it('a report without the teacher-only fields parses', () => {
    expect(
      parentHomeReportSchema.parse({ ...report, student: { id: 3, name: 'Yusuf' } }),
    ).toMatchObject({ reportId: 4, student: { name: 'Yusuf' } });
  });

  it('refuses a report that carries teacher notes or the late flag (the API must strip them)', () => {
    const child = { ...report, student: { id: 3, name: 'Yusuf' } };
    expect(parentHomeReportSchema.safeParse({ ...child, teacherNotes: 'private' }).success).toBe(
      false,
    );
    expect(parentHomeReportSchema.safeParse({ ...child, late: true }).success).toBe(false);
  });

  it('staff timeline rows keep both', () => {
    expect(
      progressTimelineItemSchema.parse({ ...report, teacherNotes: 'private', late: false }),
    ).toMatchObject({ teacherNotes: 'private', late: false });
  });
});

describe('progress and the teacher portal: queries and coverage', () => {
  it('progress filters by a known hifz type and UTC instants', () => {
    expect(
      progressQuerySchema.parse({ type: 'manzil', from: '2026-11-01T00:00:00+02:00' }),
    ).toEqual({ type: 'manzil', from: '2026-10-31T22:00:00Z' });
    expect(progressQuerySchema.safeParse({ type: 'revision' }).success).toBe(false);
  });

  it('the teacher week takes a date (any day of it), not an instant', () => {
    expect(teacherWeekQuerySchema.parse({ date: '2026-11-12' })).toEqual({ date: '2026-11-12' });
    expect(teacherWeekQuerySchema.safeParse({ date: '2026-11-12T10:00:00Z' }).success).toBe(false);
  });

  it('coverage carries totals and per-surah rows', () => {
    const coverage = {
      memorisedAyahs: 40,
      totalAyahs: QURAN_AYAH_COUNT,
      percent: 0.64,
      completeSurahs: 1,
      surahs: [{ number: 78, memorisedAyahs: 40, ayahCount: 40, complete: true }],
    };
    expect(hifzCoverageSchema.parse(coverage)).toEqual(coverage);
    expect(hifzCoverageSchema.safeParse({ ...coverage, surahs: undefined }).success).toBe(false);
  });
});
