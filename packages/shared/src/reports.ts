import { z } from 'zod';
import { instantSchema } from './schedule.js';
import { paginatedSchema, personRefSchema } from './people.js';
import { ayahCountOf, ayahsInRange, SURAH_COUNT } from './quran.js';
import { sessionEventSchema, sessionRequestSummarySchema, sessionSchema } from './sessions.js';

/**
 * Lesson reports (N3): `PUT/GET /api/v1/sessions/:id/report` and the staff list
 * `GET /api/v1/lesson-reports`. Ported from the Laravel M3 report (D45, D70, D72; docs/14 §2.11):
 * writing the report of an `ended` class moves it to `taken`; the teacher may edit it for
 * `sessions.report_edit_hours` (48 h, B29), staff with `sessions.manage` at any time. Parents
 * read it without the internal note; they see the rating unless `reports.parent_sees_rating` is
 * off (B30).
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

/** Clears on `""` or `null` (Laravel ConvertEmptyStringsToNull). */
const optionalText = (max: number) =>
  z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
      z.string().trim().max(max).nullable(),
    )
    .optional();

// ------------------------------------------------------------------ enums + labels

/** sabaq = the new lesson, sabaqi = recent revision, manzil = old revision. */
export const HIFZ_TYPES = ['sabaq', 'sabaqi', 'manzil'] as const;
export type HifzType = (typeof HIFZ_TYPES)[number];
export const HIFZ_TYPE_LABELS: Labels<HifzType> = {
  sabaq: { ar: 'الدرس الجديد (سبق)', en: 'Sabaq (new)' },
  sabaqi: { ar: 'المراجعة القريبة (سبقي)', en: 'Sabaqi (recent revision)' },
  manzil: { ar: 'المراجعة البعيدة (منزل)', en: 'Manzil (old revision)' },
};

export const HIFZ_GRADES = [
  'excellent',
  'very_good',
  'good',
  'needs_work',
  'not_memorised',
] as const;
export type HifzGrade = (typeof HIFZ_GRADES)[number];
export const HIFZ_GRADE_LABELS: Labels<HifzGrade> = {
  excellent: { ar: 'ممتاز', en: 'Excellent' },
  very_good: { ar: 'جيد جدًا', en: 'Very good' },
  good: { ar: 'جيد', en: 'Good' },
  needs_work: { ar: 'يحتاج إلى مراجعة', en: 'Needs work' },
  not_memorised: { ar: 'لم يحفظ', en: 'Not memorised' },
};

/**
 * Where a class stands on its report: `pending` (ended, not due yet), `missing` (past due,
 * «بلا تقرير» — the board's `report_missing`), `on_time`, `late` (sent after the due time).
 */
export const REPORT_STATES = ['pending', 'missing', 'on_time', 'late'] as const;
export type ReportState = (typeof REPORT_STATES)[number];
export const REPORT_STATE_LABELS: Labels<ReportState> = {
  pending: { ar: 'بانتظار التقرير', en: 'Awaiting report' },
  missing: { ar: 'بلا تقرير', en: 'Report missing' },
  on_time: { ar: 'سُلّم في موعده', en: 'On time' },
  late: { ar: 'سُلّم متأخرًا', en: 'Late' },
};

/** Field labels of the report form (docs/15 §9 glossary: فصحى). */
export const REPORT_FIELD_LABELS = {
  title: { ar: 'تقرير الحصة', en: 'Lesson report' },
  summary: { ar: 'ملخص الحصة', en: 'Summary' },
  summaryHint: {
    ar: 'ما الذي أُنجز في الحصة؟ (يطّلع عليه ولي الأمر)',
    en: 'What was done in class? (the parent sees this)',
  },
  homework: { ar: 'الواجب', en: 'Homework' },
  tajweedNotes: { ar: 'ملاحظات التجويد', en: 'Tajweed notes' },
  teacherNotes: { ar: 'ملاحظات داخلية', en: 'Internal notes' },
  teacherNotesHint: {
    ar: 'للإدارة فقط، ولا يطّلع عليها ولي الأمر',
    en: 'Staff only; parents do not see this',
  },
  rating: { ar: 'تقييم الحصة', en: 'Class rating' },
  hifz: { ar: 'الحفظ', en: 'Hifz' },
  surah: { ar: 'السورة', en: 'Surah' },
  ayah: { ar: 'الآية', en: 'Ayah' },
  from: { ar: 'من', en: 'From' },
  to: { ar: 'إلى', en: 'To' },
  pages: { ar: 'الصفحات', en: 'Pages' },
  grade: { ar: 'التقدير', en: 'Grade' },
  mistakes: { ar: 'الأخطاء', en: 'Mistakes' },
  notes: { ar: 'ملاحظات', en: 'Notes' },
  submit: { ar: 'حفظ التقرير', en: 'Save report' },
  editLocked: {
    ar: 'انتهت مدة تعديل التقرير. تواصل مع المتابعة.',
    en: 'The edit time has passed. Contact the monitors.',
  },
} as const;

/** Refusals of the report endpoint (besides 422 `validation_failed` and 403 / 404). */
export const REPORT_ERROR_CODES = [
  'invalid_transition',
  'outside_window',
  'stale_session',
] as const;

// ------------------------------------------------------------------ hifz

export const ayahPointSchema = z.object({
  surah: z.number().int().min(1).max(SURAH_COUNT),
  ayah: z.number().int().min(1),
});
export type AyahPoint = z.infer<typeof ayahPointSchema>;

/**
 * One hifz row. Ayahs must exist in their surah; inside one surah `from ≤ to`; across surahs any
 * direction (Juz Amma is often memorised backwards, An-Nas → An-Naba). Errors are on
 * `hifz.<i>.from.ayah` / `hifz.<i>.to.ayah` like Laravel.
 */
export const hifzEntryInputSchema = z
  .object({
    type: z.enum(HIFZ_TYPES),
    from: ayahPointSchema,
    to: ayahPointSchema,
    /** Mushaf pages (quarter pages), optional. */
    pages: z
      .number()
      .min(0)
      .max(604)
      .refine((v) => Number.isInteger(v * 4), { message: 'Use quarter pages.' })
      .nullable()
      .optional(),
    grade: z.enum(HIFZ_GRADES).nullable().optional(),
    mistakes: z.number().int().min(0).max(999).nullable().optional(),
    notes: optionalText(500),
  })
  .superRefine((e, ctx) => {
    for (const end of ['from', 'to'] as const) {
      const max = ayahCountOf(e[end].surah);
      if (max && e[end].ayah > max) {
        ctx.addIssue({
          code: 'custom',
          path: [end, 'ayah'],
          message: `This surah has ${max} ayahs.`,
        });
      }
    }
    if (e.from.surah === e.to.surah && e.from.ayah > e.to.ayah) {
      ctx.addIssue({
        code: 'custom',
        path: ['to', 'ayah'],
        message: 'Within one surah the last ayah must come after the first.',
      });
    }
  });
export type HifzEntryInput = z.input<typeof hifzEntryInputSchema>;

export const hifzEntrySchema = z.object({
  type: z.enum(HIFZ_TYPES),
  from: ayahPointSchema,
  to: ayahPointSchema,
  /** Ayahs covered (computed). */
  ayahs: z.number().int(),
  pages: z.number().nullable(),
  grade: z.enum(HIFZ_GRADES).nullable(),
  mistakes: z.number().int().nullable(),
  notes: z.string().nullable(),
});
export type HifzEntryDto = z.infer<typeof hifzEntrySchema>;

/** Ayahs of a hifz row (same rule as the server). */
export const hifzAyahs = (e: { from: AyahPoint; to: AyahPoint }) => ayahsInRange(e.from, e.to);

// ------------------------------------------------------------------ report

/**
 * `PUT /sessions/:id/report` (`sessions.conduct` own class · `sessions.manage`). On an `ended` class
 * it moves the class to `taken`; on a `taken` class it edits the report (teacher inside the edit
 * window, staff always). Idempotent: a retried PUT edits. `hifz` left out keeps the rows; sent, it
 * replaces them (`[]` clears). Answers the updated class (`SessionDto`).
 */
export const lessonReportInputSchema = z.object({
  /** The stage the screen showed (`ended` or `taken`); a mismatch is 409 `stale_session`. */
  expectedStage: z.enum(['ended', 'taken']).optional(),
  summary: z.string().trim().min(1).max(5000),
  homework: optionalText(2000),
  tajweedNotes: optionalText(2000),
  /** Internal: staff and teachers only. */
  teacherNotes: optionalText(2000),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  hifz: z.array(hifzEntryInputSchema).max(10).optional(),
});
export type LessonReportInput = z.input<typeof lessonReportInputSchema>;

/**
 * `GET /sessions/:id/report` (`data` null when the class has no report) and
 * `SessionDetailDto.lessonReport`. Parents never get `teacherNotes`, `editableUntil` or the
 * authors' names; `rating` is left out for them when `reports.parent_sees_rating` is off.
 */
export const lessonReportSchema = z.object({
  id: z.number().int(),
  sessionId: z.number().int(),
  studentId: z.number().int(),
  teacherId: z.number().int(),
  summary: z.string(),
  homework: z.string().nullable(),
  tajweedNotes: z.string().nullable(),
  teacherNotes: z.string().nullable().optional(),
  rating: z.number().int().nullable().optional(),
  hifz: z.array(hifzEntrySchema),
  /** End of the class + `sessions.report_due_hours`. */
  dueAt: z.string(),
  late: z.boolean(),
  submittedAt: z.string(),
  submittedBy: personRefSchema.nullable().optional(),
  updatedAt: z.string(),
  updatedBy: personRefSchema.nullable().optional(),
  /** Until when the class's teacher may still edit (null when not taken). */
  editableUntil: z.string().nullable().optional(),
});
export type LessonReportDto = z.infer<typeof lessonReportSchema>;

// ------------------------------------------------------------------ staff list

export const reportStateSchema = z.enum(REPORT_STATES);

const queryId = z.coerce.number().int().positive().max(2_147_483_647);

/**
 * `GET /lesson-reports` (`sessions.view`; staff all, a teacher own classes, parents 403): ended and
 * taken classes with where their report stands, newest class first. `state=missing` is the
 * «بلا تقرير» list behind the board's counter.
 */
export const reportListQuerySchema = z.object({
  state: z
    .preprocess(
      (v) => (typeof v === 'string' ? v.split(',') : v),
      z.array(reportStateSchema).max(4),
    )
    .optional(),
  from: instantSchema.optional(),
  to: instantSchema.optional(),
  teacherId: queryId.optional(),
  studentId: queryId.optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(50),
});
export type ReportListQuery = z.input<typeof reportListQuerySchema>;

export const reportListItemSchema = z.object({
  state: reportStateSchema,
  dueAt: z.string(),
  session: sessionSchema,
  report: z
    .object({
      id: z.number().int(),
      submittedAt: z.string(),
      submittedBy: personRefSchema.nullable(),
      rating: z.number().int().nullable(),
      late: z.boolean(),
    })
    .nullable(),
});
export type ReportListItemDto = z.infer<typeof reportListItemSchema>;

/** `meta.counts` = rows per state (`all` + each state) for the same filters minus `state`. */
export const reportListResponseSchema = paginatedSchema(reportListItemSchema);

// ------------------------------------------------------------------ class detail

/** `GET /sessions/:id`: the class + its timeline + its lesson report + its requests. */
export const sessionDetailSchema = sessionSchema.extend({
  events: z.array(sessionEventSchema),
  lessonReport: lessonReportSchema.nullable(),
  requests: z.array(sessionRequestSummarySchema),
});
export type SessionDetailDto = z.infer<typeof sessionDetailSchema>;
