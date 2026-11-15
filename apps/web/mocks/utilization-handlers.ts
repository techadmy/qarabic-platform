import {
  freeCapacityQuerySchema,
  utilizationQuerySchema,
  type FreeCapacityDto,
  type TeacherUtilizationDto,
  type UtilizationReportDto,
  type WorkHourDto,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { addDays, dateKeyIn, isoWeekday, zonedInstant } from '@/lib/schedule-time';
import { db as people } from './people-db';
import { sdb } from './schedule-db';
import { isParent, isTeacher, ownTeacherId } from './schedule-handlers';
import { apiError, guardAny, validationFailed } from './session';

/**
 * The mock R1 reports (docs/42 §5, `utilization.ts` in `@qarabic/shared`): available time from the
 * weekly work hours day by day in each teacher's zone, booked time from the classes that hold the
 * teacher's time, free = available − booked, and the next 7 days' free capacity per hour. A
 * teacher gets only their own row; parents 403.
 */
const API = '*/api/v1/reports';
const H = 3_600_000;
const ACADEMY_TZ = 'Africa/Cairo';
const OFF = new Set(['cancelled', 'moved_out', 'leave']);

const round = (n: number) => Math.round(n * 100) / 100;
const daysBetween = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

/** Working intervals of a teacher on academy days `from…to` (UTC ms). */
function workIntervals(teacherId: number, from: string, to: string): [number, number][] {
  const t = people.teachers.find((x) => x.id === teacherId)!;
  const hours: WorkHourDto[] = sdb.workHours.get(teacherId) ?? [];
  const start = Date.parse(zonedInstant(from, '00:00', ACADEMY_TZ));
  const end = Date.parse(zonedInstant(addDays(to, 1), '00:00', ACADEMY_TZ));
  const out: [number, number][] = [];
  for (const d of daysBetween(addDays(from, -1), addDays(to, 1))) {
    for (const h of hours.filter((x) => x.weekday === isoWeekday(d))) {
      const tz = h.timezone || t.timezone;
      const a = Date.parse(zonedInstant(d, h.localStartTime, tz));
      const b = Date.parse(
        zonedInstant(h.localEndTime > h.localStartTime ? d : addDays(d, 1), h.localEndTime, tz),
      );
      const s = Math.max(a, start);
      const e = Math.min(b, end);
      if (e > s) out.push([s, e]);
    }
  }
  return out;
}

function numbers(teacherId: number, from: string, to: string) {
  const work = workIntervals(teacherId, from, to);
  const start = Date.parse(zonedInstant(from, '00:00', ACADEMY_TZ));
  const end = Date.parse(zonedInstant(addDays(to, 1), '00:00', ACADEMY_TZ));
  const classes = sdb.sessions.filter(
    (s) =>
      s.teacherId === teacherId &&
      !s.deleted &&
      !OFF.has(s.stage) &&
      Date.parse(s.startsAt) >= start &&
      Date.parse(s.startsAt) < end,
  );
  const available = work.reduce((n, [a, b]) => n + (b - a), 0) / H;
  let inside = 0;
  let outside = 0;
  for (const c of classes) {
    const a = Date.parse(c.startsAt);
    const b = a + c.durationMinutes * 60_000;
    const within = work.reduce((n, [s, e]) => n + Math.max(0, Math.min(b, e) - Math.max(a, s)), 0);
    inside += within / H;
    outside += (b - a - within) / H;
  }
  return {
    availableHours: round(available),
    bookedHours: round(inside + outside),
    freeHours: round(Math.max(0, available - inside)),
    outsideHours: round(outside),
    utilization: available > 0 ? round((inside + outside) / available) : null,
    classes: classes.length,
  };
}

function teachersFor(q: { teacherIds?: number[]; courseId?: number; gender?: string }) {
  return people.teachers.filter(
    (t) =>
      t.status.value === 'active' &&
      (!q.teacherIds || q.teacherIds.includes(t.id)) &&
      (!q.courseId || t.courses.some((c) => c.id === q.courseId)) &&
      (!q.gender || t.gender === q.gender),
  );
}

export const utilizationHandlers: HttpHandler[] = [
  http.get(`${API}/teacher-utilization`, ({ request }) => {
    const g = guardAny(request, 'reports.view', 'sessions.conduct');
    if ('error' in g) return g.error;
    if (isParent(g.me)) return apiError(403, 'forbidden', 'Not allowed.');
    const parsed = utilizationQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const today = dateKeyIn(ACADEMY_TZ);
    const from = q.from ?? `${today.slice(0, 7)}-01`;
    const to = q.to ?? today;
    const length = daysBetween(from, to).length;
    const previous = { from: addDays(from, -length), to: addDays(from, -1) };
    const own = isTeacher(g.me) ? ownTeacherId(g.me) : null;
    const list = own ? people.teachers.filter((t) => t.id === own) : teachersFor(q);
    const teachers: TeacherUtilizationDto[] = list
      .map((t) => {
        const { classes, ...now } = numbers(t.id, from, to);
        const { classes: _c, ...before } = numbers(t.id, previous.from, previous.to);
        return {
          teacher: { id: t.id, name: t.name, timezone: t.timezone },
          ...now,
          classes,
          previous: before,
          utilizationDelta:
            now.utilization !== null && before.utilization !== null
              ? round(now.utilization - before.utilization)
              : null,
        };
      })
      .sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1));
    const sum = (k: 'availableHours' | 'bookedHours' | 'freeHours' | 'outsideHours') =>
      round(teachers.reduce((n, t) => n + t[k], 0));
    const available = sum('availableHours');
    // R1 follow-up: per-day totals (the busiest and emptiest days).
    const days = daysBetween(from, to).map((date) => {
      const each = list.map((t) => numbers(t.id, date, date));
      const add = (k: 'availableHours' | 'bookedHours' | 'freeHours' | 'outsideHours') =>
        round(each.reduce((n, x) => n + x[k], 0));
      const availableHours = add('availableHours');
      return {
        date,
        weekday: isoWeekday(date),
        availableHours,
        bookedHours: add('bookedHours'),
        freeHours: add('freeHours'),
        outsideHours: add('outsideHours'),
        utilization: availableHours > 0 ? round(add('bookedHours') / availableHours) : null,
        classes: each.reduce((n, x) => n + x.classes, 0),
      };
    });
    const data: UtilizationReportDto & { days: typeof days } = {
      range: { from, to, previous, timezone: ACADEMY_TZ },
      days,
      teachers,
      totals: {
        availableHours: available,
        bookedHours: sum('bookedHours'),
        freeHours: sum('freeHours'),
        outsideHours: sum('outsideHours'),
        utilization: available > 0 ? round(sum('bookedHours') / available) : null,
      },
    };
    return HttpResponse.json({ data });
  }),

  http.get(`${API}/free-capacity`, ({ request }) => {
    const g = guardAny(request, 'reports.view', 'sessions.conduct');
    if ('error' in g) return g.error;
    if (isParent(g.me)) return apiError(403, 'forbidden', 'Not allowed.');
    const parsed = freeCapacityQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const tz = q.tz ?? ACADEMY_TZ;
    const from = q.from ?? dateKeyIn(tz);
    const to = q.to ?? addDays(from, 6);
    const own = isTeacher(g.me) ? ownTeacherId(g.me) : null;
    const list = (own ? people.teachers.filter((t) => t.id === own) : teachersFor(q)).filter(
      (t) => !q.audience || t.audience === 'both' || t.audience === q.audience,
    );
    const busy = new Map(
      list.map((t) => [
        t.id,
        sdb.sessions
          .filter((s) => s.teacherId === t.id && !s.deleted && !OFF.has(s.stage))
          .map((s) => [
            Date.parse(s.startsAt),
            Date.parse(s.startsAt) + s.durationMinutes * 60_000,
          ]),
      ]),
    );
    const data: FreeCapacityDto = {
      range: { from, to, timezone: tz },
      teacherCount: list.length,
      days: daysBetween(from, to).map((date) => ({
        date,
        weekday: isoWeekday(date),
        free: Array.from({ length: 24 }, (_, h) => {
          const a = Date.parse(zonedInstant(date, `${String(h).padStart(2, '0')}:00`, tz));
          const b = a + H;
          return list.filter((t) => {
            const work = workIntervals(t.id, addDays(date, -1), addDays(date, 1));
            const covered = work.some(([s, e]) => s <= a && e >= b);
            const taken = (busy.get(t.id) ?? []).some(([s, e]) => s! < b && e! > a);
            return covered && !taken;
          }).length;
        }),
      })),
    };
    return HttpResponse.json({ data });
  }),
];
