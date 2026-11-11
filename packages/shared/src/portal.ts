import { z } from 'zod';
import { courseRefSchema } from './people.js';
import { progressTimelineItemSchema } from './progress.js';
import { sessionSchema } from './sessions.js';

/**
 * Parent portal home (N4, M4, D138) — `GET /api/v1/parent/home`. One round trip for the parent's
 * home screen (web and the mobile app later): the family, each child with their teacher and next
 * class, the upcoming classes, and the open-request counters. Always the signed-in parent's own
 * family (no id in the path, nothing to guess). Classes come in the usual `SessionDto` (the
 * viewer's zone first in the UI, the teacher's labelled, D30); never a meeting link or a teacher's
 * phone.
 */

export const parentHomeChildSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.enum(['active', 'inactive']),
  course: courseRefSchema.nullable(),
  teacher: z.object({ id: z.number().int(), name: z.string(), timezone: z.string() }).nullable(),
  nextClass: z
    .object({
      id: z.number().int(),
      startsAt: z.string(),
      endsAt: z.string(),
      stage: z.string(),
    })
    .nullable(),
});
export type ParentHomeChildDto = z.infer<typeof parentHomeChildSchema>;

/**
 * A lesson report as the parent reads it on the home screen (N3 report, parent-safe): never the
 * teacher's internal note or the late flag; `rating` only when `reports.parent_sees_rating` is on.
 */
export const parentHomeReportSchema = progressTimelineItemSchema
  .omit({ teacherNotes: true, late: true })
  .extend({ student: z.object({ id: z.number().int(), name: z.string() }) })
  .strict();
export type ParentHomeReportDto = z.infer<typeof parentHomeReportSchema>;

/** How many recent reports per child the home shows. */
export const PARENT_HOME_REPORTS_PER_CHILD = 3;

export const parentHomeSchema = z.object({
  family: z.object({
    id: z.number().int(),
    name: z.string(),
    timezone: z.string(),
    status: z.string(),
  }),
  children: z.array(parentHomeChildSchema),
  /** The next 7 days (live classes only), at most 20, soonest first. */
  upcomingClasses: z.array(sessionSchema),
  requests: z.object({
    /** Pending class requests on my children. */
    pendingClassRequests: z.number().int(),
    /** My open «تواصل معنا» tickets, and how many have news since I last looked. */
    openTickets: z.number().int(),
    ticketUpdates: z.number().int(),
  }),
  /**
   * The latest lesson reports of each child (at most `PARENT_HOME_REPORTS_PER_CHILD` each), newest
   * class first, parent-safe (see `parentHomeReportSchema`).
   */
  recentReports: z.array(parentHomeReportSchema),
});
export type ParentHomeDto = z.infer<typeof parentHomeSchema>;
