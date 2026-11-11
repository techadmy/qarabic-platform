import type {
  EnrollmentDto,
  HolidayDto,
  RequestStatus,
  RequestType,
  SessionDto,
  SessionEventDto,
  SessionKind,
  SessionSettingsDto,
  SessionStage,
  TeacherBlockDto,
  WorkHourDto,
  ZoomHostDto,
  ZoomStatus,
} from '@qarabic/shared';
import { addDays, dateKeyIn, hhmmIn, isoWeekday, zonedInstant } from '@/lib/schedule-time';
import { db as people } from './people-db';

/**
 * In-memory schedule and class data for the MSW mocks (N2), built from the People mock data and
 * the real clock, so the Today board always shows "today": past classes are marked, one is late,
 * one is running, the rest are still to come. Fake data only. `resetScheduleDb()` rebuilds it.
 */

export const SETTINGS_DEFAULTS: SessionSettingsDto = {
  'academy.timezone': 'Africa/Cairo',
  'sessions.horizon_days': 14,
  'sessions.activation_window_before_min': 10,
  'sessions.activation_window_after_min': 30,
  'sessions.undo_activation_min': 10,
  'sessions.absent_min_wait_min': 25,
  'sessions.min_duration_min': 25,
  'sessions.leave_notice_hours': 2,
  'sessions.late_teacher_min': 5,
  'sessions.report_due_hours': 24,
  'sessions.report_edit_hours': 48,
  'sessions.makeup_window_days': 14,
  'sessions.teacher_buffer_min': 0,
  'sessions.reschedule_auto_approve_hours': 12,
  'zoom.create_lead_hours': 24,
};

export type EnrollmentRow = Omit<EnrollmentDto, 'slots'>;

export interface SlotRow {
  id: number;
  enrollmentId: number;
  teacherId: number;
  weekday: number;
  localStartTime: string;
  durationMinutes: number;
  timezone: string;
  validFrom: string;
  validTo: string | null;
}

export interface SessionRow {
  id: number;
  kind: SessionKind;
  stage: SessionStage;
  stageReason: string | null;
  startsAt: string;
  durationMinutes: number;
  occurrenceDate: string | null;
  source: SessionDto['source'];
  isDetached: boolean;
  studentId: number;
  teacherId: number;
  courseId: number;
  enrollmentId: number | null;
  scheduleSlotId: number | null;
  originSessionId: number | null;
  activatedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  markedAt: string | null;
  markedBy: number | null;
  /** Stage before the last mark (for `undo_mark`). */
  markedFrom: SessionStage | null;
  zoomStatus: ZoomStatus;
  teacherJoinedAt: string | null;
  studentJoinedAt: string | null;
  needsReview: boolean;
  reviewReason: string | null;
  lockVersion: number;
  updatedAt: string;
  deleted: boolean;
}

export interface RequestRow {
  id: number;
  type: RequestType;
  status: RequestStatus;
  sessionId: number;
  requestedBy: { id: number; name: string; role: string };
  reason: string;
  notifiedAt: string | null;
  proposedStartsAt: string | null;
  proposedDurationMinutes: number | null;
  proposedTeacherId: number | null;
  decidedBy: { id: number; name: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  resultSessionId: number | null;
  createdAt: string;
}

interface ScheduleDb {
  enrollments: EnrollmentRow[];
  slots: SlotRow[];
  sessions: SessionRow[];
  events: Map<number, SessionEventDto[]>;
  requests: RequestRow[];
  holidays: HolidayDto[];
  blocks: TeacherBlockDto[];
  workHours: Map<number, WorkHourDto[]>;
  settings: SessionSettingsDto;
  zoomHosts: ZoomHostDto[];
  nextId: {
    enrollment: number;
    slot: number;
    session: number;
    event: number;
    request: number;
    other: number;
  };
}

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** Cairo hours the demo classes start at, spread over the day. */
const CAIRO_HOURS = [
  '08:00',
  '10:30',
  '13:00',
  '15:00',
  '16:30',
  '17:30',
  '18:30',
  '19:30',
  '20:30',
  '21:30',
  '22:30',
];

/** The local wall time in `tz` of a Cairo wall time on the same reference date. */
function wallFromCairo(cairo: string, tz: string, ref: string): { weekday: number; time: string } {
  const at = zonedInstant(ref, cairo, 'Africa/Cairo');
  return { weekday: isoWeekday(dateKeyIn(tz, new Date(at))), time: hhmmIn(at, tz) };
}

export function eventsOf(id: number): SessionEventDto[] {
  let list = sdb.events.get(id);
  if (!list) {
    list = [];
    sdb.events.set(id, list);
  }
  return list;
}

export function addEvent(
  sessionId: number,
  type: string,
  from: string | null,
  to: string | null,
  actor: SessionEventDto['actor'],
  payload: Record<string, unknown> | null = null,
  at: string = iso(Date.now()),
) {
  eventsOf(sessionId).push({
    id: sdb.nextId.event++,
    type,
    fromStage: from,
    toStage: to,
    actor,
    payload,
    occurredAt: at,
  });
}

/** Classes of a slot for the given local dates (slot zone), skipping existing ones. */
export function generateFor(
  slot: SlotRow,
  enrollment: EnrollmentRow,
  from: string,
  to: string,
): SessionRow[] {
  const made: SessionRow[] = [];
  for (let key = from; key <= to; key = addDays(key, 1)) {
    if (isoWeekday(key) !== slot.weekday) continue;
    if (key < slot.validFrom || (slot.validTo && key > slot.validTo)) continue;
    if (enrollment.endsOn && key > enrollment.endsOn) continue;
    if (sdb.sessions.some((s) => s.scheduleSlotId === slot.id && s.occurrenceDate === key))
      continue;
    const startsAt = zonedInstant(key, slot.localStartTime, slot.timezone);
    const holiday = sdb.holidays.find((h) => key >= h.date && key <= (h.endsOn ?? h.date));
    const row: SessionRow = {
      id: sdb.nextId.session++,
      kind: enrollment.kind === 'trial' ? 'trial' : 'regular',
      stage: holiday ? 'cancelled' : enrollment.status === 'paused' ? 'cancelled' : 'scheduled',
      stageReason: holiday
        ? 'holiday'
        : enrollment.status === 'paused'
          ? enrollment.pausedReason
          : null,
      startsAt,
      durationMinutes: slot.durationMinutes,
      occurrenceDate: key,
      source: 'generated',
      isDetached: false,
      studentId: enrollment.student.id,
      teacherId: slot.teacherId,
      courseId: enrollment.course.id,
      enrollmentId: enrollment.id,
      scheduleSlotId: slot.id,
      originSessionId: null,
      activatedAt: null,
      startedAt: null,
      endedAt: null,
      markedAt: null,
      markedBy: null,
      markedFrom: null,
      zoomStatus: enrollment.meetingMode === 'external' ? 'external' : 'ready',
      teacherJoinedAt: null,
      studentJoinedAt: null,
      needsReview: false,
      reviewReason: null,
      lockVersion: 0,
      updatedAt: iso(Date.now()),
      deleted: false,
    };
    made.push(row);
  }
  return made;
}

const SYSTEM = null;
const ADMIN = { id: 1, name: 'مدير النظام', role: 'admin' };

function build(): ScheduleDb {
  const now = Date.now();
  const today = dateKeyIn('Africa/Cairo', new Date(now));
  const year = Number(today.slice(0, 4));
  const fresh: ScheduleDb = {
    enrollments: [],
    slots: [],
    sessions: [],
    events: new Map(),
    requests: [],
    holidays: [
      {
        id: 1,
        name: 'عيد الفطر',
        date: `${year}-03-20`,
        endsOn: `${year}-03-22`,
        paid: true,
        appliesTo: 'all',
      },
      {
        id: 2,
        name: 'عيد الأضحى',
        date: `${year}-05-27`,
        endsOn: `${year}-05-29`,
        paid: true,
        appliesTo: 'all',
      },
      {
        id: 3,
        name: 'رأس السنة الهجرية',
        date: `${year}-06-16`,
        endsOn: null,
        paid: true,
        appliesTo: 'all',
      },
      {
        id: 4,
        name: 'ذكرى المولد النبوي',
        date: `${year}-08-25`,
        endsOn: null,
        paid: false,
        appliesTo: 'all',
      },
    ],
    blocks: [
      {
        id: 1,
        teacherId: 1,
        kind: 'recurring',
        reason: 'break',
        weekday: 5,
        localStartTime: '12:00',
        durationMinutes: 120,
        timezone: 'Africa/Cairo',
        validFrom: null,
        validTo: null,
        startsAt: null,
        endsAt: null,
        note: 'Friday prayer',
      },
    ],
    workHours: new Map(),
    settings: { ...SETTINGS_DEFAULTS },
    zoomHosts: [
      {
        id: 1,
        zoomUserId: 'host-001',
        email: 'zoom1@qarabic.test',
        label: 'Zoom 1',
        teacherId: null,
        isActive: true,
      },
      {
        id: 2,
        zoomUserId: 'host-002',
        email: 'zoom2@qarabic.test',
        label: 'Zoom 2',
        teacherId: 2,
        isActive: false,
      },
    ],
    nextId: { enrollment: 1, slot: 1, session: 1, event: 1, request: 1, other: 100 },
  };
  sdb = fresh;
  for (const t of people.teachers) {
    if (t.id === 7) continue; // no work hours: listed under «لم تُحدَّد ساعات العمل»
    fresh.workHours.set(
      t.id,
      [6, 7, 1, 2, 3, 4].map((weekday) => ({
        weekday,
        localStartTime: '08:00',
        localEndTime: '23:30',
        timezone: t.timezone,
      })),
    );
  }

  // One enrollment per active, live student whose teacher is active (demo parent's kids first).
  const students = people.students
    .filter((s) => s.status.value === 'active' && !s.archive && s.teacher && s.regularCourse)
    .filter((s) => people.teachers.find((t) => t.id === s.teacher!.id)?.status.value === 'active')
    .slice(0, 30);
  const ref = addDays(today, -60);
  students.forEach((student, index) => {
    const teacher = people.teachers.find((t) => t.id === student.teacher!.id)!;
    const family = people.families.find((f) => f.id === student.familyId)!;
    const course = student.regularCourse!;
    const trial = index % 11 === 5;
    const enrollment: EnrollmentRow = {
      id: fresh.nextId.enrollment++,
      student: {
        id: student.id,
        name: student.name,
        timezone: family.timezone,
        familyId: family.id,
      },
      course,
      teacher: { id: teacher.id, name: teacher.name, timezone: teacher.timezone },
      kind: trial ? 'trial' : 'regular',
      status: index === 17 ? 'paused' : 'active',
      pausedReason: index === 17 ? 'family_on_leave' : null,
      startsOn: addDays(today, -60),
      endsOn: null,
      sessionMinutes: 30,
      timezone: family.timezone,
      meetingMode: index % 3 === 0 ? 'zoom' : 'external',
      externalMeetingUrl:
        index % 3 === 0 ? null : `https://meet.example.com/qarabic-${100 + index}`,
      notes: index % 4 === 0 ? 'Prefers the same teacher every week.' : null,
      createdAt: iso(now - 60 * 86_400_000),
    };
    fresh.enrollments.push(enrollment);
    // Three weekly times: spread over the week and the Cairo day.
    const days = [
      [6, 1, 3],
      [7, 2, 4],
      [1, 3, 5],
      [6, 2, 4],
      [7, 1, 3],
    ][index % 5]!;
    days.forEach((day, j) => {
      const cairo = CAIRO_HOURS[(index + j * 4) % CAIRO_HOURS.length]!;
      // `ref` + offset to the right weekday in Cairo, then the family's wall time for it.
      let key = ref;
      while (isoWeekday(key) !== day) key = addDays(key, 1);
      const wall = wallFromCairo(cairo, family.timezone, key);
      fresh.slots.push({
        id: fresh.nextId.slot++,
        enrollmentId: enrollment.id,
        teacherId: teacher.id,
        weekday: wall.weekday,
        localStartTime: wall.time,
        durationMinutes: 30,
        timezone: family.timezone,
        validFrom: enrollment.startsOn,
        validTo: null,
      });
    });
  });

  // Classes from a week ago to two weeks ahead.
  for (const slot of fresh.slots) {
    const e = fresh.enrollments.find((x) => x.id === slot.enrollmentId)!;
    const from = addDays(dateKeyIn(slot.timezone, new Date(now)), -7);
    const to = addDays(dateKeyIn(slot.timezone, new Date(now)), 14);
    fresh.sessions.push(...generateFor(slot, e, from, to));
  }
  // Whatever the hour, the demo board has one running class and one late class: two of the
  // next classes (different teachers, not the demo teacher) move to just before now.
  const minute = Math.floor(now / MIN) * MIN;
  const anchors = fresh.sessions
    .filter((s) => s.stage === 'scheduled' && Date.parse(s.startsAt) > now && s.teacherId !== 1)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .filter((s, i, all) => all.findIndex((x) => x.teacherId === s.teacherId) === i)
    .slice(0, 2);
  anchors.forEach((s, i) => {
    s.startsAt = iso(minute - (i === 0 ? 12 : 8) * MIN);
    s.occurrenceDate = dateKeyIn(
      fresh.slots.find((x) => x.id === s.scheduleSlotId)!.timezone,
      new Date(s.startsAt),
    );
  });
  // A class of the demo parent's child starts in 90 minutes: a leave asked now is too late for
  // the automatic approval (2 h notice), so it waits for staff.
  const soon = fresh.sessions.find(
    (s) =>
      s.stage === 'scheduled' &&
      Date.parse(s.startsAt) > now + 4 * 3_600_000 &&
      people.students.find((x) => x.id === s.studentId)?.familyId === 1,
  );
  if (soon) soon.startsAt = iso(minute + 90 * MIN);
  fresh.sessions.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id - b.id);

  // Outcomes of past and current classes (deterministic by id).
  let late = false;
  let ended = false;
  let running = false;
  for (const s of fresh.sessions) {
    addEvent(
      s.id,
      'generated',
      null,
      'scheduled',
      SYSTEM,
      null,
      iso(Date.parse(s.startsAt) - 7 * 86_400_000),
    );
    if (s.stage !== 'scheduled') continue;
    const start = Date.parse(s.startsAt);
    const end = start + s.durationMinutes * MIN;
    const teacher = people.teachers.find((t) => t.id === s.teacherId)!;
    const actor = { id: teacher.userId, name: teacher.name, role: 'teacher' };
    if (end < now) {
      const r = s.id % 13;
      if (!ended && start > now - 6 * 3_600_000) {
        ended = true;
        Object.assign(s, { stage: 'ended', activatedAt: iso(start + MIN), endedAt: iso(end) });
        s.teacherJoinedAt = s.activatedAt;
        s.studentJoinedAt = iso(start + 2 * MIN);
        addEvent(s.id, 'activated', 'scheduled', 'activated', actor, null, s.activatedAt!);
        addEvent(s.id, 'ended', 'activated', 'ended', actor, null, s.endedAt!);
        continue;
      }
      const stage: SessionStage =
        r === 3 ? 'absent' : r === 7 ? 'leave' : r === 10 ? 'declined' : 'taken';
      Object.assign(s, {
        stage,
        stageReason: stage === 'leave' ? 'student' : null,
        activatedAt: stage === 'leave' ? null : iso(start + 2 * MIN),
        endedAt: stage === 'taken' ? iso(end) : null,
        markedAt: iso(stage === 'leave' ? start - 5 * 3_600_000 : end),
        markedBy: teacher.userId,
        markedFrom: stage === 'leave' ? 'scheduled' : 'activated',
        teacherJoinedAt: stage === 'leave' ? null : iso(start + MIN),
        studentJoinedAt: stage === 'taken' || stage === 'declined' ? iso(start + 3 * MIN) : null,
      });
      if (s.activatedAt)
        addEvent(s.id, 'activated', 'scheduled', 'activated', actor, null, s.activatedAt);
      addEvent(
        s.id,
        'marked',
        s.markedFrom,
        stage,
        actor,
        stage === 'absent'
          ? { note: 'The student did not join.' }
          : stage === 'declined'
            ? { note: 'The student asked to stop early.' }
            : null,
        s.markedAt!,
      );
    } else if (start <= now && !running && now - start > 6 * MIN) {
      running = true;
      Object.assign(s, {
        stage: 'activated',
        activatedAt: iso(start + MIN),
        teacherJoinedAt: iso(start + MIN),
        studentJoinedAt: iso(start + 2 * MIN),
      });
      addEvent(s.id, 'activated', 'scheduled', 'activated', actor, null, s.activatedAt!);
    } else if (start <= now && !late) {
      late = true; // stays scheduled: the board flags it late
    }
  }
  // A make-up and an extra class later today; one failed meeting.
  const upcoming = fresh.sessions.filter(
    (s) => s.stage === 'scheduled' && Date.parse(s.startsAt) > now,
  );
  if (upcoming[1]) upcoming[1].kind = 'rescheduled';
  if (upcoming[3]) upcoming[3].kind = 'extra';
  const zoomOne = upcoming.find((s) => s.zoomStatus === 'ready');
  if (zoomOne) zoomOne.zoomStatus = 'failed';

  // Requests: pending ones on upcoming classes, a few decided.
  const demoParent = people.families.find((f) => f.id === 1)!;
  const parentActor = { id: demoParent.parentUserId, name: demoParent.parentName, role: 'parent' };
  const teacherOne = people.teachers.find((t) => t.id === 1)!;
  const teacherActor = { id: teacherOne.userId, name: teacherOne.name, role: 'teacher' };
  const future = (pred: (s: SessionRow) => boolean) =>
    fresh.sessions.filter(
      (s) => s.stage === 'scheduled' && Date.parse(s.startsAt) > now + 3 * 3_600_000 && pred(s),
    );
  const ofFamily1 = future(
    (s) => people.students.find((x) => x.id === s.studentId)?.familyId === 1,
  );
  const ofTeacher1 = future(
    (s) => s.teacherId === 1 && people.students.find((x) => x.id === s.studentId)?.familyId !== 1,
  );
  const others = future((s) => s.teacherId !== 1);
  const mk = (
    r: Omit<
      RequestRow,
      | 'id'
      | 'decidedBy'
      | 'decidedAt'
      | 'decisionNote'
      | 'resultSessionId'
      | 'notifiedAt'
      | 'proposedDurationMinutes'
      | 'proposedTeacherId'
    > &
      Partial<RequestRow>,
  ) =>
    fresh.requests.push({
      id: fresh.nextId.request++,
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      resultSessionId: null,
      notifiedAt: null,
      proposedDurationMinutes: null,
      proposedTeacherId: null,
      ...r,
    });
  const later = (s: SessionRow, hours: number) => iso(Date.parse(s.startsAt) + hours * 3_600_000);
  if (ofFamily1[2])
    mk({
      type: 'leave',
      status: 'pending',
      sessionId: ofFamily1[2].id,
      requestedBy: parentActor,
      reason: 'Family trip that day.',
      proposedStartsAt: null,
      createdAt: iso(now - 40 * MIN),
      notifiedAt: iso(now - 40 * MIN),
    });
  if (ofTeacher1[1])
    mk({
      type: 'reschedule',
      status: 'pending',
      sessionId: ofTeacher1[1].id,
      requestedBy: teacherActor,
      reason: 'Doctor appointment; one day later works.',
      proposedStartsAt: later(ofTeacher1[1], 24),
      createdAt: iso(now - 3 * 3_600_000),
    });
  if (others[4])
    mk({
      type: 'advance',
      status: 'pending',
      sessionId: others[4].id,
      requestedBy: { id: 13, name: 'Mona CSR', role: 'csr' },
      reason: 'The family asked for an earlier time.',
      proposedStartsAt: later(others[4], -2),
      createdAt: iso(now - 26 * 3_600_000),
    });
  if (others[7])
    mk({
      type: 'extra',
      status: 'pending',
      sessionId: others[7].id,
      requestedBy: { id: 12, name: 'Rana Monitor', role: 'monitor' },
      reason: 'Exam next week: one more class.',
      proposedStartsAt: later(others[7], 26),
      createdAt: iso(now - 5 * 3_600_000),
    });
  if (others[9])
    mk({
      type: 'leave',
      status: 'approved',
      sessionId: others[9].id,
      requestedBy: { id: 13, name: 'Mona CSR', role: 'csr' },
      reason: 'Student is ill.',
      proposedStartsAt: null,
      createdAt: iso(now - 30 * 3_600_000),
      decidedBy: { id: 1, name: ADMIN.name },
      decidedAt: iso(now - 29 * 3_600_000),
    });
  if (others[11])
    mk({
      type: 'reschedule',
      status: 'rejected',
      sessionId: others[11].id,
      requestedBy: teacherActor,
      reason: 'Internet problems.',
      proposedStartsAt: later(others[11], 3),
      createdAt: iso(now - 50 * 3_600_000),
      decidedBy: { id: 1, name: ADMIN.name },
      decidedAt: iso(now - 49 * 3_600_000),
      decisionNote: 'The teacher is busy at that time.',
    });
  return fresh;
}

/** Live binding: rebuilt per test by `resetScheduleDb()`. */
export let sdb: ScheduleDb = undefined as unknown as ScheduleDb;
sdb = build();

export function resetScheduleDb() {
  sdb = build();
}
