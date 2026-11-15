import { z } from 'zod';
import { timeZoneSchema } from './countries.js';
import { instantSchema } from './schedule.js';
import { SESSION_KINDS, SESSION_STAGES } from './sessions.js';

/*
| Calendar module C1 (docs/42 §3, D148). Every time on the wire is a UTC instant; the client shows
| it in the zone it chooses (viewer, Cairo, teacher, student). Ranges are half-open [from, to).
*/

/** One request covers at most ~two months (a month view plus its leading and trailing weeks). */
export const CALENDAR_MAX_DAYS = 62;
/** Events beyond this in one answer: `truncated` is true and the client narrows the filters. */
export const CALENDAR_MAX_EVENTS = 5000;

const id = z.coerce.number().int().positive();
/** `?teacherIds=1,2` or `?teacherIds=1&teacherIds=2`. */
const idList = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
    z.array(id).min(1).max(max),
  );
const enumList = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
    z.array(z.enum(values)).min(1).max(values.length),
  );

const rangeRules = (q: { from: string; to: string }, ctx: z.RefinementCtx) => {
  const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
  if (!(days > 0)) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'The end must be after the start.' });
  } else if (days > CALENDAR_MAX_DAYS) {
    ctx.addIssue({
      code: 'custom',
      path: ['to'],
      message: `Choose a range of at most ${CALENDAR_MAX_DAYS} days.`,
    });
  }
};

// ------------------------------------------------------------------ events

/**
 * `GET /calendar/events` (`schedule.view`). Staff see every teacher (narrowed by the filters); a
 * teacher sees only their own classes, whatever they ask for. Deleted classes never show.
 */
export const calendarEventsQuerySchema = z
  .object({
    from: instantSchema,
    to: instantSchema,
    teacherIds: idList(200).optional(),
    studentIds: idList(200).optional(),
    familyIds: idList(200).optional(),
    courseIds: idList(50).optional(),
    kinds: enumList(SESSION_KINDS).optional(),
    stages: enumList(SESSION_STAGES).optional(),
    /** The zone the client shows (echoed back; times stay UTC). Default: the viewer's zone. */
    tz: timeZoneSchema.optional(),
  })
  .superRefine(rangeRules);
export type CalendarEventsQuery = z.input<typeof calendarEventsQuerySchema>;

const zonePerson = z.object({ id: z.number().int(), name: z.string(), timezone: z.string() });

/** One class as a calendar event: compact, no history, no Zoom secrets. */
export const calendarEventSchema = z.object({
  id: z.number().int(),
  startsAt: z.string(),
  endsAt: z.string(),
  durationMinutes: z.number().int(),
  kind: z.enum(SESSION_KINDS),
  stage: z.enum(SESSION_STAGES),
  /** The board's attention codes (late, needs review, Zoom failed, pending request…). */
  attention: z.array(z.string()),
  teacher: zonePerson,
  student: zonePerson.extend({ familyId: z.number().int() }),
  course: z.object({ id: z.number().int(), nameAr: z.string(), nameEn: z.string() }).nullable(),
  enrollmentId: z.number().int().nullable(),
  /** The weekly slot it came from; null for a one-off class. */
  slotId: z.number().int().nullable(),
  /** Moved on its own: no longer follows its weekly slot. */
  isDetached: z.boolean(),
  /** Send back on `PATCH /sessions/:id` (drag / resize). */
  lockVersion: z.number().int(),
});
export type CalendarEventDto = z.infer<typeof calendarEventSchema>;

export const calendarEventsSchema = z.object({
  range: z.object({ from: z.string(), to: z.string(), timezone: z.string() }),
  events: z.array(calendarEventSchema),
  /** More than CALENDAR_MAX_EVENTS matched: narrow the range or the filters. */
  truncated: z.boolean(),
});
export type CalendarEventsDto = z.infer<typeof calendarEventsSchema>;

// ------------------------------------------------------------------ background

/**
 * `GET /calendar/background` (`schedule.view`): what to shade behind the events. Work hours,
 * blocks and leave are expanded to concrete UTC intervals inside [from, to), exact across DST
 * (each rule is applied in its own zone, day by day). A teacher gets only their own row.
 */
export const calendarBackgroundQuerySchema = z
  .object({
    from: instantSchema,
    to: instantSchema,
    /** Default: every active teacher the viewer may see (staff), capped at 200. */
    teacherIds: idList(200).optional(),
    tz: timeZoneSchema.optional(),
  })
  .superRefine(rangeRules);
export type CalendarBackgroundQuery = z.input<typeof calendarBackgroundQuerySchema>;

export const intervalSchema = z.object({ start: z.string(), end: z.string() });
export type IntervalDto = z.infer<typeof intervalSchema>;

export const calendarBackgroundSchema = z.object({
  range: z.object({ from: z.string(), to: z.string(), timezone: z.string() }),
  teachers: z.array(
    z.object({
      teacherId: z.number().int(),
      name: z.string(),
      timezone: z.string(),
      /** Working time (white). Anything else in the range is outside hours (grey). */
      workHours: z.array(intervalSchema),
      /** Blocks and leave (hatched); `reason` from TEACHER_BLOCK_REASONS. */
      blocks: z.array(
        intervalSchema.extend({
          blockId: z.number().int(),
          reason: z.string(),
          kind: z.enum(['recurring', 'one_off']),
        }),
      ),
    }),
  ),
  /** Academy holidays touching the range (no classes are generated on them). */
  holidays: z.array(
    intervalSchema.extend({ id: z.number().int(), name: z.string(), appliesTo: z.string() }),
  ),
});
export type CalendarBackgroundDto = z.infer<typeof calendarBackgroundSchema>;

// ------------------------------------------------------------------ series edit

/**
 * `PATCH /sessions/:id` `scope` (the Google question, docs/42 §3.4):
 * - `this`: only this class moves; it becomes detached from its weekly slot (today's behaviour);
 * - `following`: this class and every later one: the weekly slot is closed the day before this
 *   occurrence and a new slot opens from it with the new weekday/time/duration/teacher. History
 *   stays. Same conflict check (409 / acknowledgeWarnings) and `lockVersion` guard. Only for a
 *   class that belongs to a weekly slot (`slotId` not null), else 422.
 */
export const SESSION_EDIT_SCOPES = ['this', 'following'] as const;
export type SessionEditScope = (typeof SESSION_EDIT_SCOPES)[number];

/** Returned next to the class when `scope=following`. */
export const seriesChangeSchema = z.object({
  closedSlotId: z.number().int(),
  newSlotId: z.number().int(),
  /** First local date (the slot's zone) of the new weekly time. */
  effectiveFrom: z.string(),
  /** Classes already generated after this one that moved with the series. */
  movedSessionIds: z.array(z.number().int()),
});
export type SeriesChangeDto = z.infer<typeof seriesChangeSchema>;
