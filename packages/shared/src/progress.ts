import { z } from 'zod';
import { personRefSchema } from './people.js';
import { HIFZ_TYPES, hifzEntrySchema } from './reports.js';
import { instantSchema, personZoneRefSchema } from './schedule.js';

/**
 * Student progress (N3): `GET /api/v1/students/:id/progress` — last positions, the lesson timeline,
 * ayahs per month and the hifz coverage, all computed from the lesson reports (D72; Laravel
 * `ProgressController`). Staff with `families.view`, a teacher for their own students, a parent for
 * their own children (404 outside the scope). Parents never get `teacherNotes`; they get `rating`
 * unless `reports.parent_sees_rating` is off (B30).
 */

export const progressQuerySchema = z.object({
  /** Classes from / before these instants. */
  from: instantSchema.optional(),
  to: instantSchema.optional(),
  /** Only this hifz type in the timeline rows. */
  type: z.enum(HIFZ_TYPES).optional(),
});
export type ProgressQuery = z.input<typeof progressQuerySchema>;

/** The latest row of a type, with its class and when the lesson happened. */
export const lastPositionSchema = hifzEntrySchema.extend({
  sessionId: z.number().int(),
  date: z.string(),
});
export type LastPositionDto = z.infer<typeof lastPositionSchema>;

export const progressTimelineItemSchema = z.object({
  sessionId: z.number().int(),
  reportId: z.number().int(),
  startsAt: z.string(),
  teacher: personRefSchema.nullable(),
  summary: z.string(),
  homework: z.string().nullable(),
  tajweedNotes: z.string().nullable(),
  /** Staff and teachers only. */
  teacherNotes: z.string().nullable().optional(),
  rating: z.number().int().nullable().optional(),
  submittedAt: z.string(),
  late: z.boolean(),
  hifz: z.array(hifzEntrySchema),
});
export type ProgressTimelineItemDto = z.infer<typeof progressTimelineItemSchema>;

/** New ayahs (sabaq) per academy-zone month, the last 12 months. */
export const monthlyAyahsSchema = z.object({ month: z.string(), ayahs: z.number().int() });

/**
 * What the student has memorised: the union of every sabaq range (an ayah counts once however
 * often it is reported). `surahs` lists the surahs with at least one memorised ayah.
 */
export const hifzCoverageSchema = z.object({
  memorisedAyahs: z.number().int(),
  totalAyahs: z.number().int(),
  /** 0–100, one decimal. */
  percent: z.number(),
  completeSurahs: z.number().int(),
  surahs: z.array(
    z.object({
      number: z.number().int(),
      memorisedAyahs: z.number().int(),
      ayahCount: z.number().int(),
      complete: z.boolean(),
    }),
  ),
});
export type HifzCoverageDto = z.infer<typeof hifzCoverageSchema>;

export const progressSchema = z.object({
  studentId: z.number().int(),
  student: personZoneRefSchema,
  lastPositions: z.array(lastPositionSchema),
  /** Newest first, up to 200 reports. */
  timeline: z.array(progressTimelineItemSchema),
  monthlyAyahs: z.array(monthlyAyahsSchema),
  coverage: hifzCoverageSchema,
});
export type ProgressDto = z.infer<typeof progressSchema>;

export const PROGRESS_LABELS = {
  title: { ar: 'التقدم وسجل الدروس', en: 'Progress and lesson log' },
  lastPositions: { ar: 'آخر موضع', en: 'Last position' },
  monthlyAyahs: { ar: 'الآيات في الشهر', en: 'Ayahs per month' },
  coverage: { ar: 'المحفوظ من القرآن', en: 'Memorised so far' },
  completeSurahs: { ar: 'سور مكتملة', en: 'Complete surahs' },
  timeline: { ar: 'سجل الدروس', en: 'Lesson log' },
  noProgress: { ar: 'لم يُسجَّل حفظ بعد', en: 'No hifz recorded yet' },
} as const;
