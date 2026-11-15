import {
  approveAvailabilityChangeSchema,
  availabilityChangeQuerySchema,
  createTeacherBlockSchema,
  rejectAvailabilityChangeSchema,
  replaceWorkHoursSchema,
  type AvailabilityChangeDto,
  type AvailabilityChangeKind,
  type TeacherBlockDto,
  type WorkHourDto,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { addDays, dateKeyIn, hhmmIn, isoWeekday } from '@/lib/schedule-time';
import type { MockUser } from './data';
import { db as people } from './people-db';
import { sdb } from './schedule-db';
import { body, isTeacher, ownTeacherId } from './schedule-handlers';
import { apiError, guardAny, notFound, validationFailed } from './session';

/**
 * The mock A1 availability approval (docs/42 §4, D148, B131; contract in `availability.ts`): a
 * teacher's own work-hours or block change is answered 202 with a pending change; staff with
 * `schedule.manage` approve (never their own) or reject with a reason. Registered before the
 * schedule handlers: a staff edit falls through to them and applies at once.
 */
const API = '*/api/v1';
const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

interface ChangeRow {
  id: number;
  teacherId: number;
  kind: AvailabilityChangeKind;
  status: AvailabilityChangeDto['status'];
  blockId: number | null;
  payload: Record<string, unknown>;
  effectiveFrom: string;
  note: string | null;
  requestedBy: { id: number; name: string };
  requestedAt: string;
  decidedBy: { id: number; name: string } | null;
  decidedAt: string | null;
  decisionReason: string | null;
  appliedAt: string | null;
}

let changes: ChangeRow[] = [];
let nextId = 1;
export function resetAvailabilityChanges() {
  changes = [];
  nextId = 1;
}

const teacherOf = (id: number) => people.teachers.find((t) => t.id === id);
const manages = (me: MockUser) => me.permissions.includes('schedule.manage');
const ref = (me: MockUser) => ({ id: me.id, name: me.name });

/** Booked classes in the next 60 days from `from` that fall outside `hours` (teacher's zone). */
function affectedBy(teacherId: number, hours: WorkHourDto[], from: string) {
  const tz = teacherOf(teacherId)?.timezone ?? 'Africa/Cairo';
  const until = addDays(from, 60);
  return sdb.sessions
    .filter((s) => {
      if (s.teacherId !== teacherId || s.deleted || s.stage !== 'scheduled') return false;
      const key = dateKeyIn(tz, new Date(s.startsAt));
      if (key < from || key > until) return false;
      const wd = isoWeekday(key);
      const t = hhmmIn(s.startsAt, tz);
      return !hours.some(
        (h) =>
          h.weekday === wd &&
          h.localStartTime <= t &&
          (h.localEndTime > t || h.localEndTime < h.localStartTime),
      );
    })
    .slice(0, 50)
    .map((s) => {
      const student = people.students.find((x) => x.id === s.studentId)!;
      return {
        id: s.id,
        startsAt: s.startsAt,
        endsAt: new Date(Date.parse(s.startsAt) + s.durationMinutes * 60_000).toISOString(),
        kind: s.kind,
        student: { id: student.id, name: student.name },
      };
    });
}

function present(c: ChangeRow, me: MockUser): AvailabilityChangeDto {
  const t = teacherOf(c.teacherId)!;
  const pending = c.status === 'pending';
  const own = c.requestedBy.id === me.id;
  return {
    ...c,
    teacher: { id: t.id, name: t.name, timezone: t.timezone },
    affected:
      c.kind === 'work_hours'
        ? affectedBy(c.teacherId, (c.payload.workHours as WorkHourDto[]) ?? [], c.effectiveFrom)
        : [],
    can: {
      approve: pending && manages(me) && !own,
      reject: pending && manages(me) && !own,
      withdraw: pending && own,
    },
  };
}

function request(
  me: MockUser,
  teacherId: number,
  kind: AvailabilityChangeKind,
  payload: Record<string, unknown>,
  extra: { blockId?: number | null; effectiveFrom?: string; note?: string | null } = {},
) {
  const t = teacherOf(teacherId)!;
  const row: ChangeRow = {
    id: nextId++,
    teacherId,
    kind,
    status: 'pending',
    blockId: extra.blockId ?? null,
    payload,
    effectiveFrom: extra.effectiveFrom ?? dateKeyIn(t.timezone),
    note: extra.note ?? null,
    requestedBy: ref(me),
    requestedAt: iso(),
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    appliedAt: null,
  };
  changes.push(row);
  return HttpResponse.json({ data: present(row, me), pending: true }, { status: 202 });
}

/** Only the teacher themself asks; staff fall through to the schedule handlers. */
function ownRequest(request: Request, teacherId: number) {
  const g = guardAny(request, 'schedule.manage', 'sessions.conduct');
  if ('error' in g) return { error: g.error };
  if (manages(g.me) || !isTeacher(g.me)) return null;
  if (ownTeacherId(g.me) !== teacherId) return { error: apiError(403, 'forbidden', 'Forbidden.') };
  return { me: g.me };
}

function apply(c: ChangeRow) {
  const t = teacherOf(c.teacherId)!;
  if (c.kind === 'work_hours') {
    sdb.workHours.set(
      c.teacherId,
      ((c.payload.workHours as WorkHourDto[]) ?? []).map((w) => ({
        ...w,
        timezone: w.timezone ?? t.timezone,
      })),
    );
  } else if (c.kind === 'block_create') {
    const v = c.payload as Partial<TeacherBlockDto>;
    sdb.blocks.push({
      id: sdb.nextId.other++,
      teacherId: c.teacherId,
      kind: v.kind ?? 'one_off',
      reason: v.reason ?? 'other',
      weekday: v.weekday ?? null,
      localStartTime: v.localStartTime ?? null,
      durationMinutes: v.durationMinutes ?? null,
      timezone: v.timezone ?? (v.kind === 'recurring' ? t.timezone : null),
      validFrom: v.validFrom ?? null,
      validTo: v.validTo ?? null,
      startsAt: v.startsAt ?? null,
      endsAt: v.endsAt ?? null,
      note: v.note ?? null,
    });
  } else if (c.kind === 'block_delete') {
    sdb.blocks = sdb.blocks.filter((b) => b.id !== c.blockId);
  }
  c.status = 'applied';
  c.appliedAt = iso();
}

export const availabilityHandlers: HttpHandler[] = [
  http.put(`${API}/teachers/:teacherId/work-hours`, async ({ request: req, params }) => {
    const teacherId = Number(params.teacherId);
    const own = ownRequest(req, teacherId);
    if (!own) return undefined;
    if ('error' in own) return own.error;
    const parsed = replaceWorkHoursSchema.safeParse(await body(req.clone()));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const { workHours, effectiveFrom, requestNote } = parsed.data;
    return request(
      own.me,
      teacherId,
      'work_hours',
      { workHours },
      {
        effectiveFrom,
        note: requestNote ?? null,
      },
    );
  }),

  http.post(`${API}/teachers/:teacherId/blocks`, async ({ request: req, params }) => {
    const teacherId = Number(params.teacherId);
    const own = ownRequest(req, teacherId);
    if (!own) return undefined;
    if ('error' in own) return own.error;
    const parsed = createTeacherBlockSchema.safeParse(await body(req.clone()));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    return request(own.me, teacherId, 'block_create', parsed.data as Record<string, unknown>);
  }),

  http.delete(`${API}/teachers/:teacherId/blocks/:blockId`, ({ request: req, params }) => {
    const teacherId = Number(params.teacherId);
    const own = ownRequest(req, teacherId);
    if (!own) return undefined;
    if ('error' in own) return own.error;
    const blockId = Number(params.blockId);
    if (!sdb.blocks.some((b) => b.id === blockId && b.teacherId === teacherId)) return notFound();
    return request(own.me, teacherId, 'block_delete', {}, { blockId });
  }),

  http.get(`${API}/availability-changes`, ({ request: req }) => {
    const g = guardAny(req, 'schedule.view', 'sessions.conduct');
    if ('error' in g) return g.error;
    const q = availabilityChangeQuerySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    if (!q.success) return validationFailed(q.error.issues);
    const mine = isTeacher(g.me) && !manages(g.me) ? ownTeacherId(g.me) : null;
    const rows = changes
      .filter(
        (c) =>
          (!mine || c.teacherId === mine) &&
          (!q.data.status || c.status === q.data.status) &&
          (!q.data.teacherId || c.teacherId === q.data.teacherId),
      )
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.id - a.id)
      .map((c) => present(c, g.me));
    return HttpResponse.json({ data: rows });
  }),

  http.post(`${API}/availability-changes/:id/:action`, async ({ request: req, params }) => {
    const action = String(params.action);
    const g = guardAny(
      req,
      ...(action === 'withdraw' ? ['sessions.conduct'] : ['schedule.manage']),
    );
    if ('error' in g) return g.error;
    const c = changes.find((x) => x.id === Number(params.id));
    if (!c) return notFound();
    if (c.status !== 'pending') return apiError(409, 'not_pending', 'Already decided.');
    if (action === 'withdraw') {
      if (c.requestedBy.id !== g.me.id) return apiError(403, 'forbidden', 'Forbidden.');
      c.status = 'withdrawn';
      return HttpResponse.json({ data: present(c, g.me) });
    }
    if (c.requestedBy.id === g.me.id) {
      return apiError(403, 'self_decision', 'You cannot decide your own request.');
    }
    const json = await body(req);
    if (action === 'reject') {
      const parsed = rejectAvailabilityChangeSchema.safeParse(json);
      if (!parsed.success) return validationFailed(parsed.error.issues);
      Object.assign(c, {
        status: 'rejected',
        decidedBy: ref(g.me),
        decidedAt: iso(),
        decisionReason: parsed.data.reason,
      });
      return HttpResponse.json({ data: present(c, g.me) });
    }
    if (action !== 'approve') return notFound();
    const parsed = approveAvailabilityChangeSchema.safeParse(json ?? {});
    if (!parsed.success) return validationFailed(parsed.error.issues);
    Object.assign(c, {
      decidedBy: ref(g.me),
      decidedAt: iso(),
      decisionReason: parsed.data.note ?? null,
      effectiveFrom: parsed.data.effectiveFrom ?? c.effectiveFrom,
    });
    apply(c);
    return HttpResponse.json({ data: present(c, g.me) });
  }),
];
