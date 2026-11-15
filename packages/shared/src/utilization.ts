import { z } from 'zod';
import { timeZoneSchema } from './countries.js';
import { dateOnlySchema } from './people.js';

/*
| R1 (docs/42 §5, D148): teacher utilization and free capacity. Available time = approved work
| hours − blocks and leave − academy holidays, expanded day by day in each teacher's zone
| (DST-exact). Booked time = classes that are not cancelled, moved or deleted.
*/

export const UTILIZATION_MAX_DAYS = 92;
export const FREE_CAPACITY_MAX_DAYS = 7;

const id = z.coerce.number().int().positive();
const idList = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
  z.array(id).min(1).max(200),
);
const days = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;

export const CAPACITY_GENDERS = ['male', 'female'] as const;
export const CAPACITY_AUDIENCES = ['children', 'adults'] as const;

const teacherFilters = {
  teacherIds: idList.optional(),
  /** Teachers who teach this course. */
  courseId: id.optional(),
  gender: z.enum(CAPACITY_GENDERS).optional(),
};

/**
 * `GET /reports/teacher-utilization?from&to&teacherIds&courseId&gender` (`reports.view`; a teacher
 * gets only their own row). Dates are academy-local and inclusive; default = the current month.
 */
export const utilizationQuerySchema = z
  .object({
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    ...teacherFilters,
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    path: ['to'],
    message: 'Send both from and to, or neither.',
  })
  .refine(
    (q) => !q.from || !q.to || (q.from <= q.to && days(q.from, q.to) <= UTILIZATION_MAX_DAYS),
    {
      path: ['to'],
      message: `Choose a range of at most ${UTILIZATION_MAX_DAYS} days.`,
    },
  );
export type UtilizationQuery = z.input<typeof utilizationQuerySchema>;

const periodNumbers = z.object({
  /** Hours, two decimals. */
  availableHours: z.number(),
  bookedHours: z.number(),
  /** Available time with no class in it. */
  freeHours: z.number(),
  /** Booked time outside the available hours (overtime / outside work hours). */
  outsideHours: z.number(),
  /** booked ÷ available, 0…1+ (can pass 1 with overtime); null when nothing was available. */
  utilization: z.number().nullable(),
});

export const teacherUtilizationSchema = periodNumbers.extend({
  teacher: z.object({ id: z.number().int(), name: z.string(), timezone: z.string() }),
  classes: z.number().int(),
  /** The same numbers for the period of the same length just before. */
  previous: periodNumbers,
  /** utilization − previous.utilization (null when either is null). */
  utilizationDelta: z.number().nullable(),
});
export type TeacherUtilizationDto = z.infer<typeof teacherUtilizationSchema>;

export const utilizationReportSchema = z.object({
  range: z.object({
    from: z.string(),
    to: z.string(),
    previous: z.object({ from: z.string(), to: z.string() }),
    timezone: z.string(),
  }),
  /** Most loaded first. */
  teachers: z.array(teacherUtilizationSchema),
  totals: periodNumbers,
});
export type UtilizationReportDto = z.infer<typeof utilizationReportSchema>;

/**
 * `GET /reports/free-capacity?from&to&courseId&gender&audience&tz` (`reports.view`): for each
 * weekday × hour (in `tz`, default the academy's), how many teachers are free for that whole hour.
 * At most 7 days, so each cell is one concrete hour; default = the next 7 days.
 */
export const freeCapacityQuerySchema = z
  .object({
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    ...teacherFilters,
    /** Teachers who take this audience (`both` always counts). */
    audience: z.enum(CAPACITY_AUDIENCES).optional(),
    tz: timeZoneSchema.optional(),
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    path: ['to'],
    message: 'Send both from and to, or neither.',
  })
  .refine(
    (q) => !q.from || !q.to || (q.from <= q.to && days(q.from, q.to) <= FREE_CAPACITY_MAX_DAYS),
    {
      path: ['to'],
      message: `Choose a range of at most ${FREE_CAPACITY_MAX_DAYS} days.`,
    },
  );
export type FreeCapacityQuery = z.input<typeof freeCapacityQuerySchema>;

export const freeCapacitySchema = z.object({
  range: z.object({ from: z.string(), to: z.string(), timezone: z.string() }),
  /** Teachers matching the filters (the most a cell can show). */
  teacherCount: z.number().int(),
  /** One row per date in the range (`weekday` 1 = Monday … 7 = Sunday), 24 hourly counts. */
  days: z.array(
    z.object({
      date: z.string(),
      weekday: z.number().int().min(1).max(7),
      /** `free[h]` = teachers free for the whole hour starting at h:00 local. */
      free: z.array(z.number().int()).length(24),
    }),
  ),
});
export type FreeCapacityDto = z.infer<typeof freeCapacitySchema>;
