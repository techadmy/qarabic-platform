import {
  addSlotSchema,
  approveSessionRequestSchema,
  createEnrollmentSchema,
  createHolidaySchema,
  createSessionRequestSchema,
  createTeacherBlockSchema,
  createZoomHostSchema,
  endEnrollmentSchema,
  endSlotSchema,
  enrollmentListQuerySchema,
  generateSessionsSchema,
  LEAVE_REASONS,
  CANCEL_REASONS,
  pauseEnrollmentSchema,
  rejectSessionRequestSchema,
  replaceWorkHoursSchema,
  scheduleCheckSchema,
  SESSION_ACTIONS,
  SESSION_STAGES,
  sessionListQuerySchema,
  sessionRequestListQuerySchema,
  REQUEST_STATUSES,
  REQUEST_TYPES,
  TERMINAL_STAGES,
  transitionSchema,
  updateEnrollmentSchema,
  updateHolidaySchema,
  updateSessionSchema,
  updateSessionSettingsSchema,
  updateSlotSchema,
  updateTeacherBlockSchema,
  updateZoomHostSchema,
  availabilityQuerySchema,
  ENROLLMENT_STATUSES,
  type ConflictDto,
  type EnrollmentDto,
  type ScheduleSlotDto,
  type SessionAction,
  type SessionDto,
  type SessionRequestDto,
  type SessionStage,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import {
  addDays,
  dateKeyIn,
  hhmmIn,
  isoWeekday,
  weekStart,
  zonedInstant,
} from '@/lib/schedule-time';
import type { MockUser } from './data';
import { COURSES, db as people } from './people-db';
import {
  addEvent,
  eventsOf,
  generateFor,
  sdb,
  type EnrollmentRow,
  type RequestRow,
  type SessionRow,
  type SlotRow,
} from './schedule-db';
import { apiError, guard, guardAny, notFound, validationFailed } from './session';
import { editableUntil, presentReport, reportMissing, reportOf } from './teaching-present';

/**
 * MSW handlers for the N2 schedule and class endpoints, same contract as apps/api/README.md (N2):
 * the row scopes (a teacher's own classes, a parent's own children), the state machine with its
 * windows and refusals, conflicts (409 `schedule_conflict`, 422 `warnings_not_acknowledged`),
 * requests with auto-approval, holidays, blocks, work hours and the class rules. Fake data only.
 */
const API = '*/api/v1';
const MIN = 60_000;
const nowMs = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const settings = () => sdb.settings;

export async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
export function queryOf(request: Request) {
  const params = new URL(request.url).searchParams;
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = out[k] ? `${out[k]},${v}` : v;
  return out;
}

// ------------------------------------------------------------------ viewer scope

export const isTeacher = (me: MockUser) => me.role?.kind === 'teacher';
export const isParent = (me: MockUser) => me.role?.kind === 'parent';
export const ownTeacherId = (me: MockUser) =>
  people.teachers.find((t) => t.userId === me.id)?.id ?? null;
export const ownFamilyId = (me: MockUser) =>
  people.families.find((f) => f.parentUserId === me.id)?.id ?? null;
const studentOf = (id: number) => people.students.find((s) => s.id === id);
const teacherOf = (id: number) => people.teachers.find((t) => t.id === id);
const familyTz = (studentId: number) =>
  people.families.find((f) => f.id === studentOf(studentId)?.familyId)?.timezone ?? 'UTC';

export function seesSession(me: MockUser, s: Pick<SessionRow, 'teacherId' | 'studentId'>) {
  if (isTeacher(me)) return s.teacherId === ownTeacherId(me);
  if (isParent(me)) return studentOf(s.studentId)?.familyId === ownFamilyId(me);
  return true;
}
function seesEnrollment(me: MockUser, e: EnrollmentRow) {
  if (isTeacher(me)) return e.teacher.id === ownTeacherId(me);
  if (isParent(me)) return e.student.familyId === ownFamilyId(me);
  return true;
}

// ------------------------------------------------------------------ presenters

const endsAt = (s: SessionRow) => iso(Date.parse(s.startsAt) + s.durationMinutes * MIN);
const pendingOf = (s: SessionRow) =>
  sdb.requests.filter((r) => r.sessionId === s.id && r.status === 'pending');

function attention(s: SessionRow): string[] {
  const now = nowMs();
  const start = Date.parse(s.startsAt);
  const end = start + s.durationMinutes * MIN;
  const out: string[] = [];
  if (s.deleted) return ['deleted'];
  if (s.stage === 'scheduled' && now > end) out.push('needs_entry');
  else if (s.stage === 'scheduled' && now > start + settings()['sessions.late_teacher_min'] * MIN)
    out.push('late');
  if (
    s.activatedAt &&
    Date.parse(s.activatedAt) - start > settings()['sessions.late_teacher_min'] * MIN
  )
    out.push('late_activation');
  if (reportMissing(s, now)) out.push('report_missing');
  if (s.zoomStatus === 'failed') out.push('zoom_failed');
  if (s.needsReview) out.push('needs_review');
  if (pendingOf(s).length) out.push('pending_request');
  return out;
}

class Refusal {
  constructor(readonly response: Response) {}
}
const refuse = (
  status: number,
  code: string,
  message: string,
  errors?: Record<string, string[]>,
  data?: Record<string, unknown>,
) => new Refusal(apiError(status, code, message, errors, data));

function canManage(me: MockUser) {
  return me.permissions.includes('sessions.manage');
}
function isOwnTeacher(me: MockUser, s: SessionRow) {
  return me.permissions.includes('sessions.conduct') && ownTeacherId(me) === s.teacherId;
}

const FROM: Record<SessionAction, SessionStage[]> = {
  activate: ['scheduled'],
  undo_activate: ['activated', 'in_progress'],
  start: ['activated'],
  end: ['activated', 'in_progress'],
  mark_absent: ['activated'],
  mark_declined: ['activated', 'in_progress'],
  mark_leave: ['scheduled', 'activated'],
  cancel: ['scheduled'],
  undo_mark: ['absent', 'declined', 'leave', 'taken'],
  revert: ['ended', 'taken', 'absent', 'declined', 'leave', 'cancelled', 'moved_out'],
};
const TARGET: Partial<Record<SessionAction, SessionStage>> = {
  activate: 'activated',
  undo_activate: 'scheduled',
  start: 'in_progress',
  end: 'ended',
  mark_absent: 'absent',
  mark_declined: 'declined',
  mark_leave: 'leave',
  cancel: 'cancelled',
  revert: 'scheduled',
};
const EVENT: Record<SessionAction, string> = {
  activate: 'activated',
  undo_activate: 'activation_undone',
  start: 'started',
  end: 'ended',
  mark_absent: 'marked',
  mark_declined: 'marked',
  mark_leave: 'marked',
  cancel: 'cancelled',
  undo_mark: 'reverted',
  revert: 'reverted',
};

type Input = {
  reason?: string;
  note?: string;
  notifiedAt?: string;
  stageReason?: string;
  override?: boolean;
};

/** The state machine guard (apps/api state-machine.ts): throws a Refusal when not allowed now. */
function guardAction(
  s: SessionRow,
  action: SessionAction,
  me: MockUser,
  input: Input,
  dry: boolean,
) {
  if (!FROM[action].includes(s.stage))
    throw refuse(409, 'invalid_transition', 'Not allowed from this stage.');
  const st = settings();
  const now = nowMs();
  const manage = canManage(me);
  const conduct = manage || isOwnTeacher(me, s);
  const override = manage && !!input.override;
  const start = Date.parse(s.startsAt);
  const end = start + s.durationMinutes * MIN;
  const forbidden = () => refuse(403, 'forbidden', 'Forbidden.');
  const need = (value: string | undefined, field: string) => {
    if (!value?.trim())
      throw refuse(422, 'validation_failed', 'The given data was invalid.', {
        [field]: ['This field is required.'],
      });
  };
  switch (action) {
    case 'activate': {
      if (!conduct) throw forbidden();
      const opens = start - st['sessions.activation_window_before_min'] * MIN;
      const closes = end + st['sessions.activation_window_after_min'] * MIN;
      if ((now < opens || now > closes) && !(manage && dry) && !override) {
        throw refuse(422, 'outside_window', 'Outside the time window.', {
          availableFrom: [iso(opens)],
          availableUntil: [iso(closes)],
        });
      }
      if (override && !dry) need(input.reason, 'reason');
      if (
        sdb.sessions.some(
          (x) =>
            x.id !== s.id &&
            x.teacherId === s.teacherId &&
            (x.stage === 'activated' || x.stage === 'in_progress'),
        )
      ) {
        throw refuse(409, 'invalid_transition', 'The teacher already has a running class.', {
          teacher: ['The teacher already has a running class.'],
        });
      }
      break;
    }
    case 'undo_activate': {
      if (!conduct) throw forbidden();
      const limit = s.activatedAt
        ? Date.parse(s.activatedAt) + st['sessions.undo_activation_min'] * MIN
        : 0;
      if (!manage && now > limit) throw refuse(422, 'outside_window', 'Outside the time window.');
      break;
    }
    case 'start':
      if (!conduct) throw forbidden();
      break;
    case 'mark_declined':
      if (!conduct) throw forbidden();
      if (!dry) need(input.note, 'note');
      break;
    case 'end': {
      if (!conduct) throw forbidden();
      const minEnd =
        Date.parse(s.activatedAt ?? s.startsAt) + st['sessions.min_duration_min'] * MIN;
      if (now < minEnd) {
        if (!manage)
          throw refuse(422, 'outside_window', 'Too early.', { availableFrom: [iso(minEnd)] });
        if (!dry) need(input.reason, 'reason');
      }
      break;
    }
    case 'mark_absent': {
      if (!conduct) throw forbidden();
      const from = start + st['sessions.absent_min_wait_min'] * MIN;
      if (now < from && !override)
        throw refuse(422, 'outside_window', 'Too early.', { availableFrom: [iso(from)] });
      if (!dry) need(input.note, 'note');
      break;
    }
    case 'mark_leave': {
      if (!conduct) throw forbidden();
      const reason = input.stageReason ?? 'student';
      if (
        !(LEAVE_REASONS as readonly string[]).includes(reason) ||
        (reason === 'teacher' && !manage)
      ) {
        throw refuse(422, 'validation_failed', 'The given data was invalid.', {
          stageReason: ['The selected stage reason is invalid.'],
        });
      }
      if (!manage && !dry) {
        const notified = input.notifiedAt ? Date.parse(input.notifiedAt) : now;
        const hours = st['sessions.leave_notice_hours'];
        if (notified > start - hours * 3_600_000 || notified > now) {
          throw refuse(422, 'outside_window', 'Too late for a leave.', {
            notifiedAt: [`A leave needs at least ${hours} hours' notice before the class.`],
          });
        }
      }
      break;
    }
    case 'cancel':
      if (!manage) throw forbidden();
      if (!dry && !(CANCEL_REASONS as readonly string[]).includes(input.stageReason ?? '')) {
        throw refuse(422, 'validation_failed', 'The given data was invalid.', {
          stageReason: ['The selected stage reason is invalid.'],
        });
      }
      break;
    case 'undo_mark':
      if (s.markedBy !== me.id || !s.markedAt || Date.parse(s.markedAt) < now - 2 * MIN) {
        throw refuse(409, 'invalid_transition', 'Nothing to undo.');
      }
      break;
    case 'revert':
      if (!manage) throw forbidden();
      if (!dry) need(input.reason, 'reason');
      break;
  }
}

function allowedActions(s: SessionRow, me: MockUser): string[] {
  if (s.deleted) return [];
  const out: string[] = [];
  for (const action of SESSION_ACTIONS) {
    try {
      guardAction(s, action, me, {}, true);
      out.push(action);
    } catch {
      // not allowed now
    }
  }
  const conduct = canManage(me) || isOwnTeacher(me, s);
  if (s.stage === 'ended' && conduct) out.push('submit_report');
  if (s.stage === 'taken' && conduct) {
    const until = editableUntil(s);
    if (canManage(me) || (until && nowMs() <= Date.parse(until))) out.push('submit_report');
  }
  return out;
}

function upcomingActions(s: SessionRow, me: MockUser) {
  if (!(canManage(me) || isOwnTeacher(me, s))) return [];
  const st = settings();
  const at: [string, number][] = [];
  if (s.stage === 'scheduled')
    at.push([
      'activate',
      Date.parse(s.startsAt) - st['sessions.activation_window_before_min'] * MIN,
    ]);
  if ((s.stage === 'activated' || s.stage === 'in_progress') && !canManage(me)) {
    at.push([
      'end',
      Date.parse(s.activatedAt ?? s.startsAt) + st['sessions.min_duration_min'] * MIN,
    ]);
  }
  if (s.stage === 'activated')
    at.push(['mark_absent', Date.parse(s.startsAt) + st['sessions.absent_min_wait_min'] * MIN]);
  return at.filter(([, t]) => t > nowMs()).map(([action, t]) => ({ action, availableAt: iso(t) }));
}

export function presentSession(s: SessionRow, me: MockUser): SessionDto {
  const student = studentOf(s.studentId)!;
  const teacher = teacherOf(s.teacherId)!;
  const course = COURSES.find((c) => c.id === s.courseId)!;
  const start = Date.parse(s.startsAt);
  const terminal = (TERMINAL_STAGES as readonly string[]).includes(s.stage);
  const hasLink = s.zoomStatus === 'ready' || s.zoomStatus === 'external';
  return {
    id: s.id,
    kind: s.kind,
    stage: s.deleted ? 'cancelled' : s.stage,
    stageReason: s.stageReason,
    startsAt: s.startsAt,
    endsAt: endsAt(s),
    durationMinutes: s.durationMinutes,
    occurrenceDate: s.occurrenceDate,
    source: s.source,
    isDetached: s.isDetached,
    student: {
      id: student.id,
      name: student.name,
      timezone: familyTz(student.id),
      familyId: student.familyId,
    },
    teacher: {
      id: teacher.id,
      name: teacher.name,
      timezone: teacher.timezone,
      ...(canManage(me) ? { phone: teacher.phone } : {}),
    },
    course: { id: course.id, nameAr: course.nameAr, nameEn: course.nameEn },
    enrollmentId: s.enrollmentId,
    scheduleSlotId: s.scheduleSlotId,
    originSessionId: s.originSessionId,
    times: {
      activatedAt: s.activatedAt,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      markedAt: s.markedAt,
    },
    latenessMinutes: s.activatedAt
      ? Math.max(0, Math.round((Date.parse(s.activatedAt) - start) / MIN))
      : 0,
    zoom: {
      status: s.zoomStatus,
      joinAvailable:
        hasLink && !terminal && nowMs() >= start - 60 * MIN && nowMs() <= Date.parse(endsAt(s)),
    },
    evidence: {
      actualStartedAt: s.activatedAt,
      teacherJoinedAt: s.teacherJoinedAt,
      studentJoinedAt: s.studentJoinedAt,
    },
    report: { submitted: !!reportOf(s.id), editableUntil: editableUntil(s) },
    attention: attention(s),
    pendingRequests: pendingOf(s).map((r) => ({ id: r.id, type: r.type })),
    allowedActions: allowedActions(s, me),
    upcomingActions: upcomingActions(s, me),
    needsReview: s.needsReview,
    reviewReason: s.reviewReason,
    lockVersion: s.lockVersion,
    updatedAt: s.updatedAt,
  };
}

export function touch(s: SessionRow) {
  s.lockVersion += 1;
  s.updatedAt = iso(nowMs());
}

// ------------------------------------------------------------------ slots + conflicts

function nextOn(fromKey: string, weekday: number): string {
  let key = fromKey;
  while (isoWeekday(key) !== weekday) key = addDays(key, 1);
  return key;
}

/** UTC minute of the week of a weekly time, taking its next occurrence from `ref`. */
function minuteOfWeek(weekday: number, time: string, tz: string, ref: string): number {
  const at = new Date(zonedInstant(nextOn(ref, weekday), time, tz));
  return ((at.getUTCDay() + 6) % 7) * 1440 + at.getUTCHours() * 60 + at.getUTCMinutes();
}
function weeklyOverlap(a: number, aLen: number, b: number, bLen: number) {
  const W = 10_080;
  const d = (((b - a) % W) + W) % W;
  return d < aLen || W - d < bLen;
}

function teacherLocalOf(
  slot: Pick<SlotRow, 'weekday' | 'localStartTime' | 'timezone'>,
  teacherTz: string,
) {
  const today = dateKeyIn(slot.timezone, new Date());
  const at = zonedInstant(nextOn(today, slot.weekday), slot.localStartTime, slot.timezone);
  const year = Number(today.slice(0, 4));
  const local = (ref: string) =>
    hhmmIn(zonedInstant(nextOn(ref, slot.weekday), slot.localStartTime, slot.timezone), teacherTz);
  return {
    timezone: teacherTz,
    weekday: isoWeekday(dateKeyIn(teacherTz, new Date(at))),
    time: hhmmIn(at, teacherTz),
    variesWithDst: local(`${year}-01-10`) !== local(`${year}-07-10`),
  };
}

export function presentSlot(slot: SlotRow, label?: string): ScheduleSlotDto {
  const teacher = teacherOf(slot.teacherId)!;
  return {
    ...slot,
    teacherLocal: teacherLocalOf(slot, teacher.timezone),
    ...(label ? { label } : {}),
  };
}

function liveSlots(at: string) {
  return sdb.slots.filter(
    (s) => s.validFrom <= addDays(at, 400) && (!s.validTo || s.validTo >= at),
  );
}

function presentEnrollment(e: EnrollmentRow, me: MockUser): EnrollmentDto {
  const today = dateKeyIn(e.timezone, new Date());
  const slots = sdb.slots
    .filter((s) => s.enrollmentId === e.id && (!s.validTo || s.validTo >= today))
    .sort((a, b) => a.weekday - b.weekday || a.localStartTime.localeCompare(b.localStartTime))
    .map((s) => presentSlot(s));
  const manage = me.permissions.includes('schedule.manage');
  return {
    ...e,
    ...(manage ? {} : { externalMeetingUrl: undefined, notes: undefined }),
    slots,
  };
}

function inWorkHours(teacherId: number, at: string) {
  const hours = sdb.workHours.get(teacherId);
  if (!hours?.length) return true;
  const teacher = teacherOf(teacherId)!;
  const wd = isoWeekday(dateKeyIn(teacher.timezone, new Date(at)));
  const t = hhmmIn(at, teacher.timezone);
  return hours.some(
    (h) =>
      h.weekday === wd &&
      h.localStartTime <= t &&
      (h.localEndTime > t || h.localEndTime < h.localStartTime),
  );
}

function conflict(
  code: string,
  severity: 'hard' | 'soft',
  message: string,
  w: ConflictDto['with'] = null,
  firstDate: string | null = null,
): ConflictDto {
  return { code, severity, message, with: w, firstDate };
}

/** A weekly slot against the teacher's and student's other weekly times. */
function checkSlot(input: {
  studentId: number;
  teacherId: number;
  weekday: number;
  localStartTime: string;
  durationMinutes: number;
  timezone: string;
  validFrom?: string;
  excludeSlotId?: number;
}) {
  const ref = input.validFrom ?? dateKeyIn(input.timezone, new Date());
  const mine = minuteOfWeek(input.weekday, input.localStartTime, input.timezone, ref);
  const conflicts: ConflictDto[] = [];
  const warnings: ConflictDto[] = [];
  const teacher = teacherOf(input.teacherId);
  if (!teacher || teacher.status.value !== 'active')
    conflicts.push(conflict('teacher_inactive', 'hard', 'The teacher is inactive.'));
  for (const slot of liveSlots(ref)) {
    if (slot.id === input.excludeSlotId) continue;
    const e = sdb.enrollments.find((x) => x.id === slot.enrollmentId)!;
    if (e.status === 'ended') continue;
    const other = minuteOfWeek(slot.weekday, slot.localStartTime, slot.timezone, ref);
    if (!weeklyOverlap(mine, input.durationMinutes, other, slot.durationMinutes)) continue;
    const label = `${e.student.name} — ${e.course.nameEn}`;
    if (slot.teacherId === input.teacherId) {
      conflicts.push(
        conflict(
          'teacher_overlap',
          'hard',
          'Overlaps another class of the teacher.',
          { type: 'slot', id: slot.id, label },
          ref,
        ),
      );
    } else if (e.student.id === input.studentId) {
      conflicts.push(
        conflict(
          'student_overlap',
          'hard',
          'Overlaps another class of the student.',
          { type: 'slot', id: slot.id, label },
          ref,
        ),
      );
    }
  }
  const occurrence = zonedInstant(nextOn(ref, input.weekday), input.localStartTime, input.timezone);
  for (const b of sdb.blocks) {
    if (
      b.teacherId !== input.teacherId ||
      b.kind !== 'recurring' ||
      !b.weekday ||
      !b.localStartTime
    )
      continue;
    const other = minuteOfWeek(
      b.weekday,
      b.localStartTime,
      b.timezone ?? teacher?.timezone ?? 'UTC',
      ref,
    );
    if (weeklyOverlap(mine, input.durationMinutes, other, b.durationMinutes ?? 0)) {
      conflicts.push(
        conflict(
          'teacher_blocked',
          'hard',
          'The teacher blocked this time.',
          { type: 'block', id: b.id, label: b.note },
          ref,
        ),
      );
    }
  }
  if (!inWorkHours(input.teacherId, occurrence)) {
    warnings.push(
      conflict(
        'outside_work_hours',
        'soft',
        'Outside the teacher’s work hours.',
        { type: 'teacher', id: input.teacherId },
        ref,
      ),
    );
  }
  if (teacher && teacherLocalOf(input, teacher.timezone).variesWithDst) {
    warnings.push(
      conflict('dst_shift', 'soft', 'The teacher’s local time changes with DST.', null, ref),
    );
  }
  return { conflicts, warnings };
}

/** One class time against the teacher's and student's classes, holidays and work hours. */
function checkSingle(input: {
  studentId: number;
  teacherId: number;
  startsAt: string;
  durationMinutes: number;
  excludeSessionId?: number;
}) {
  const conflicts: ConflictDto[] = [];
  const warnings: ConflictDto[] = [];
  const start = Date.parse(input.startsAt);
  const end = start + input.durationMinutes * MIN;
  if (start < nowMs()) conflicts.push(conflict('past_time', 'hard', 'The time is in the past.'));
  const occupying = [
    'scheduled',
    'activated',
    'in_progress',
    'ended',
    'taken',
    'absent',
    'declined',
  ];
  for (const s of sdb.sessions) {
    if (s.deleted || s.id === input.excludeSessionId || !occupying.includes(s.stage)) continue;
    const a = Date.parse(s.startsAt);
    const b = a + s.durationMinutes * MIN;
    if (a >= end || b <= start) continue;
    const label = `${studentOf(s.studentId)?.name ?? ''}`;
    if (s.teacherId === input.teacherId) {
      conflicts.push(
        conflict('teacher_overlap', 'hard', 'Overlaps another class of the teacher.', {
          type: 'session',
          id: s.id,
          startsAt: s.startsAt,
          label,
        }),
      );
    } else if (s.studentId === input.studentId) {
      conflicts.push(
        conflict('student_overlap', 'hard', 'Overlaps another class of the student.', {
          type: 'session',
          id: s.id,
          startsAt: s.startsAt,
          label,
        }),
      );
    }
  }
  const day = dateKeyIn(settings()['academy.timezone'], new Date(start));
  const holiday = sdb.holidays.find((h) => day >= h.date && day <= (h.endsOn ?? h.date));
  if (holiday)
    warnings.push(
      conflict('holiday', 'soft', 'On a public holiday.', {
        type: 'holiday',
        id: holiday.id,
        label: holiday.name,
      }),
    );
  if (!inWorkHours(input.teacherId, input.startsAt)) {
    warnings.push(
      conflict('outside_work_hours', 'soft', 'Outside the teacher’s work hours.', {
        type: 'teacher',
        id: input.teacherId,
      }),
    );
  }
  return { conflicts, warnings };
}

/** 409 on hard conflicts, 422 until every warning is acknowledged, else null. */
function scheduleRefusal(
  result: { conflicts: ConflictDto[]; warnings: ConflictDto[] },
  ack: string[],
) {
  if (result.conflicts.length) {
    return apiError(
      409,
      'schedule_conflict',
      'The time conflicts with the schedule.',
      undefined,
      result,
    );
  }
  const missing = result.warnings.filter((w) => !ack.includes(w.code));
  if (missing.length) {
    return apiError(
      422,
      'warnings_not_acknowledged',
      'Acknowledge the warnings first.',
      undefined,
      { warnings: result.warnings },
    );
  }
  return null;
}
function merge(results: { conflicts: ConflictDto[]; warnings: ConflictDto[] }[]) {
  const warnings = results
    .flatMap((r) => r.warnings)
    .filter((w, i, all) => all.findIndex((x) => x.code === w.code) === i);
  return { conflicts: results.flatMap((r) => r.conflicts), warnings };
}

function horizonFor(tz: string) {
  const today = dateKeyIn(tz, new Date());
  return { from: today, to: addDays(today, settings()['sessions.horizon_days']) };
}

/** Removes future untouched generated classes of a slot from a date (they are re-made). */
function dropFuture(slotId: number, fromKey: string) {
  const now = nowMs();
  for (const s of sdb.sessions) {
    if (s.scheduleSlotId !== slotId || s.deleted || s.isDetached || s.stage !== 'scheduled')
      continue;
    if ((s.occurrenceDate ?? '') >= fromKey && Date.parse(s.startsAt) > now) {
      s.deleted = true;
      touch(s);
    }
  }
}
function fillSlot(slot: SlotRow) {
  const e = sdb.enrollments.find((x) => x.id === slot.enrollmentId)!;
  const { from, to } = horizonFor(slot.timezone);
  const made = generateFor(slot, e, from, to).filter((s) => Date.parse(s.startsAt) > nowMs());
  for (const s of made) addEvent(s.id, 'generated', null, s.stage, null);
  sdb.sessions.push(...made);
}
function affectedManual(enrollmentId: number, me: MockUser) {
  return sdb.sessions
    .filter(
      (s) =>
        s.enrollmentId === enrollmentId &&
        !s.deleted &&
        s.isDetached &&
        s.stage === 'scheduled' &&
        Date.parse(s.startsAt) > nowMs(),
    )
    .map((s) => presentSession(s, me));
}

// ------------------------------------------------------------------ requests

export function presentRequest(r: RequestRow, me: MockUser, withSession = true): SessionRequestDto {
  const s = sdb.sessions.find((x) => x.id === r.sessionId)!;
  const student = studentOf(s.studentId);
  const actions: SessionRequestDto['allowedActions'] = [];
  if (r.status === 'pending') {
    if (me.permissions.includes('session_requests.approve')) actions.push('approve', 'reject');
    if (r.requestedBy.id === me.id) actions.push('cancel');
  }
  return {
    ...r,
    session: withSession ? presentSession(s, me) : undefined,
    student: student ? { id: student.id, name: student.name } : null,
    allowedActions: actions,
    dueAt: r.status === 'pending' ? s.startsAt : null,
  };
}

export function seesRequest(me: MockUser, r: RequestRow) {
  const s = sdb.sessions.find((x) => x.id === r.sessionId);
  return !!s && seesSession(me, s);
}

/** Applies an approved request to the class (leave, move, or a new class). */
function applyRequest(r: RequestRow, me: MockUser | null, startsAt?: string, teacherId?: number) {
  const s = sdb.sessions.find((x) => x.id === r.sessionId)!;
  const actor = me ? { id: me.id, name: me.name, role: me.role?.name ?? null } : null;
  if (r.type === 'leave') {
    const from = s.stage;
    s.stage = 'leave';
    s.stageReason = r.requestedBy.role === 'teacher' ? 'teacher' : 'student';
    s.markedAt = iso(nowMs());
    touch(s);
    addEvent(s.id, 'marked', from, 'leave', actor, { requestId: r.id });
    return;
  }
  const at = startsAt ?? r.proposedStartsAt!;
  const made: SessionRow = {
    ...s,
    id: sdb.nextId.session++,
    kind: r.type === 'extra' ? 'extra' : r.type === 'advance' ? 'advance' : 'rescheduled',
    stage: 'scheduled',
    stageReason: null,
    startsAt: at,
    durationMinutes: r.proposedDurationMinutes ?? s.durationMinutes,
    occurrenceDate: null,
    source: 'request',
    isDetached: true,
    teacherId: teacherId ?? r.proposedTeacherId ?? s.teacherId,
    scheduleSlotId: null,
    originSessionId: s.id,
    activatedAt: null,
    startedAt: null,
    endedAt: null,
    markedAt: null,
    markedBy: null,
    markedFrom: null,
    lockVersion: 0,
    updatedAt: iso(nowMs()),
  };
  sdb.sessions.push(made);
  addEvent(made.id, 'created', null, 'scheduled', actor, { requestId: r.id });
  r.resultSessionId = made.id;
  if (r.type !== 'extra') {
    const from = s.stage;
    s.stage = 'moved_out';
    s.stageReason = r.type === 'advance' ? 'advanced' : 'rescheduled';
    touch(s);
    addEvent(s.id, 'moved_out', from, 'moved_out', actor, { requestId: r.id, to: made.id });
  }
}

// ------------------------------------------------------------------ handlers

const enrollmentOr404 = (id: string, me: MockUser) => {
  const e = sdb.enrollments.find((x) => x.id === Number(id));
  return e && seesEnrollment(me, e) ? e : null;
};
export const sessionOr404 = (id: string, me: MockUser) => {
  const s = sdb.sessions.find((x) => x.id === Number(id) && !x.deleted);
  return s && seesSession(me, s) ? s : null;
};
const teacherAllowed = (me: MockUser, teacherId: number) =>
  !isParent(me) && (!isTeacher(me) || ownTeacherId(me) === teacherId);

export function paginate<T>(
  rows: T[],
  page: number,
  perPage: number,
  counts: Record<string, number>,
) {
  const total = rows.length;
  return {
    data: rows.slice((page - 1) * perPage, page * perPage),
    meta: { page, perPage, total, lastPage: Math.max(1, Math.ceil(total / perPage)), counts },
  };
}

export const scheduleHandlers: HttpHandler[] = [
  // ---------------------------------------------------------------- enrollments
  http.get(`${API}/enrollments`, ({ request }) => {
    const g = guardAny(request, 'schedule.view', 'sessions.conduct');
    if ('error' in g) return g.error;
    const parsed = enrollmentListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const text = q.q?.toLowerCase();
    const base = sdb.enrollments.filter(
      (e) =>
        seesEnrollment(g.me, e) &&
        (!q.studentId || e.student.id === q.studentId) &&
        (!q.teacherId || e.teacher.id === q.teacherId) &&
        (!q.courseId || e.course.id === q.courseId) &&
        (!text ||
          e.student.name.toLowerCase().includes(text) ||
          e.teacher.name.toLowerCase().includes(text)),
    );
    const counts: Record<string, number> = { all: base.length };
    for (const s of ENROLLMENT_STATUSES) counts[s] = base.filter((e) => e.status === s).length;
    const rows = (q.status ? base.filter((e) => e.status === q.status) : base).sort(
      (a, b) => b.id - a.id,
    );
    const page = paginate(rows, q.page, q.perPage, counts);
    return HttpResponse.json({ ...page, data: page.data.map((e) => presentEnrollment(e, g.me)) });
  }),

  http.get(`${API}/enrollments/:id`, ({ request, params }) => {
    const g = guardAny(request, 'schedule.view', 'sessions.conduct');
    if ('error' in g) return g.error;
    const e = enrollmentOr404(params.id as string, g.me);
    if (!e) return notFound();
    const upcoming = sdb.sessions
      .filter(
        (s) =>
          s.enrollmentId === e.id && !s.deleted && Date.parse(s.startsAt) > nowMs() - 3_600_000,
      )
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .slice(0, 20)
      .map((s) => presentSession(s, g.me));
    return HttpResponse.json({
      data: { ...presentEnrollment(e, g.me), upcomingSessions: upcoming },
    });
  }),

  http.post(`${API}/enrollments`, async ({ request }) => {
    const g = guard(request, 'schedule.manage');
    if ('error' in g) return g.error;
    const parsed = createEnrollmentSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    const student = studentOf(input.studentId);
    const teacher = teacherOf(input.teacherId);
    const course = COURSES.find((c) => c.id === input.courseId);
    if (!student)
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        studentId: ['The selected student id is invalid.'],
      });
    if (!teacher)
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        teacherId: ['The selected teacher id is invalid.'],
      });
    if (!course)
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        courseId: ['The selected course id is invalid.'],
      });
    if (
      sdb.enrollments.some(
        (e) => e.student.id === student.id && e.course.id === course.id && e.status !== 'ended',
      )
    ) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        courseId: ['The student already has a live enrollment in this course.'],
      });
    }
    const tz = input.timezone ?? familyTz(student.id);
    const minutes = input.sessionMinutes ?? 30;
    const result = merge(
      input.slots.map((s) =>
        checkSlot({
          studentId: student.id,
          teacherId: teacher.id,
          weekday: s.weekday,
          localStartTime: s.localStartTime,
          durationMinutes: s.durationMinutes ?? minutes,
          timezone: tz,
          validFrom: input.startsOn,
        }),
      ),
    );
    const refusal = scheduleRefusal(result, input.acknowledgeWarnings);
    if (refusal) return refusal;
    const e: EnrollmentRow = {
      id: sdb.nextId.enrollment++,
      student: {
        id: student.id,
        name: student.name,
        timezone: familyTz(student.id),
        familyId: student.familyId,
      },
      course: { id: course.id, nameAr: course.nameAr, nameEn: course.nameEn },
      teacher: { id: teacher.id, name: teacher.name, timezone: teacher.timezone },
      kind: input.kind,
      status: 'active',
      pausedReason: null,
      startsOn: input.startsOn,
      endsOn: null,
      sessionMinutes: minutes,
      timezone: tz,
      meetingMode: input.meetingMode,
      externalMeetingUrl: input.externalMeetingUrl ?? null,
      notes: input.notes ?? null,
      createdAt: iso(nowMs()),
    };
    sdb.enrollments.push(e);
    for (const s of input.slots) {
      const slot: SlotRow = {
        id: sdb.nextId.slot++,
        enrollmentId: e.id,
        teacherId: teacher.id,
        weekday: s.weekday,
        localStartTime: s.localStartTime,
        durationMinutes: s.durationMinutes ?? minutes,
        timezone: tz,
        validFrom: input.startsOn,
        validTo: null,
      };
      sdb.slots.push(slot);
      fillSlot(slot);
    }
    return HttpResponse.json({ data: presentEnrollment(e, g.me) }, { status: 201 });
  }),

  http.patch(`${API}/enrollments/:id`, async ({ request, params }) => {
    const g = guard(request, 'schedule.manage');
    if ('error' in g) return g.error;
    const e = enrollmentOr404(params.id as string, g.me);
    if (!e) return notFound();
    if (e.status === 'ended') return apiError(409, 'conflict', 'The enrollment has ended.');
    const parsed = updateEnrollmentSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    if (input.teacherId && input.teacherId !== e.teacher.id) {
      const teacher = teacherOf(input.teacherId);
      if (!teacher)
        return apiError(422, 'validation_failed', 'The given data was invalid.', {
          teacherId: ['The selected teacher id is invalid.'],
        });
      const from = input.effectiveFrom ?? dateKeyIn(e.timezone, new Date());
      const live = sdb.slots.filter(
        (s) => s.enrollmentId === e.id && (!s.validTo || s.validTo >= from),
      );
      const result = merge(
        live.map((s) =>
          checkSlot({
            studentId: e.student.id,
            teacherId: teacher.id,
            weekday: s.weekday,
            localStartTime: s.localStartTime,
            durationMinutes: s.durationMinutes,
            timezone: s.timezone,
            validFrom: from,
            excludeSlotId: s.id,
          }),
        ),
      );
      const refusal = scheduleRefusal(result, input.acknowledgeWarnings);
      if (refusal) return refusal;
      for (const s of live) {
        s.validTo = addDays(from, -1);
        dropFuture(s.id, from);
        const next: SlotRow = {
          ...s,
          id: sdb.nextId.slot++,
          teacherId: teacher.id,
          validFrom: from,
          validTo: null,
        };
        sdb.slots.push(next);
        fillSlot(next);
      }
      e.teacher = { id: teacher.id, name: teacher.name, timezone: teacher.timezone };
    }
    if (input.sessionMinutes) e.sessionMinutes = input.sessionMinutes;
    if (input.timezone) e.timezone = input.timezone;
    if (input.meetingMode) e.meetingMode = input.meetingMode;
    if (input.externalMeetingUrl !== undefined) e.externalMeetingUrl = input.externalMeetingUrl;
    if (input.meetingMode === 'zoom') e.externalMeetingUrl = null;
    if (input.notes !== undefined) e.notes = input.notes;
    return HttpResponse.json({
      data: presentEnrollment(e, g.me),
      affectedManualSessions: affectedManual(e.id, g.me),
    });
  }),

  ...(['pause', 'resume', 'end'] as const).map((action) =>
    http.post(`${API}/enrollments/:id/${action}`, async ({ request, params }) => {
      const g = guard(request, 'schedule.manage');
      if ('error' in g) return g.error;
      const e = enrollmentOr404(params.id as string, g.me);
      if (!e) return notFound();
      if (e.status === 'ended') return apiError(409, 'conflict', 'The enrollment has ended.');
      const raw = await body(request);
      const future = sdb.sessions.filter(
        (s) => s.enrollmentId === e.id && !s.deleted && Date.parse(s.startsAt) > nowMs(),
      );
      if (action === 'pause') {
        const parsed = pauseEnrollmentSchema.safeParse(raw);
        if (!parsed.success) return validationFailed(parsed.error.issues);
        if (e.status === 'paused') return apiError(422, 'same_status', 'Already paused.');
        e.status = 'paused';
        e.pausedReason = parsed.data.reason;
        for (const s of future.filter((x) => x.stage === 'scheduled')) {
          s.stage = 'cancelled';
          s.stageReason = parsed.data.reason === 'admin' ? 'admin' : parsed.data.reason;
          touch(s);
          addEvent(s.id, 'cancelled', 'scheduled', 'cancelled', null, { reason: s.stageReason });
        }
      } else if (action === 'resume') {
        if (e.status !== 'paused') return apiError(422, 'same_status', 'Not paused.');
        e.status = 'active';
        e.pausedReason = null;
        for (const s of future.filter(
          (x) => x.stage === 'cancelled' && x.stageReason !== 'holiday',
        )) {
          s.stage = 'scheduled';
          s.stageReason = null;
          touch(s);
          addEvent(s.id, 'restored', 'cancelled', 'scheduled', null);
        }
      } else {
        const parsed = endEnrollmentSchema.safeParse(raw);
        if (!parsed.success) return validationFailed(parsed.error.issues);
        e.status = 'ended';
        e.endsOn = parsed.data.endsOn;
        for (const slot of sdb.slots.filter(
          (s) => s.enrollmentId === e.id && (!s.validTo || s.validTo > parsed.data.endsOn),
        )) {
          slot.validTo = parsed.data.endsOn;
        }
        for (const s of future.filter(
          (x) =>
            (x.occurrenceDate ?? dateKeyIn(e.timezone, new Date(x.startsAt))) > parsed.data.endsOn,
        )) {
          s.deleted = true;
          touch(s);
        }
      }
      return HttpResponse.json({ data: presentEnrollment(e, g.me) });
    }),
  ),

  http.post(`${API}/enrollments/:id/slots`, async ({ request, params }) => {
    const g = guard(request, 'schedule.manage');
    if ('error' in g) return g.error;
    const e = enrollmentOr404(params.id as string, g.me);
    if (!e) return notFound();
    if (e.status === 'ended') return apiError(409, 'conflict', 'The enrollment has ended.');
    const parsed = addSlotSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    const validFrom = input.validFrom ?? [e.startsOn, dateKeyIn(e.timezone, new Date())].sort()[1]!;
    const duration = input.durationMinutes ?? e.sessionMinutes;
    const result = checkSlot({
      studentId: e.student.id,
      teacherId: e.teacher.id,
      weekday: input.weekday,
      localStartTime: input.localStartTime,
      durationMinutes: duration,
      timezone: e.timezone,
      validFrom,
    });
    const refusal = scheduleRefusal(result, input.acknowledgeWarnings);
    if (refusal) return refusal;
    const slot: SlotRow = {
      id: sdb.nextId.slot++,
      enrollmentId: e.id,
      teacherId: e.teacher.id,
      weekday: input.weekday,
      localStartTime: input.localStartTime,
      durationMinutes: duration,
      timezone: e.timezone,
      validFrom,
      validTo: null,
    };
    sdb.slots.push(slot);
    fillSlot(slot);
    return HttpResponse.json({ data: presentSlot(slot) }, { status: 201 });
  }),

  http.patch(`${API}/schedule-slots/:id`, async ({ request, params }) => {
    const g = guard(request, 'schedule.manage');
    if ('error' in g) return g.error;
    const slot = sdb.slots.find((s) => s.id === Number(params.id));
    if (!slot) return notFound();
    const e = sdb.enrollments.find((x) => x.id === slot.enrollmentId)!;
    const parsed = updateSlotSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    const next: SlotRow = {
      ...slot,
      id: sdb.nextId.slot++,
      weekday: input.weekday ?? slot.weekday,
      localStartTime: input.localStartTime ?? slot.localStartTime,
      durationMinutes: input.durationMinutes ?? slot.durationMinutes,
      validFrom: input.effectiveFrom,
      validTo: null,
    };
    const result = checkSlot({
      studentId: e.student.id,
      teacherId: next.teacherId,
      weekday: next.weekday,
      localStartTime: next.localStartTime,
      durationMinutes: next.durationMinutes,
      timezone: next.timezone,
      validFrom: next.validFrom,
      excludeSlotId: slot.id,
    });
    const refusal = scheduleRefusal(result, input.acknowledgeWarnings);
    if (refusal) return refusal;
    slot.validTo = addDays(input.effectiveFrom, -1);
    dropFuture(slot.id, input.effectiveFrom);
    sdb.slots.push(next);
    fillSlot(next);
    return HttpResponse.json({
      data: presentSlot(next),
      affectedManualSessions: affectedManual(e.id, g.me),
    });
  }),

  http.post(`${API}/schedule-slots/:id/end`, async ({ request, params }) => {
    const g = guard(request, 'schedule.manage');
    if ('error' in g) return g.error;
    const slot = sdb.slots.find((s) => s.id === Number(params.id));
    if (!slot) return notFound();
    const parsed = endSlotSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    slot.validTo = parsed.data.validTo;
    dropFuture(slot.id, addDays(parsed.data.validTo, 1));
    return HttpResponse.json({ data: presentSlot(slot) });
  }),

  // ---------------------------------------------------------------- availability + check
  http.get(`${API}/schedule/availability`, ({ request }) => {
    const g = guard(request, 'schedule.view');
    if ('error' in g) return g.error;
    if (isTeacher(g.me) || isParent(g.me)) return apiError(403, 'forbidden', 'Forbidden.');
    const parsed = availabilityQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const tz = q.timezone ?? familyTz(q.studentId!);
    const step = q.stepMinutes ?? 30;
    const ref = q.effectiveFrom ?? dateKeyIn(tz, new Date());
    const [fh, fm] = q.fromTime.split(':').map(Number);
    const [th, tm] = q.toTime.split(':').map(Number);
    const teachers = people.teachers.filter(
      (t) =>
        t.status.value === 'active' &&
        !t.archive &&
        (!q.courseId || t.courses.some((c) => c.id === q.courseId)) &&
        (!q.gender || t.gender === q.gender) &&
        (!q.teacherIds || q.teacherIds.includes(t.id)),
    );
    const out = teachers.map((t) => {
      const free: {
        weekday: number;
        localStartTime: string;
        teacherLocal: { weekday: number; time: string };
        inWorkHours: boolean;
        dstNote: string | null;
      }[] = [];
      for (const weekday of q.weekdays) {
        for (let m = fh! * 60 + fm!; m + q.durationMinutes <= th! * 60 + tm!; m += step) {
          const time = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
          const r = checkSlot({
            studentId: q.studentId ?? -1,
            teacherId: t.id,
            weekday,
            localStartTime: time,
            durationMinutes: q.durationMinutes,
            timezone: tz,
            validFrom: ref,
          });
          if (r.conflicts.length) continue;
          const local = teacherLocalOf({ weekday, localStartTime: time, timezone: tz }, t.timezone);
          const working = !r.warnings.some((w) => w.code === 'outside_work_hours');
          if (!working) continue;
          free.push({
            weekday,
            localStartTime: time,
            teacherLocal: { weekday: local.weekday, time: local.time },
            inWorkHours: working,
            dstNote: local.variesWithDst ? `${local.time} / DST` : null,
          });
        }
      }
      const load =
        sdb.slots
          .filter((s) => s.teacherId === t.id && !s.validTo)
          .reduce((sum, s) => sum + s.durationMinutes, 0) / 60;
      return {
        teacher: {
          id: t.id,
          name: t.name,
          timezone: t.timezone,
          gender: t.gender,
          weeklyLoadHours: Math.round(load * 10) / 10,
        },
        matchingWeekdays: new Set(free.map((f) => f.weekday)).size,
        free,
      };
    });
    const teachersOut = out
      .filter((x) => x.free.length && sdb.workHours.get(x.teacher.id)?.length)
      .sort(
        (a, b) =>
          b.matchingWeekdays - a.matchingWeekdays ||
          a.teacher.weeklyLoadHours - b.teacher.weeklyLoadHours,
      );
    return HttpResponse.json({
      data: {
        timezone: tz,
        teachers: teachersOut,
        workHoursNotSet: teachers
          .filter((t) => !sdb.workHours.get(t.id)?.length)
          .map((t) => ({ id: t.id, name: t.name, timezone: t.timezone })),
        nearest: teachersOut.length
          ? null
          : { weekday: q.weekdays[0]!, localStartTime: '17:00', teacherId: teachers[0]?.id ?? 1 },
      },
    });
  }),

  http.post(`${API}/schedule/check`, async ({ request }) => {
    const g = guard(request, 'schedule.view');
    if ('error' in g) return g.error;
    if (isParent(g.me)) return apiError(403, 'forbidden', 'Forbidden.');
    const parsed = scheduleCheckSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    if ('startsAt' in input) {
      const e = sdb.enrollments.find((x) => x.id === input.enrollmentId);
      if (!e) return notFound();
      return HttpResponse.json({
        data: checkSingle({
          studentId: e.student.id,
          teacherId: input.teacherId ?? e.teacher.id,
          startsAt: input.startsAt,
          durationMinutes: input.durationMinutes,
          excludeSessionId: input.excludeSessionId,
        }),
      });
    }
    const e = input.enrollmentId ? sdb.enrollments.find((x) => x.id === input.enrollmentId) : null;
    return HttpResponse.json({
      data: checkSlot({
        ...input,
        durationMinutes: input.durationMinutes ?? e?.sessionMinutes ?? 30,
      }),
    });
  }),

  // ---------------------------------------------------------------- teacher timetable, blocks, work hours
  http.get(`${API}/teachers/:teacherId/timetable`, ({ request, params }) => {
    const g = guardAny(request, 'schedule.view', 'sessions.conduct');
    if ('error' in g) return g.error;
    const teacher = teacherOf(Number(params.teacherId));
    if (!teacher || !teacherAllowed(g.me, teacher.id)) return notFound();
    const q = queryOf(request);
    const tz = q.tz ?? teacher.timezone;
    const from = q.from ?? weekStart(dateKeyIn(tz, new Date()));
    const to = q.to ?? addDays(from, 6);
    const start = Date.parse(zonedInstant(from, '00:00', tz));
    const end = Date.parse(zonedInstant(addDays(to, 1), '00:00', tz));
    const today = dateKeyIn(teacher.timezone, new Date());
    const slots = sdb.slots
      .filter((s) => s.teacherId === teacher.id && (!s.validTo || s.validTo >= today))
      .filter((s) => sdb.enrollments.find((e) => e.id === s.enrollmentId)?.status !== 'ended')
      .map((s) => {
        const e = sdb.enrollments.find((x) => x.id === s.enrollmentId)!;
        return presentSlot(s, `${e.student.name} — ${e.course.nameEn}`);
      });
    return HttpResponse.json({
      data: {
        teacher: { id: teacher.id, name: teacher.name, timezone: teacher.timezone },
        slots,
        blocks: sdb.blocks.filter((b) => b.teacherId === teacher.id),
        workHours: sdb.workHours.get(teacher.id) ?? [],
        sessions: sdb.sessions
          .filter(
            (s) =>
              s.teacherId === teacher.id &&
              !s.deleted &&
              Date.parse(s.startsAt) >= start &&
              Date.parse(s.startsAt) < end,
          )
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
          .map((s) => presentSession(s, g.me)),
      },
    });
  }),

  http.get(`${API}/teachers/:teacherId/blocks`, ({ request, params }) => {
    const g = guardAny(request, 'schedule.view', 'sessions.conduct');
    if ('error' in g) return g.error;
    const id = Number(params.teacherId);
    if (!teacherOf(id) || !teacherAllowed(g.me, id)) return notFound();
    return HttpResponse.json({ data: sdb.blocks.filter((b) => b.teacherId === id) });
  }),

  http.post(`${API}/teachers/:teacherId/blocks`, async ({ request, params }) => {
    const g = guard(request, 'schedule.manage');
    if ('error' in g) return g.error;
    const teacher = teacherOf(Number(params.teacherId));
    if (!teacher) return notFound();
    const parsed = createTeacherBlockSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    const block = {
      id: sdb.nextId.other++,
      teacherId: teacher.id,
      kind: v.kind,
      reason: v.reason,
      weekday: v.kind === 'recurring' ? (v.weekday ?? null) : null,
      localStartTime: v.kind === 'recurring' ? (v.localStartTime ?? null) : null,
      durationMinutes: v.kind === 'recurring' ? (v.durationMinutes ?? null) : null,
      timezone: v.kind === 'recurring' ? (v.timezone ?? teacher.timezone) : null,
      validFrom: v.validFrom ?? null,
      validTo: v.validTo ?? null,
      startsAt: v.kind === 'one_off' ? (v.startsAt ?? null) : null,
      endsAt: v.kind === 'one_off' ? (v.endsAt ?? null) : null,
      note: v.note ?? null,
    };
    sdb.blocks.push(block);
    return HttpResponse.json({ data: block }, { status: 201 });
  }),

  http.patch(`${API}/teachers/:teacherId/blocks/:blockId`, async ({ request, params }) => {
    const g = guard(request, 'schedule.manage');
    if ('error' in g) return g.error;
    const block = sdb.blocks.find(
      (b) => b.id === Number(params.blockId) && b.teacherId === Number(params.teacherId),
    );
    if (!block) return notFound();
    const parsed = updateTeacherBlockSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    for (const [k, v] of Object.entries(parsed.data))
      if (v !== undefined) (block as Record<string, unknown>)[k] = v;
    return HttpResponse.json({ data: block });
  }),

  http.delete(`${API}/teachers/:teacherId/blocks/:blockId`, ({ request, params }) => {
    const g = guard(request, 'schedule.manage');
    if ('error' in g) return g.error;
    const index = sdb.blocks.findIndex(
      (b) => b.id === Number(params.blockId) && b.teacherId === Number(params.teacherId),
    );
    if (index < 0) return notFound();
    sdb.blocks.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${API}/teachers/:teacherId/work-hours`, ({ request, params }) => {
    const g = guardAny(request, 'schedule.view', 'sessions.conduct');
    if ('error' in g) return g.error;
    const id = Number(params.teacherId);
    if (!teacherOf(id) || !teacherAllowed(g.me, id)) return notFound();
    return HttpResponse.json({ data: sdb.workHours.get(id) ?? [] });
  }),

  http.put(`${API}/teachers/:teacherId/work-hours`, async ({ request, params }) => {
    const g = guardAny(request, 'schedule.manage', 'sessions.conduct');
    if ('error' in g) return g.error;
    const teacher = teacherOf(Number(params.teacherId));
    if (!teacher) return notFound();
    if (!g.me.permissions.includes('schedule.manage') && ownTeacherId(g.me) !== teacher.id) {
      return apiError(403, 'forbidden', 'Forbidden.');
    }
    const parsed = replaceWorkHoursSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const rows = parsed.data.workHours
      .map((w) => ({
        weekday: w.weekday,
        localStartTime: w.localStartTime,
        localEndTime: w.localEndTime,
        timezone: w.timezone ?? teacher.timezone,
      }))
      .sort((a, b) => a.weekday - b.weekday || a.localStartTime.localeCompare(b.localStartTime));
    sdb.workHours.set(teacher.id, rows);
    return HttpResponse.json({ data: rows });
  }),

  // ---------------------------------------------------------------- holidays
  http.get(`${API}/holidays`, ({ request }) => {
    const g = guard(request, 'schedule.view');
    if ('error' in g) return g.error;
    const year = queryOf(request).year;
    return HttpResponse.json({
      data: sdb.holidays
        .filter((h) => !year || h.date.startsWith(year))
        .sort((a, b) => a.date.localeCompare(b.date)),
    });
  }),

  http.post(`${API}/holidays`, async ({ request }) => {
    const g = guard(request, 'schedule.manage');
    if ('error' in g) return g.error;
    const parsed = createHolidaySchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const h = {
      id: sdb.nextId.other++,
      name: parsed.data.name,
      date: parsed.data.date,
      endsOn: parsed.data.endsOn ?? null,
      paid: parsed.data.paid ?? true,
      appliesTo: 'all',
    };
    sdb.holidays.push(h);
    for (const s of sdb.sessions) {
      const day = dateKeyIn(settings()['academy.timezone'], new Date(s.startsAt));
      if (s.stage === 'scheduled' && !s.deleted && day >= h.date && day <= (h.endsOn ?? h.date)) {
        s.stage = 'cancelled';
        s.stageReason = 'holiday';
        touch(s);
        addEvent(s.id, 'cancelled', 'scheduled', 'cancelled', null, { reason: 'holiday' });
      }
    }
    return HttpResponse.json({ data: h }, { status: 201 });
  }),

  http.patch(`${API}/holidays/:id`, async ({ request, params }) => {
    const g = guard(request, 'schedule.manage');
    if ('error' in g) return g.error;
    const h = sdb.holidays.find((x) => x.id === Number(params.id));
    if (!h) return notFound();
    const parsed = updateHolidaySchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    Object.assign(
      h,
      Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)),
    );
    return HttpResponse.json({ data: h });
  }),

  http.delete(`${API}/holidays/:id`, ({ request, params }) => {
    const g = guard(request, 'schedule.manage');
    if ('error' in g) return g.error;
    const index = sdb.holidays.findIndex((x) => x.id === Number(params.id));
    if (index < 0) return notFound();
    const [h] = sdb.holidays.splice(index, 1);
    for (const s of sdb.sessions) {
      const day = dateKeyIn(settings()['academy.timezone'], new Date(s.startsAt));
      if (
        s.stage === 'cancelled' &&
        s.stageReason === 'holiday' &&
        day >= h!.date &&
        day <= (h!.endsOn ?? h!.date)
      ) {
        s.stage = 'scheduled';
        s.stageReason = null;
        touch(s);
        addEvent(s.id, 'restored', 'cancelled', 'scheduled', null);
      }
    }
    return new HttpResponse(null, { status: 204 });
  }),

  // ---------------------------------------------------------------- classes
  http.get(`${API}/sessions/board`, ({ request }) => {
    const g = guard(request, 'sessions.view');
    if ('error' in g) return g.error;
    const q = queryOf(request);
    const tz = q.tz ?? g.me.timezone;
    const date = q.date ?? dateKeyIn(tz, new Date());
    const from = Date.parse(zonedInstant(date, '00:00', tz));
    const to = Date.parse(zonedInstant(addDays(date, 1), '00:00', tz));
    const rows = sdb.sessions
      .filter(
        (s) =>
          seesSession(g.me, s) && Date.parse(s.startsAt) >= from && Date.parse(s.startsAt) < to,
      )
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id - b.id);
    const since = q.since ? Number(atob(q.since)) * 1000 : null;
    const live = rows.filter((s) => !s.deleted).map((s) => presentSession(s, g.me));
    const sessions =
      since === null
        ? live
        : rows
            .filter((s) => Date.parse(s.updatedAt) > since || !s.deleted)
            .map((s) => presentSession(s, g.me));
    return HttpResponse.json({
      data: {
        counters: boardCounters(live),
        sessions,
        cursor: btoa(String(Math.floor(nowMs() / 1000) - 1)),
        generator: { lastSuccessAt: iso(nowMs() - 20 * MIN), stale: false },
        serverTime: iso(nowMs()),
      },
    });
  }),

  http.get(`${API}/sessions`, ({ request }) => {
    const g = guard(request, 'sessions.view');
    if ('error' in g) return g.error;
    const parsed = sessionListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    let from = q.from ? Date.parse(q.from) : -Infinity;
    let to = q.to ? Date.parse(q.to) : Infinity;
    if (q.date) {
      const tz = q.tz ?? g.me.timezone;
      from = Date.parse(zonedInstant(q.date, '00:00', tz));
      to = Date.parse(zonedInstant(addDays(q.date, 1), '00:00', tz));
    }
    const base = sdb.sessions.filter(
      (s) =>
        !s.deleted &&
        seesSession(g.me, s) &&
        Date.parse(s.startsAt) >= from &&
        Date.parse(s.startsAt) < to &&
        (!q.teacherId || s.teacherId === q.teacherId) &&
        (!q.studentId || s.studentId === q.studentId) &&
        (!q.enrollmentId || s.enrollmentId === q.enrollmentId) &&
        (!q.kind || q.kind.includes(s.kind)),
    );
    const presented = base
      .map((s) => presentSession(s, g.me))
      .filter((s) => !q.attention || s.attention.includes(q.attention));
    const counts: Record<string, number> = { all: presented.length };
    for (const st of SESSION_STAGES) counts[st] = presented.filter((s) => s.stage === st).length;
    const rows = (q.stage ? presented.filter((s) => q.stage!.includes(s.stage)) : presented).sort(
      (a, b) => a.startsAt.localeCompare(b.startsAt),
    );
    return HttpResponse.json(paginate(rows, q.page, q.perPage, counts));
  }),

  http.post(`${API}/sessions/generate`, async ({ request }) => {
    const g = guard(request, 'schedule.manage');
    if ('error' in g) return g.error;
    const parsed = generateSessionsSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const { date, dryRun } = parsed.data;
    const made = sdb.slots.flatMap((slot) => {
      const e = sdb.enrollments.find((x) => x.id === slot.enrollmentId)!;
      return e.status === 'ended' ? [] : generateFor(slot, e, date, date);
    });
    if (!dryRun) {
      for (const s of made) addEvent(s.id, 'generated', null, s.stage, null);
      sdb.sessions.push(...made);
    }
    return HttpResponse.json({
      data: {
        toCreate: made.map((s) => ({
          startsAt: s.startsAt,
          student: { id: s.studentId, name: studentOf(s.studentId)?.name ?? null },
          teacher: { id: s.teacherId, name: teacherOf(s.teacherId)?.name ?? null },
          course: {
            id: s.courseId,
            name: COURSES.find((c) => c.id === s.courseId)?.nameEn ?? null,
          },
          stage: s.stage,
          stageReason: s.stageReason,
        })),
        created: dryRun ? [] : made.map((s) => s.id),
      },
    });
  }),

  http.get(`${API}/sessions/:id`, ({ request, params }) => {
    const g = guard(request, 'sessions.view');
    if ('error' in g) return g.error;
    const s = sessionOr404(params.id as string, g.me);
    if (!s) return notFound();
    const parentView = isParent(g.me);
    return HttpResponse.json({
      data: {
        ...presentSession(s, g.me),
        events: eventsOf(s.id),
        lessonReport: presentReport(s, g.me),
        requests: sdb.requests
          .filter(
            (r) => r.sessionId === s.id && (!parentView || r.requestedBy.id === g.me.id || true),
          )
          .map((r) => ({
            id: r.id,
            type: r.type,
            status: r.status,
            reason: r.reason,
            requestedBy: r.requestedBy,
            proposedStartsAt: r.proposedStartsAt,
            decidedAt: r.decidedAt,
            decisionNote: r.decisionNote,
            resultSessionId: r.resultSessionId,
            createdAt: r.createdAt,
          })),
      },
    });
  }),

  http.patch(`${API}/sessions/:id`, async ({ request, params }) => {
    const g = guard(request, 'sessions.manage');
    if ('error' in g) return g.error;
    const s = sessionOr404(params.id as string, g.me);
    if (!s) return notFound();
    const parsed = updateSessionSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    if (
      input.expectedStage !== s.stage ||
      (input.lockVersion !== undefined && input.lockVersion !== s.lockVersion)
    ) {
      return apiError(
        409,
        'stale_session',
        'The class changed.',
        undefined,
        presentSession(s, g.me) as unknown as Record<string, unknown>,
      );
    }
    if (s.stage !== 'scheduled')
      return apiError(409, 'invalid_transition', 'Only a scheduled class can move.');
    const startsAt = input.startsAt ?? s.startsAt;
    const duration = input.durationMinutes ?? s.durationMinutes;
    const teacherId = input.teacherId ?? s.teacherId;
    const refusal = scheduleRefusal(
      checkSingle({
        studentId: s.studentId,
        teacherId,
        startsAt,
        durationMinutes: duration,
        excludeSessionId: s.id,
      }),
      input.acknowledgeWarnings,
    );
    if (refusal) return refusal;
    const actor = { id: g.me.id, name: g.me.name, role: g.me.role?.name ?? null };
    if (startsAt !== s.startsAt || duration !== s.durationMinutes) {
      addEvent(s.id, 'time_changed', 'scheduled', 'scheduled', actor, {
        from: s.startsAt,
        to: startsAt,
        reason: input.reason ?? null,
      });
    }
    if (teacherId !== s.teacherId)
      addEvent(s.id, 'teacher_changed', 'scheduled', 'scheduled', actor, {
        from: s.teacherId,
        to: teacherId,
      });
    Object.assign(s, { startsAt, durationMinutes: duration, teacherId, isDetached: true });
    touch(s);
    return HttpResponse.json({ data: presentSession(s, g.me) });
  }),

  http.post(`${API}/sessions/:id/transitions`, async ({ request, params }) => {
    const g = guardAny(request, 'sessions.conduct', 'sessions.manage');
    if ('error' in g) return g.error;
    const s = sessionOr404(params.id as string, g.me);
    if (!s) return notFound();
    const parsed = transitionSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    const target = TARGET[input.action];
    // A double click: the target is already reached.
    if (target && s.stage === target && input.expectedStage !== s.stage) {
      return HttpResponse.json({ data: presentSession(s, g.me) });
    }
    if (
      input.expectedStage !== s.stage ||
      (input.lockVersion !== undefined && input.lockVersion !== s.lockVersion)
    ) {
      return apiError(
        409,
        'stale_session',
        'The class changed.',
        undefined,
        presentSession(s, g.me) as unknown as Record<string, unknown>,
      );
    }
    try {
      guardAction(s, input.action, g.me, input, false);
    } catch (e) {
      if (e instanceof Refusal) return e.response;
      throw e;
    }
    const now = iso(nowMs());
    const from = s.stage;
    let to: SessionStage = target ?? from;
    switch (input.action) {
      case 'activate':
        s.activatedAt = now;
        s.teacherJoinedAt ??= isOwnTeacher(g.me, s) ? now : null;
        break;
      case 'undo_activate':
        s.activatedAt = null;
        s.startedAt = null;
        break;
      case 'start':
        s.startedAt = now;
        break;
      case 'end': {
        s.endedAt = now;
        const minEnd =
          Date.parse(s.activatedAt ?? s.startsAt) + settings()['sessions.min_duration_min'] * MIN;
        if (nowMs() < minEnd) {
          s.needsReview = true;
          s.reviewReason = 'short_duration';
        }
        break;
      }
      case 'mark_leave':
        s.stageReason = input.stageReason ?? 'student';
        break;
      case 'cancel':
        s.stageReason = input.stageReason ?? null;
        break;
      case 'undo_mark':
        to = s.markedFrom ?? 'scheduled';
        s.stageReason = null;
        s.markedAt = null;
        s.markedBy = null;
        if (to === 'scheduled') s.activatedAt = null;
        break;
      case 'revert':
        Object.assign(s, {
          stageReason: null,
          markedAt: null,
          markedBy: null,
          activatedAt: null,
          startedAt: null,
          endedAt: null,
        });
        break;
    }
    if (['mark_absent', 'mark_declined', 'mark_leave'].includes(input.action)) {
      s.markedAt = now;
      s.markedBy = g.me.id;
      s.markedFrom = from;
    }
    s.stage = to;
    touch(s);
    const payload: Record<string, unknown> = {};
    if (input.note) payload.note = input.note;
    if (input.reason) payload.reason = input.reason;
    if (input.stageReason) payload.stageReason = input.stageReason;
    addEvent(
      s.id,
      EVENT[input.action],
      from,
      to,
      { id: g.me.id, name: g.me.name, role: g.me.role?.name ?? null },
      Object.keys(payload).length ? payload : null,
    );
    return HttpResponse.json({ data: presentSession(s, g.me) });
  }),

  http.get(`${API}/sessions/:id/zoom/:as`, ({ request, params }) => {
    const g = guard(request, 'sessions.view');
    if ('error' in g) return g.error;
    const s = sessionOr404(params.id as string, g.me);
    if (!s) return notFound();
    const start = Date.parse(s.startsAt);
    const e = sdb.enrollments.find((x) => x.id === s.enrollmentId);
    const link =
      s.zoomStatus === 'external'
        ? e?.externalMeetingUrl
        : s.zoomStatus === 'ready'
          ? `https://zoom.example.com/j/8${String(s.id).padStart(9, '0')}`
          : null;
    if (params.as === 'start') {
      if (!isOwnTeacher(g.me, s)) return apiError(403, 'forbidden', 'Forbidden.');
      if (nowMs() < start - 15 * MIN)
        return apiError(422, 'outside_window', 'Too early.', {
          availableFrom: [iso(start - 15 * MIN)],
        });
      if (!link) return apiError(503, 'zoom_unavailable', 'No meeting link.');
      return HttpResponse.json({ data: { startUrl: `${link}?role=host` } });
    }
    if (nowMs() < start - 60 * MIN)
      return apiError(422, 'outside_window', 'Too early.', {
        availableFrom: [iso(start - 60 * MIN)],
      });
    if (!link) return apiError(503, 'zoom_unavailable', 'No meeting link.');
    return HttpResponse.json({ data: { joinUrl: link } });
  }),

  http.post(`${API}/sessions/:id/zoom/retry`, ({ request, params }) => {
    const g = guard(request, 'sessions.manage');
    if ('error' in g) return g.error;
    const s = sessionOr404(params.id as string, g.me);
    if (!s) return notFound();
    if (s.zoomStatus === 'failed' || s.zoomStatus === 'none') s.zoomStatus = 'ready';
    touch(s);
    return HttpResponse.json({ data: presentSession(s, g.me) });
  }),

  // ---------------------------------------------------------------- requests
  http.get(`${API}/session-requests`, ({ request }) => {
    const g = guard(request, 'session_requests.view');
    if ('error' in g) return g.error;
    const parsed = sessionRequestListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const visible = sdb.requests.filter((r) => seesRequest(g.me, r));
    if (q.countOnly) {
      const pending = visible.filter((r) => r.status === 'pending');
      const byType = Object.fromEntries(
        REQUEST_TYPES.map((t) => [t, pending.filter((r) => r.type === t).length]),
      );
      return HttpResponse.json({ data: { pending: pending.length, byType } });
    }
    const base = visible.filter(
      (r) =>
        (!q.type || r.type === q.type) &&
        (!q.studentId ||
          sdb.sessions.find((s) => s.id === r.sessionId)?.studentId === q.studentId) &&
        (!q.mine || r.requestedBy.id === g.me.id),
    );
    const counts: Record<string, number> = { all: base.length };
    for (const st of REQUEST_STATUSES) counts[st] = base.filter((r) => r.status === st).length;
    counts.decided = base.filter((r) => r.status !== 'pending').length;
    const rows = (
      q.status === 'decided'
        ? base.filter((r) => r.status !== 'pending')
        : q.status
          ? base.filter((r) => r.status === q.status)
          : base
    ).sort(
      (a, b) =>
        (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) ||
        b.createdAt.localeCompare(a.createdAt),
    );
    const page = paginate(rows, q.page, q.perPage, counts);
    return HttpResponse.json({ ...page, data: page.data.map((r) => presentRequest(r, g.me)) });
  }),

  http.get(`${API}/session-requests/:id`, ({ request, params }) => {
    const g = guard(request, 'session_requests.view');
    if ('error' in g) return g.error;
    const r = sdb.requests.find((x) => x.id === Number(params.id));
    if (!r || !seesRequest(g.me, r)) return notFound();
    return HttpResponse.json({ data: presentRequest(r, g.me) });
  }),

  http.post(`${API}/session-requests`, async ({ request }) => {
    const g = guardAny(request, 'session_requests.request', 'session_requests.manage');
    if ('error' in g) return g.error;
    const parsed = createSessionRequestSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    const s = sessionOr404(String(input.sessionId), g.me);
    if (!s) return notFound();
    if (input.type !== 'leave' && !input.proposedStartsAt) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        proposedStartsAt: ['This field is required.'],
      });
    }
    if (
      input.type === 'advance' &&
      input.proposedStartsAt &&
      input.proposedStartsAt >= s.startsAt
    ) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        proposedStartsAt: ['Must be before the class.'],
      });
    }
    if (
      sdb.requests.some(
        (r) => r.sessionId === s.id && r.type === input.type && r.status === 'pending',
      )
    ) {
      return apiError(409, 'conflict', 'The same request is already pending.');
    }
    if (input.proposedStartsAt) {
      const refusal = scheduleRefusal(
        checkSingle({
          studentId: s.studentId,
          teacherId: input.proposedTeacherId ?? s.teacherId,
          startsAt: input.proposedStartsAt,
          durationMinutes: input.proposedDurationMinutes ?? s.durationMinutes,
          excludeSessionId: input.type === 'extra' ? undefined : s.id,
        }),
        input.acknowledgeWarnings,
      );
      if (refusal) return refusal;
    }
    const r: RequestRow = {
      id: sdb.nextId.request++,
      type: input.type,
      status: 'pending',
      sessionId: s.id,
      requestedBy: { id: g.me.id, name: g.me.name, role: g.me.role?.name ?? 'staff' },
      reason: input.reason,
      notifiedAt: input.type === 'leave' ? (input.notifiedAt ?? iso(nowMs())) : null,
      proposedStartsAt: input.proposedStartsAt ?? null,
      proposedDurationMinutes: input.proposedDurationMinutes ?? null,
      proposedTeacherId: input.proposedTeacherId ?? null,
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      resultSessionId: null,
      createdAt: iso(nowMs()),
    };
    sdb.requests.push(r);
    const notice = settings()['sessions.leave_notice_hours'] * 3_600_000;
    if (g.me.permissions.includes('session_requests.approve')) {
      r.status = 'approved';
      r.decidedBy = { id: g.me.id, name: g.me.name };
      r.decidedAt = iso(nowMs());
      applyRequest(r, g.me);
    } else if (r.type === 'leave' && Date.parse(s.startsAt) - Date.parse(r.notifiedAt!) >= notice) {
      r.status = 'auto_approved';
      r.decidedAt = iso(nowMs());
      applyRequest(r, null);
    }
    touch(s);
    return HttpResponse.json({ data: presentRequest(r, g.me) }, { status: 201 });
  }),

  http.post(`${API}/session-requests/:id/:action`, async ({ request, params }) => {
    const action = params.action as string;
    const g =
      action === 'cancel'
        ? guardAny(request, 'session_requests.request', 'session_requests.manage')
        : guard(request, 'session_requests.approve');
    if ('error' in g) return g.error;
    const r = sdb.requests.find((x) => x.id === Number(params.id));
    if (!r || !seesRequest(g.me, r)) return notFound();
    if (r.status !== 'pending')
      return apiError(409, 'conflict', 'The request was already decided.');
    const raw = await body(request);
    if (action === 'approve') {
      const parsed = approveSessionRequestSchema.safeParse(raw);
      if (!parsed.success) return validationFailed(parsed.error.issues);
      const s = sdb.sessions.find((x) => x.id === r.sessionId)!;
      const at = parsed.data.startsAt ?? r.proposedStartsAt;
      if (at) {
        const refusal = scheduleRefusal(
          checkSingle({
            studentId: s.studentId,
            teacherId: parsed.data.teacherId ?? r.proposedTeacherId ?? s.teacherId,
            startsAt: at,
            durationMinutes: r.proposedDurationMinutes ?? s.durationMinutes,
            excludeSessionId: r.type === 'extra' ? undefined : s.id,
          }),
          parsed.data.acknowledgeWarnings,
        );
        if (refusal) return refusal;
      }
      r.status = 'approved';
      r.decisionNote = parsed.data.note ?? null;
      applyRequest(r, g.me, parsed.data.startsAt, parsed.data.teacherId);
    } else if (action === 'reject') {
      const parsed = rejectSessionRequestSchema.safeParse(raw);
      if (!parsed.success) return validationFailed(parsed.error.issues);
      r.status = 'rejected';
      r.decisionNote = parsed.data.note;
    } else if (action === 'cancel') {
      if (r.requestedBy.id !== g.me.id) return apiError(403, 'forbidden', 'Forbidden.');
      r.status = 'cancelled';
    } else {
      return notFound();
    }
    if (action !== 'cancel') r.decidedBy = { id: g.me.id, name: g.me.name };
    r.decidedAt = iso(nowMs());
    touch(sdb.sessions.find((x) => x.id === r.sessionId)!);
    return HttpResponse.json({ data: presentRequest(r, g.me) });
  }),

  // ---------------------------------------------------------------- class rules + Zoom hosts
  http.get(`${API}/settings/sessions`, ({ request }) => {
    const g = guard(request, 'settings.view');
    if ('error' in g) return g.error;
    return HttpResponse.json({ data: sdb.settings });
  }),

  http.put(`${API}/settings/sessions`, async ({ request }) => {
    const g = guard(request, 'settings.manage');
    if ('error' in g) return g.error;
    const parsed = updateSessionSettingsSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    Object.assign(sdb.settings, parsed.data);
    return HttpResponse.json({ data: sdb.settings });
  }),

  http.get(`${API}/zoom-hosts`, ({ request }) => {
    const g = guard(request, 'settings.manage');
    if ('error' in g) return g.error;
    return HttpResponse.json({ data: sdb.zoomHosts });
  }),

  http.post(`${API}/zoom-hosts`, async ({ request }) => {
    const g = guard(request, 'settings.manage');
    if ('error' in g) return g.error;
    const parsed = createZoomHostSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    if (sdb.zoomHosts.some((h) => h.zoomUserId === parsed.data.zoomUserId)) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        zoomUserId: ['The zoom user id has already been taken.'],
      });
    }
    const host = {
      id: sdb.nextId.other++,
      zoomUserId: parsed.data.zoomUserId,
      email: parsed.data.email,
      label: parsed.data.label ?? null,
      teacherId: parsed.data.teacherId ?? null,
      isActive: parsed.data.isActive ?? true,
    };
    sdb.zoomHosts.push(host);
    return HttpResponse.json({ data: host }, { status: 201 });
  }),

  http.patch(`${API}/zoom-hosts/:id`, async ({ request, params }) => {
    const g = guard(request, 'settings.manage');
    if ('error' in g) return g.error;
    const host = sdb.zoomHosts.find((h) => h.id === Number(params.id));
    if (!host) return notFound();
    const parsed = updateZoomHostSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    Object.assign(
      host,
      Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)),
    );
    return HttpResponse.json({ data: host });
  }),
];

/** The old dashboard's counters (apps/api `counters()`), from the full day's rows. */
export function boardCounters(sessions: SessionDto[]) {
  const keys = [
    'total',
    'taken',
    'remaining',
    'running',
    'late',
    'absent',
    'leave',
    'declined',
    'suspended',
    'trial',
    'advance',
    'rescheduled',
    'ended',
    'holiday',
    'extra',
    'needs_entry',
    'teacher_unavailable',
    'zoom_failed',
    'needs_review',
    'pending_requests',
  ] as const;
  const c = Object.fromEntries(keys.map((k) => [k, 0])) as Record<(typeof keys)[number], number>;
  const byStage: Partial<Record<string, (typeof keys)[number]>> = {
    taken: 'taken',
    scheduled: 'remaining',
    activated: 'running',
    in_progress: 'running',
    absent: 'absent',
    leave: 'leave',
    declined: 'declined',
    ended: 'ended',
  };
  for (const s of sessions) {
    const moved = s.stage === 'moved_out';
    if (!moved) c.total += 1;
    const key = byStage[s.stage];
    if (key) c[key] += 1;
    if (
      s.stage === 'cancelled' &&
      (s.stageReason === 'family_suspended' || s.stageReason === 'family_on_leave')
    )
      c.suspended += 1;
    if (s.stage === 'cancelled' && s.stageReason === 'holiday') c.holiday += 1;
    if (
      !moved &&
      (s.kind === 'trial' || s.kind === 'advance' || s.kind === 'rescheduled' || s.kind === 'extra')
    )
      c[s.kind] += 1;
    for (const code of [
      'late',
      'needs_entry',
      'teacher_unavailable',
      'zoom_failed',
      'needs_review',
    ] as const)
      if (s.attention.includes(code)) c[code] += 1;
    c.pending_requests += s.pendingRequests.length;
  }
  return c;
}
