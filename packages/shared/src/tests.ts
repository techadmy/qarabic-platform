import { z } from 'zod';
import { dateOnlySchema, paginatedSchema } from './people.js';
import { instantSchema, personZoneRefSchema } from './schedule.js';

/**
 * Student tests (N3; Laravel M3 part 2, docs/27, D113–D120): `/api/v1/tests…`. A test is not a
 * class: a student, an examiner teacher and a UTC instant (shown in both zones, D30). Scores are
 * the old system's percentages (D115). Row scope (D118): staff all; a teacher the tests they
 * examine and their students' tests (acting only on the ones they examine); a parent their
 * children's, without cancelled ones, internal notes or the teacher rating. Out of scope = 404.
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

const id = z.number().int().positive();
const queryId = z.coerce.number().int().positive().max(2_147_483_647);

// ------------------------------------------------------------------ catalog (docs/27 §3)

export const TEST_STATUSES = ['scheduled', 'taken', 'refused', 'cancelled'] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];
export const TEST_STATUS_LABELS: Labels<TestStatus> = {
  scheduled: { ar: 'مجدول', en: 'Scheduled' },
  taken: { ar: 'منجز', en: 'Taken' },
  refused: { ar: 'مرفوض أو غياب', en: 'Refused or absent' },
  cancelled: { ar: 'ملغى', en: 'Cancelled' },
};

/** Old `dept_id` 1 Qaida, 2 Nazra, 3 Hifz. */
export const TEST_TRACKS = ['qaida', 'nazra', 'hifz'] as const;
export type TestTrack = (typeof TEST_TRACKS)[number];
export const TEST_TRACK_LABELS: Labels<TestTrack> = {
  qaida: { ar: 'القاعدة', en: 'Qaida' },
  nazra: { ar: 'التلاوة نظرًا', en: 'Reading (Nazra)' },
  hifz: { ar: 'الحفظ', en: 'Memorisation (Hifz)' },
};
export const needsReading = (track: TestTrack) => track !== 'qaida';
export const needsHifz = (track: TestTrack) => track === 'hifz';

/** Tajweed sections, weights and mistake codes: the old `test_results` module, same codes. */
export const TEST_SECTIONS = [
  { key: 'makharij', weight: 6, mistakes: [1, 2, 3, 4, 5, 6] },
  { key: 'noon_sakin', weight: 6, mistakes: [7, 8, 9, 10, 11, 12] },
  { key: 'meem_sakin', weight: 3, mistakes: [13, 14, 15] },
  { key: 'qalqala', weight: 3, mistakes: [16, 17, 18] },
  { key: 'ghunna', weight: 3, mistakes: [19, 20, 21] },
  { key: 'madd', weight: 5, mistakes: [22, 23, 24, 25, 26] },
] as const;
export type TestSection = (typeof TEST_SECTIONS)[number]['key'];
export const TEST_SECTION_KEYS = TEST_SECTIONS.map((s) => s.key) as [TestSection, ...TestSection[]];
export const TEST_SECTION_LABELS: Labels<TestSection> = {
  makharij: { ar: 'مخارج الحروف', en: 'Makharij (articulation)' },
  noon_sakin: { ar: 'النون الساكنة والتنوين', en: 'Noon Sakin & Tanween' },
  meem_sakin: { ar: 'الميم الساكنة', en: 'Meem Sakin' },
  qalqala: { ar: 'القلقلة', en: 'Qalqalah' },
  ghunna: { ar: 'الغنة', en: 'Ghunnah' },
  madd: { ar: 'المد', en: 'Madd' },
};

/** The 26 mistake codes, in words (parents read them). */
export const TEST_MISTAKE_LABELS: Record<number, { ar: string; en: string }> = {
  1: { ar: 'نطق الحروف غير سليم', en: 'Pronunciation of letters is not good' },
  2: { ar: 'يخلط بين الهاء والحاء', en: 'Confuses Haa and Hhaa' },
  3: { ar: 'يخلط بين الهمزة والعين', en: 'Confuses Hamza and Ain' },
  4: {
    ar: 'لا يفخّم حروف الاستعلاء كما ينبغي',
    en: 'Does not pronounce the heavy letters properly',
  },
  5: { ar: 'يخلط بين الثاء والسين', en: 'Confuses Thaa and Seen' },
  6: {
    ar: 'لا يُخرج الذال والظاء من مخرجيهما',
    en: 'Does not read Dhaal and Dhaa from their articulation points',
  },
  7: { ar: 'لم يحفظ الإظهار', en: 'Izhar not memorised' },
  8: { ar: 'لم يحفظ الإدغام', en: 'Idgham not memorised' },
  9: { ar: 'لا يعرف الإخفاء', en: 'Does not know Ikhfa' },
  10: { ar: 'لم يحفظ الإقلاب', en: 'Iqlab not memorised' },
  11: {
    ar: 'يحفظ أحكام النون الساكنة والتنوين ولا يطبقها',
    en: 'Memorised but cannot apply Noon Sakin & Tanween',
  },
  12: {
    ar: 'يطبق أحكام النون الساكنة والتنوين ولا يحفظها',
    en: 'Applies but has not memorised Noon Sakin & Tanween',
  },
  13: { ar: 'يحفظ أحكام الميم الساكنة ولا يطبقها', en: 'Memorised but cannot apply Meem Sakin' },
  14: { ar: 'يطبق أحكام الميم الساكنة ولا يحفظها', en: 'Applies but has not memorised Meem Sakin' },
  15: { ar: 'لا يعرف أحكام الميم الساكنة', en: 'No idea about Meem Sakin' },
  16: { ar: 'يحفظ القلقلة ولا يطبقها', en: 'Memorised but cannot apply Qalqalah' },
  17: { ar: 'يطبق القلقلة ولا يحفظها', en: 'Applies but has not memorised Qalqalah' },
  18: { ar: 'لا يعرف القلقلة', en: 'No idea about Qalqalah' },
  19: { ar: 'لا يؤدي الغنة كما ينبغي', en: 'Ghunnah not done properly' },
  20: { ar: 'يهمل الغنة أحيانًا', en: 'Sometimes ignores Ghunnah' },
  21: { ar: 'لا يعرف الغنة', en: 'No idea about Ghunnah' },
  22: { ar: 'لا يمد حروف المد', en: 'Does not stretch the Madd letters' },
  23: { ar: 'يمد الحركات القصيرة', en: 'Stretches the short vowels' },
  24: { ar: 'لا يمد المد بمقداره الصحيح', en: 'Does not stretch Madd properly' },
  25: {
    ar: 'يعرف حروف المد ولا يقرأ بها',
    en: 'Knows the Madd letters but does not read accordingly',
  },
  26: { ar: 'لا يعرف المد وأحكامه', en: 'No idea about Madd' },
};

/** Reading and memorisation are one choice each. */
export const TEST_SCORE_OPTIONS = [0, 25, 50, 75, 100] as const;
export const TEST_DURATIONS = [15, 20, 30, 45, 60] as const;
/** A result can be recorded from this many minutes before the scheduled time (D116). */
export const TEST_RECORD_LEAD_MINUTES = 30;

/** Section keys in catalog order, duplicates dropped. */
export function orderedSections(sections: readonly string[]): TestSection[] {
  return TEST_SECTION_KEYS.filter((k) => sections.includes(k));
}

/** Mistake codes that belong to the given sections. */
export function allowedMistakes(sections: readonly string[]): number[] {
  return TEST_SECTIONS.filter((s) => sections.includes(s.key)).flatMap((s) => [...s.mistakes]);
}

/** `round(max(0, Σw − mistakes) / Σw × 100)` over the selected sections (D115). */
export function tajweedScore(sections: readonly string[], mistakes: readonly number[]): number {
  const weight = TEST_SECTIONS.filter((s) => sections.includes(s.key)).reduce(
    (a, s) => a + s.weight,
    0,
  );
  if (!weight) return 0;
  const allowed = new Set(allowedMistakes(sections));
  const count = new Set(mistakes.filter((m) => allowed.has(m))).size;
  return Math.round((Math.max(0, weight - count) / weight) * 100);
}

/** The mean of the track's scores: qaida = tajweed; nazra + reading; hifz + reading + hifz. */
export function overallScore(
  track: TestTrack,
  tajweed: number,
  reading?: number | null,
  hifz?: number | null,
): number {
  const parts = [tajweed];
  if (needsReading(track)) parts.push(reading ?? 0);
  if (needsHifz(track)) parts.push(hifz ?? 0);
  return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
}

/** Refusal codes with their messages (Laravel `lang/{en,ar}/tests.php`). */
export const TEST_ERROR_MESSAGES = {
  no_examiner: {
    ar: 'لا يوجد معلم لهذا الطالب بعد. اختر الممتحِن.',
    en: 'This student has no teacher yet. Choose the examiner.',
  },
  test_already_scheduled: {
    ar: 'لدى هذا الطالب اختبار مجدول بالفعل في هذا المسار.',
    en: 'This student already has a scheduled test for this course.',
  },
  test_not_started: {
    ar: 'يمكن تسجيل النتيجة بدءًا من ثلاثين دقيقة قبل موعد الاختبار.',
    en: 'The result can be recorded from 30 minutes before the test time.',
  },
  edit_window_closed: {
    ar: 'انتهت مدة تعديل هذه النتيجة. اطلب التصحيح من المشرف.',
    en: 'The time to edit this result has passed. Ask a supervisor to correct it.',
  },
  reason_required: { ar: 'أدخل سبب التصحيح.', en: 'Enter the reason for the correction.' },
  mistake_outside_sections: {
    ar: 'أحد الأخطاء المحددة يتبع قسمًا غير مشمول في هذا الاختبار.',
    en: 'A selected mistake belongs to a section that is not part of this test.',
  },
  invalid_test_status: {
    ar: 'تغيّرت حالة هذا الاختبار. أعد تحميل الصفحة وحاول مرة أخرى.',
    en: 'The status of this test has changed. Reload and try again.',
  },
} as const;
export type TestErrorCode = keyof typeof TEST_ERROR_MESSAGES;

// ------------------------------------------------------------------ inputs

const sectionsSchema = z.array(z.enum(TEST_SECTION_KEYS)).min(1).max(6);
const durationSchema = z
  .number()
  .int()
  .refine((v) => (TEST_DURATIONS as readonly number[]).includes(v), {
    message: `Use one of ${TEST_DURATIONS.join(', ')} minutes.`,
  });
const optionalNotes = z
  .preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(2000).nullable(),
  )
  .optional();

/**
 * `POST /tests` (`tests.manage` | `tests.conduct`): a teacher schedules for their own students and
 * is the examiner; staff may pick another examiner (default: the student's current teacher).
 * `scheduledAt` may not be more than a day in the past.
 */
export const createTestSchema = z.object({
  studentId: id,
  track: z.enum(TEST_TRACKS),
  sections: sectionsSchema,
  scheduledAt: instantSchema,
  durationMinutes: durationSchema.optional(),
  teacherId: id.optional(),
  notes: optionalNotes,
});
export type CreateTestInput = z.input<typeof createTestSchema>;

/** `PATCH /tests/:id` while scheduled: the examiner moves it; only staff change the examiner. */
export const updateTestSchema = z.object({
  sections: sectionsSchema.optional(),
  scheduledAt: instantSchema.optional(),
  durationMinutes: durationSchema.optional(),
  teacherId: id.optional(),
  notes: optionalNotes,
});
export type UpdateTestInput = z.input<typeof updateTestSchema>;

const scoreSchema = z
  .number()
  .int()
  .refine((v) => (TEST_SCORE_OPTIONS as readonly number[]).includes(v), {
    message: `Use one of ${TEST_SCORE_OPTIONS.join(', ')}.`,
  });

/**
 * `PUT /tests/:id/result` (the examiner or staff). `readingScore` is required for nazra and hifz
 * and refused for qaida; `hifzScore` only for hifz (the server checks it against the test's track
 * after the scope check). A correction of a recorded result: the examiner inside
 * `sessions.report_edit_hours`, staff always with a `reason`. `teacherRating` is kept from staff only.
 */
export const recordTestResultSchema = z.object({
  mistakes: z
    .array(z.number().int().min(1).max(26))
    .max(26)
    .refine((m) => new Set(m).size === m.length, { message: 'A mistake is listed twice.' }),
  readingScore: scoreSchema.nullable().optional(),
  hifzScore: scoreSchema.nullable().optional(),
  remarks: optionalNotes,
  internalNotes: optionalNotes,
  teacherRating: z.number().int().min(0).max(100).nullable().optional(),
  reason: z.string().trim().min(3).max(500).optional(),
});
export type RecordTestResultInput = z.input<typeof recordTestResultSchema>;

/** Refuse, cancel and reopen always need a reason (D31, D117). */
export const testReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export type TestReasonInput = z.input<typeof testReasonSchema>;

/** `YYYY-MM` (academy zone, D119). */
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM.');

export const testListQuerySchema = z.object({
  status: z
    .preprocess(
      (v) => (typeof v === 'string' ? v.split(',') : v),
      z.array(z.enum(TEST_STATUSES)).max(4),
    )
    .optional(),
  month: monthSchema.optional(),
  from: instantSchema.optional(),
  to: instantSchema.optional(),
  /** Tests on this academy-local date. */
  date: dateOnlySchema.optional(),
  teacherId: queryId.optional(),
  studentId: queryId.optional(),
  track: z.enum(TEST_TRACKS).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});
export type TestListQuery = z.input<typeof testListQuerySchema>;

export const testSummaryQuerySchema = z.object({ month: monthSchema });

// ------------------------------------------------------------------ outputs

export const testResultSchema = z.object({
  tajweed: z.number().int(),
  reading: z.number().int().nullable(),
  hifz: z.number().int().nullable(),
  overall: z.number().int(),
  mistakes: z.array(z.number().int()),
  remarks: z.string().nullable(),
  recordedAt: z.string().nullable(),
  /** Staff and teachers only. */
  internalNotes: z.string().nullable().optional(),
  /** Staff only (B67). */
  teacherRating: z.number().int().nullable().optional(),
  /** Until when the examiner may correct it (staff and teachers only). */
  editableUntil: z.string().nullable().optional(),
});
export type TestResultDto = z.infer<typeof testResultSchema>;

export const testSchema = z.object({
  id: z.number().int(),
  status: z.enum(TEST_STATUSES),
  statusReason: z.string().nullable(),
  track: z.enum(TEST_TRACKS),
  sections: z.array(z.enum(TEST_SECTION_KEYS)),
  scheduledAt: z.string(),
  durationMinutes: z.number().int(),
  /** The academy-zone month of `scheduledAt` (D119). */
  month: z.string(),
  student: personZoneRefSchema,
  teacher: personZoneRefSchema,
  course: z.object({ id: z.number().int(), nameAr: z.string(), nameEn: z.string() }).nullable(),
  notes: z.string().nullable(),
  /** Null until taken. */
  result: testResultSchema.nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
  /** What the viewer may do now. */
  can: z.object({
    update: z.boolean(),
    record: z.boolean(),
    editResult: z.boolean(),
    refuse: z.boolean(),
    cancel: z.boolean(),
    reopen: z.boolean(),
    setExaminer: z.boolean(),
  }),
});
export type TestDto = z.infer<typeof testSchema>;

/** `meta.counts` = tests per status (`all` + each) for the same filters minus `status`. */
export const testListResponseSchema = paginatedSchema(testSchema);

const summaryCountsSchema = z.object({
  /** Every test of the month except cancelled ones. */
  created: z.number().int(),
  taken: z.number().int(),
  remaining: z.number().int(),
  refused: z.number().int(),
  cancelled: z.number().int(),
});

/** `GET /tests/summary?month=` (staff and teachers; parents 403): the month tiles (D119). */
export const testSummarySchema = z.object({
  month: z.string(),
  counts: summaryCountsSchema,
  byTeacher: z.array(
    summaryCountsSchema.extend({
      teacher: z.object({ id: z.number().int(), name: z.string() }),
    }),
  ),
});
export type TestSummaryDto = z.infer<typeof testSummarySchema>;

export const TEST_SUMMARY_LABELS = {
  created: { ar: 'المُنشأة', en: 'Created' },
  taken: { ar: 'المنجزة', en: 'Taken' },
  remaining: { ar: 'المتبقية', en: 'Remaining' },
  refused: { ar: 'المرفوضة', en: 'Refused' },
  cancelled: { ar: 'الملغاة', en: 'Cancelled' },
} as const;
