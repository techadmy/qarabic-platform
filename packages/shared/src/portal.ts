import { z } from 'zod';
import { courseRefSchema } from './people.js';
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
   * Latest lesson reports per child. `null` until N3 (lesson reports) is merged, then filled
   * without the teacher's internal notes.
   */
  recentReports: z.null(),
});
export type ParentHomeDto = z.infer<typeof parentHomeSchema>;
