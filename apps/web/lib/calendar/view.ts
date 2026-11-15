import {
  SESSION_KINDS,
  SESSION_STAGES,
  type CalendarEventsQuery,
  type SessionKind,
  type SessionStage,
} from '@qarabic/shared';
import { addDays, isDateKey, weekStart, zonedInstant } from '@/lib/schedule-time';

/**
 * The calendar's state in the URL (C2, docs/42 §3.2–3.3): the view and its date, the filters, and
 * the zone the times are drawn in. One class has three local times (academy, teacher, student),
 * so the zone is a choice; the teacher's or student's zone needs exactly one of them selected.
 */
export const CALENDAR_VIEWS = ['month', 'week', 'day', 'list'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];
export const CALENDAR_ZONES = ['academy', 'mine', 'teacher', 'student'] as const;
export type CalendarZone = (typeof CALENDAR_ZONES)[number];

export interface CalendarState {
  view: CalendarView;
  /** The date the view shows (`YYYY-MM-DD`, in the chosen zone). */
  date: string;
  teacherIds: number[];
  studentIds: number[];
  courseId: number | null;
  kind: SessionKind | null;
  stage: SessionStage | null;
  zone: CalendarZone;
}

const ids = (v: string | null) =>
  (v ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 200);

export function calendarState(get: (k: string) => string | null, today: string): CalendarState {
  const view = get('view') as CalendarView;
  const kind = get('kind') as SessionKind;
  const stage = get('stage') as SessionStage;
  const zone = get('zone') as CalendarZone;
  const date = get('date');
  return {
    view: CALENDAR_VIEWS.includes(view) ? view : 'week',
    date: isDateKey(date) ? date : today,
    teacherIds: ids(get('teachers')),
    studentIds: ids(get('students')),
    courseId: Number(get('course')) || null,
    kind: SESSION_KINDS.includes(kind) ? kind : null,
    stage: SESSION_STAGES.includes(stage) ? stage : null,
    zone: CALENDAR_ZONES.includes(zone) ? zone : 'academy',
  };
}

/** Writes a state change back as URL params (defaults left out). */
export function calendarParams(
  patch: Partial<CalendarState>,
  today: string,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if ('view' in patch) out.view = patch.view === 'week' ? null : patch.view!;
  if ('date' in patch) out.date = patch.date === today ? null : patch.date!;
  if ('teacherIds' in patch)
    out.teachers = patch.teacherIds!.length ? patch.teacherIds!.join(',') : null;
  if ('studentIds' in patch)
    out.students = patch.studentIds!.length ? patch.studentIds!.join(',') : null;
  if ('courseId' in patch) out.course = patch.courseId ? String(patch.courseId) : null;
  if ('kind' in patch) out.kind = patch.kind ?? null;
  if ('stage' in patch) out.stage = patch.stage ?? null;
  if ('zone' in patch) out.zone = patch.zone === 'academy' ? null : patch.zone!;
  return out;
}

/** The local dates a view covers, `[first, last]` (the academy week starts on Saturday). */
export function viewDays(view: CalendarView, date: string): { first: string; last: string } {
  switch (view) {
    case 'day':
      return { first: date, last: date };
    case 'week':
      return { first: weekStart(date), last: addDays(weekStart(date), 6) };
    case 'list':
      // The agenda: four weeks from the date.
      return { first: date, last: addDays(date, 27) };
    case 'month': {
      // The month grid: whole weeks around the month (at most 6 × 7 = 42 days).
      const first = weekStart(`${date.slice(0, 7)}-01`);
      const [y, m] = date.split('-').map(Number);
      const lastOfMonth = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
      return { first, last: addDays(weekStart(lastOfMonth), 6) };
    }
  }
}

/** The API range for a view: `[from, to)` as UTC instants, the days counted in `tz`. */
export function viewRange(view: CalendarView, date: string, tz: string) {
  const { first, last } = viewDays(view, date);
  return {
    from: zonedInstant(first, '00:00', tz),
    to: zonedInstant(addDays(last, 1), '00:00', tz),
  };
}

/** Previous / next page of the view. */
export function stepDate(view: CalendarView, date: string, dir: 1 | -1): string {
  if (view === 'day') return addDays(date, dir);
  if (view === 'week') return addDays(date, 7 * dir);
  if (view === 'list') return addDays(date, 28 * dir);
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1 + dir, 1)).toISOString().slice(0, 10);
}

/** The events query for a state (filters left out when empty). */
export function eventsQuery(s: CalendarState, tz: string): CalendarEventsQuery {
  return {
    ...viewRange(s.view, s.date, tz),
    ...(s.teacherIds.length ? { teacherIds: s.teacherIds } : {}),
    ...(s.studentIds.length ? { studentIds: s.studentIds } : {}),
    ...(s.courseId ? { courseIds: [s.courseId] } : {}),
    ...(s.kind ? { kinds: [s.kind] } : {}),
    ...(s.stage ? { stages: [s.stage] } : {}),
    tz,
  };
}

/**
 * The zone to draw in. The teacher's (student's) zone needs exactly one teacher (student) chosen;
 * otherwise it falls back to the academy's, and the switch says why.
 */
export function zoneOf(
  zone: CalendarZone,
  ctx: { academy: string; mine: string; teacherTz: string | null; studentTz: string | null },
): string {
  if (zone === 'mine') return ctx.mine;
  if (zone === 'teacher' && ctx.teacherTz) return ctx.teacherTz;
  if (zone === 'student' && ctx.studentTz) return ctx.studentTz;
  return ctx.academy;
}
