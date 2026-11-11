import {
  ayahCountOf,
  HIFZ_TYPES,
  hifzEntryInputSchema,
  lessonReportInputSchema,
  SURAH_COUNT,
  type HifzEntryDto,
  type HifzGrade,
  type HifzType,
  type LastPositionDto,
  type LessonReportDto,
  type LessonReportInput,
} from '@qarabic/shared';

/**
 * The lesson report form (N3; the current app's `reportForm.ts`): three hifz rows (sabaq, sabaqi,
 * manzil; a blank row is skipped), the summary for the parent, tajweed notes, homework, the 1–5
 * rating and the internal note. Checks run on the shared `lessonReportInputSchema` (ayahs exist in
 * their surah, same-surah order) with message keys the UI translates (`reports.form.errors.*`).
 */

export interface HifzRowValues {
  type: HifzType;
  fromSurah: number | null;
  fromAyah: number | null;
  toSurah: number | null;
  toAyah: number | null;
  pages: number | null;
  grade: HifzGrade | null;
  mistakes: number | null;
  notes: string;
}

export interface ReportFormValues {
  summary: string;
  homework: string;
  tajweedNotes: string;
  teacherNotes: string;
  rating: number | null;
  hifz: HifzRowValues[];
}

export const emptyRow = (type: HifzType): HifzRowValues => ({
  type,
  fromSurah: null,
  fromAyah: null,
  toSurah: null,
  toAyah: null,
  pages: null,
  grade: null,
  mistakes: null,
  notes: '',
});

export function isBlankRow(r: HifzRowValues): boolean {
  return (
    r.fromSurah === null &&
    r.fromAyah === null &&
    r.toSurah === null &&
    r.toAyah === null &&
    r.pages === null &&
    r.grade === null &&
    r.mistakes === null &&
    !r.notes.trim()
  );
}

export function rowFromEntry(
  h: Pick<HifzEntryDto, 'type' | 'from' | 'to'> & Partial<HifzEntryDto>,
) {
  return {
    type: h.type,
    fromSurah: h.from.surah,
    fromAyah: h.from.ayah,
    toSurah: h.to.surah,
    toAyah: h.to.ayah,
    pages: h.pages ?? null,
    grade: h.grade ?? null,
    mistakes: h.mistakes ?? null,
    notes: h.notes ?? '',
  } satisfies HifzRowValues;
}

/** The saved report when editing, else three blank rows. */
export function initialValues(report: LessonReportDto | null): ReportFormValues {
  return {
    summary: report?.summary ?? '',
    homework: report?.homework ?? '',
    tajweedNotes: report?.tajweedNotes ?? '',
    teacherNotes: report?.teacherNotes ?? '',
    rating: report?.rating ?? null,
    hifz: HIFZ_TYPES.map((type) => {
      const saved = report?.hifz.find((h) => h.type === type);
      return saved ? rowFromEntry(saved) : emptyRow(type);
    }),
  };
}

/** «مثل المرة السابقة»: the last range of this type as is (grade and mistakes left blank). */
export function sameAsLast(type: HifzType, last: LastPositionDto[] | undefined) {
  const h = last?.find((x) => x.type === type);
  return h ? { ...rowFromEntry(h), grade: null, mistakes: null, notes: '', pages: null } : null;
}

/**
 * «تابع من آخر موضع» (sabaq): start right after the last end in the same surah; a finished surah
 * goes to the next one (down when the last range went down, as Juz Amma is often memorised).
 */
export function continueFromLast(
  type: HifzType,
  last: LastPositionDto[] | undefined,
): HifzRowValues | null {
  const h = last?.find((x) => x.type === type);
  if (!h) return null;
  const count = ayahCountOf(h.to.surah);
  const next =
    h.to.ayah < count
      ? { surah: h.to.surah, ayah: h.to.ayah + 1 }
      : { surah: h.from.surah > h.to.surah ? h.to.surah - 1 : h.to.surah + 1, ayah: 1 };
  if (next.surah < 1 || next.surah > SURAH_COUNT) return null;
  return { ...emptyRow(type), fromSurah: next.surah, fromAyah: next.ayah, toSurah: next.surah };
}

const text = (v: string) => (v.trim() ? v.trim() : null);

/** Form → API body. `rowIndex[i]` = the form row of `hifz[i]` (server errors map back with it). */
export function toReportInput(
  v: ReportFormValues,
  expectedStage?: 'ended' | 'taken',
): { input: LessonReportInput; rowIndex: number[] } {
  const rowIndex: number[] = [];
  const hifz: NonNullable<LessonReportInput['hifz']> = [];
  v.hifz.forEach((r, i) => {
    if (isBlankRow(r)) return;
    rowIndex.push(i);
    hifz.push({
      type: r.type,
      from: { surah: r.fromSurah ?? 0, ayah: r.fromAyah ?? 0 },
      to: { surah: r.toSurah ?? 0, ayah: r.toAyah ?? 0 },
      pages: r.pages,
      grade: r.grade,
      mistakes: r.mistakes,
      notes: text(r.notes),
    });
  });
  return {
    input: {
      ...(expectedStage ? { expectedStage } : {}),
      summary: v.summary.trim(),
      homework: text(v.homework),
      tajweedNotes: text(v.tajweedNotes),
      teacherNotes: text(v.teacherNotes),
      rating: v.rating,
      hifz,
    },
    rowIndex,
  };
}

/** A failed check: the form path and the message key with its values. */
export interface ReportFormError {
  path: string;
  key: string;
  values?: Record<string, number>;
}

const SIDES = [
  ['from', 'fromSurah', 'fromAyah'],
  ['to', 'toSurah', 'toAyah'],
] as const;

/** One row: both ends filled, ayahs inside their surah, same-surah order (the shared rule). */
function rowErrors(r: HifzRowValues, i: number): ReportFormError[] {
  if (isBlankRow(r)) return [];
  const out: ReportFormError[] = [];
  for (const [, surahKey, ayahKey] of SIDES) {
    const surah = r[surahKey];
    const ayah = r[ayahKey];
    if (surah === null) {
      out.push({ path: `hifz.${i}.${surahKey}`, key: 'surahRequired' });
      continue;
    }
    const max = ayahCountOf(surah);
    if (ayah === null) out.push({ path: `hifz.${i}.${ayahKey}`, key: 'ayahRequired' });
    else if (!Number.isInteger(ayah) || ayah < 1 || ayah > max) {
      out.push({ path: `hifz.${i}.${ayahKey}`, key: 'ayahRange', values: { max } });
    }
  }
  if (out.length) return out;
  const parsed = hifzEntryInputSchema.safeParse(
    toReportInput({ ...BLANK, hifz: [r] }).input.hifz![0],
  );
  if (parsed.success) return [];
  for (const issue of parsed.error.issues) {
    const [end, field] = issue.path.map(String);
    if ((end === 'from' || end === 'to') && field === 'ayah') {
      const sameSurah = r.fromSurah === r.toSurah && end === 'to';
      out.push({
        path: `hifz.${i}.${end}Ayah`,
        key: sameSurah ? 'ayahOrder' : 'ayahRange',
        values: { max: ayahCountOf(end === 'from' ? r.fromSurah! : r.toSurah!) },
      });
    } else if (end === 'pages') {
      out.push({ path: `hifz.${i}.pages`, key: 'pages' });
    } else if (end === 'mistakes') {
      out.push({ path: `hifz.${i}.mistakes`, key: 'mistakes' });
    } else {
      out.push({ path: `hifz.${i}.${end ?? 'type'}`, key: 'invalid' });
    }
  }
  return out;
}

const BLANK: ReportFormValues = {
  summary: '',
  homework: '',
  tajweedNotes: '',
  teacherNotes: '',
  rating: null,
  hifz: [],
};

/** Every failed check of the form, in screen order (the first one gets the focus). */
export function validateReport(v: ReportFormValues): ReportFormError[] {
  const out: ReportFormError[] = [];
  if (!v.summary.trim()) out.push({ path: 'summary', key: 'summaryRequired' });
  v.hifz.forEach((r, i) => out.push(...rowErrors(r, i)));
  if (out.length) return out;
  // Whatever else the shared schema refuses (lengths, rating), on its own field.
  const { input, rowIndex } = toReportInput(v);
  const parsed = lessonReportInputSchema.safeParse(input);
  if (parsed.success) return out;
  for (const issue of parsed.error.issues) {
    const path = serverKeyToPath(issue.path.map(String).join('.'), rowIndex);
    if (path) out.push({ path, key: issue.code === 'too_big' ? 'tooLong' : 'invalid' });
  }
  return out;
}

const FIELDS = ['summary', 'homework', 'tajweedNotes', 'teacherNotes', 'rating'];

/** Server field key (`hifz.0.from.ayah`) → form path (`hifz.2.fromAyah`). */
export function serverKeyToPath(key: string, rowIndex: number[]): string | null {
  const m = /^hifz\.(\d+)\.(from|to)\.(surah|ayah)$/.exec(key);
  if (m) {
    const row = rowIndex[Number(m[1])];
    if (row === undefined) return null;
    return `hifz.${row}.${m[2]}${m[3] === 'surah' ? 'Surah' : 'Ayah'}`;
  }
  const r = /^hifz\.(\d+)\.(pages|grade|mistakes|notes)$/.exec(key);
  if (r) {
    const row = rowIndex[Number(r[1])];
    return row === undefined ? null : `hifz.${row}.${r[2]}`;
  }
  return FIELDS.includes(key) ? key : null;
}
