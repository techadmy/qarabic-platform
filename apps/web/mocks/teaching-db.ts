import {
  ayahCountOf,
  ayahsInRange,
  HIFZ_GRADES,
  TEST_SECTION_KEYS,
  type HifzEntryDto,
  type TestSection,
  type TestStatus,
  type TestTrack,
} from '@qarabic/shared';
import { addDays, dateKeyIn } from '@/lib/schedule-time';
import { db as people } from './people-db';
import { addEvent, sdb, type SessionRow } from './schedule-db';

/**
 * In-memory teaching data for the MSW mocks (N3), built on top of the schedule mock: lesson reports
 * with hifz rows for past classes (eight weeks of history for the demo teacher's and the demo
 * family's students), a few classes left without a report, a class of the demo teacher that can
 * be started now, and this month's student tests. Fake data only; `resetTeachingDb()` rebuilds it
 * after the schedule mock is rebuilt.
 */

const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

export interface ReportRow {
  id: number;
  sessionId: number;
  summary: string;
  homework: string | null;
  tajweedNotes: string | null;
  teacherNotes: string | null;
  rating: number | null;
  hifz: HifzEntryDto[];
  dueAt: string;
  late: boolean;
  submittedAt: string;
  submittedBy: { id: number; name: string } | null;
  updatedAt: string;
  updatedBy: { id: number; name: string } | null;
}

export interface TestResultRow {
  tajweed: number;
  reading: number | null;
  hifz: number | null;
  overall: number;
  mistakes: number[];
  remarks: string | null;
  recordedAt: string | null;
  internalNotes: string | null;
  teacherRating: number | null;
}

export interface TestRow {
  id: number;
  status: TestStatus;
  statusReason: string | null;
  track: TestTrack;
  sections: TestSection[];
  scheduledAt: string;
  durationMinutes: number;
  studentId: number;
  teacherId: number;
  createdBy: number;
  notes: string | null;
  result: TestResultRow | null;
  decidedAt: string | null;
  createdAt: string;
}

interface TeachingDb {
  reports: Map<number, ReportRow>;
  tests: TestRow[];
  nextId: { report: number; test: number };
}

const SUMMARIES = [
  'Revised the last lesson well and started the new ayahs.',
  'Good focus today; we read slowly with the rules of noon sakinah.',
  'Memorised the new part; needs to repeat it at home three times.',
  'Recited the revision without mistakes. Excellent progress.',
  'We worked on the makharij of the heavy letters.',
];
const HOMEWORK = [
  'Repeat the new ayahs five times a day.',
  'Listen to the surah once a day and read along.',
  null,
  'Revise the last two pages.',
];

const endOf = (s: SessionRow) => Date.parse(s.startsAt) + s.durationMinutes * MIN;
const teacherRef = (teacherId: number) => {
  const t = people.teachers.find((x) => x.id === teacherId)!;
  return { id: t.userId, name: t.name };
};
const familyOf = (studentId: number) => people.students.find((s) => s.id === studentId)?.familyId;

function entry(
  type: HifzEntryDto['type'],
  from: { surah: number; ayah: number },
  to: { surah: number; ayah: number },
  seed: number,
): HifzEntryDto {
  return {
    type,
    from,
    to,
    ayahs: ayahsInRange(from, to),
    pages: type === 'sabaq' ? (seed % 3) * 0.25 + 0.5 : null,
    grade: HIFZ_GRADES[seed % 4]!,
    mistakes: seed % 5 === 0 ? 0 : seed % 4,
    notes: null,
  };
}

/** Eight weeks of weekly taken classes before the generated week (the progress history). */
function addHistory(now: number) {
  const enrollments = sdb.enrollments.filter(
    (e) => e.status === 'active' && (e.teacher.id === 1 || e.student.familyId === 1),
  );
  for (const e of enrollments) {
    const slot = sdb.slots.find((x) => x.enrollmentId === e.id);
    const first = sdb.sessions
      .filter((s) => s.scheduleSlotId === slot?.id)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
    if (!slot || !first) continue;
    for (let week = 1; week <= 8; week += 1) {
      const startsAt = iso(Date.parse(first.startsAt) - week * 7 * 86_400_000);
      if (Date.parse(startsAt) > now) continue;
      const s: SessionRow = {
        ...first,
        id: sdb.nextId.session++,
        startsAt,
        occurrenceDate: addDays(first.occurrenceDate ?? dateKeyIn(slot.timezone), -7 * week),
        stage: week === 3 && e.id % 2 === 0 ? 'absent' : 'taken',
        kind: 'regular',
        activatedAt: iso(Date.parse(startsAt) + 2 * MIN),
        endedAt: iso(Date.parse(startsAt) + first.durationMinutes * MIN),
        markedAt: iso(Date.parse(startsAt) + first.durationMinutes * MIN),
        markedBy: null,
        markedFrom: 'activated',
        teacherJoinedAt: iso(Date.parse(startsAt) + MIN),
        studentJoinedAt: iso(Date.parse(startsAt) + 3 * MIN),
      };
      sdb.sessions.push(s);
      addEvent(s.id, 'activated', 'scheduled', 'activated', null, null, s.activatedAt!);
    }
  }
  sdb.sessions.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id - b.id);
}

/** The demo teacher's classes that the N3 flows need. */
function shapeDemoTeacher(now: number) {
  const minute = Math.floor(now / MIN) * MIN;
  const own = sdb.sessions.filter((s) => s.teacherId === 1 && !s.deleted);
  // A class that can be started now (the activation window opens 10 min before).
  const busy = own.some(
    (s) => Math.abs(Date.parse(s.startsAt) - minute) < 45 * MIN && s.stage !== 'cancelled',
  );
  if (!busy) {
    const pick = own.find(
      (s) =>
        s.stage === 'scheduled' &&
        Date.parse(s.startsAt) > now + 5 * HOUR &&
        familyOf(s.studentId) !== 1 &&
        !sdb.requests.some((r) => r.sessionId === s.id),
    );
    if (pick) pick.startsAt = iso(minute + 5 * MIN);
  }
  // Past taken classes of the demo teacher, newest first: the latest waits for its report
  // (pending or missing), one two days old is missing, the next one was sent within the edit window.
  // (Not today's: the Today board keeps its own outcomes.)
  const today = dateKeyIn('Africa/Cairo', new Date(now));
  const past = own
    .filter(
      (s) =>
        s.stage === 'taken' &&
        endOf(s) < now &&
        dateKeyIn('Africa/Cairo', new Date(s.startsAt)) !== today,
    )
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const ended = (s: SessionRow) => {
    Object.assign(s, { stage: 'ended', markedAt: null, markedBy: null, markedFrom: null });
    s.endedAt ??= iso(endOf(s));
    addEvent(s.id, 'ended', 'activated', 'ended', null, null, s.endedAt);
  };
  if (past[0]) ended(past[0]);
  const old = past.find((s) => endOf(s) < now - 30 * HOUR && s !== past[0]);
  if (old) ended(old);
  sdb.sessions.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id - b.id);
}

function buildReports(fresh: TeachingDb, now: number) {
  const dueHours = sdb.settings['sessions.report_due_hours'];
  const taken = sdb.sessions
    .filter((s) => s.stage === 'taken' && !s.deleted)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const pointer = new Map<number, { surah: number; ayah: number }>();
  const lastSabaq = new Map<number, HifzEntryDto>();
  for (const s of taken) {
    // About one class in eleven has no report (some of them past due: «بلا تقرير»).
    if (s.id % 11 === 4 && Date.parse(s.startsAt) > now - 10 * 86_400_000) continue;
    const start = pointer.get(s.studentId) ?? { surah: 78 + (s.studentId % 8), ayah: 1 };
    const count = ayahCountOf(start.surah);
    const end = { surah: start.surah, ayah: Math.min(count, start.ayah + 3 + (s.id % 5)) };
    pointer.set(
      s.studentId,
      end.ayah >= count
        ? { surah: start.surah >= 114 ? 78 : start.surah + 1, ayah: 1 }
        : { surah: start.surah, ayah: end.ayah + 1 },
    );
    const sabaq = entry('sabaq', start, end, s.id);
    const hifz = [sabaq];
    const prev = lastSabaq.get(s.studentId);
    if (prev) hifz.push(entry('sabaqi', prev.from, prev.to, s.id + 1));
    if (s.id % 2 === 0) {
      const m = 114 - (s.id % 3);
      hifz.push(
        entry('manzil', { surah: m, ayah: 1 }, { surah: m, ayah: ayahCountOf(m) }, s.id + 2),
      );
    }
    lastSabaq.set(s.studentId, sabaq);
    const ended = Date.parse(s.endedAt ?? iso(endOf(s)));
    const late = s.id % 7 === 3;
    const submitted = ended + (late ? dueHours + 6 : 0.3) * HOUR;
    const by = teacherRef(s.teacherId);
    fresh.reports.set(s.id, {
      id: fresh.nextId.report++,
      sessionId: s.id,
      summary: SUMMARIES[s.id % SUMMARIES.length]!,
      homework: HOMEWORK[s.id % HOMEWORK.length] ?? null,
      tajweedNotes: s.id % 3 === 0 ? 'Watch the ghunnah on noon and meem mushaddad.' : null,
      teacherNotes: s.id % 4 === 0 ? 'Parent asked to focus on revision.' : null,
      rating: s.id % 6 === 5 ? null : 3 + (s.id % 3),
      hifz,
      dueAt: iso(ended + dueHours * HOUR),
      late,
      submittedAt: iso(Math.min(submitted, now - MIN)),
      submittedBy: by,
      updatedAt: iso(Math.min(submitted, now - MIN)),
      updatedBy: by,
    });
    s.markedAt = iso(Math.min(submitted, now - MIN));
    addEvent(
      s.id,
      'report_submitted',
      'ended',
      'taken',
      { ...by, role: 'teacher' },
      null,
      s.markedAt,
    );
  }
  // The demo teacher's newest report is still inside the edit window.
  const own = [...fresh.reports.values()]
    .map((r) => ({ r, s: sdb.sessions.find((x) => x.id === r.sessionId)! }))
    .filter((x) => x.s.teacherId === 1)
    .sort((a, b) => b.s.startsAt.localeCompare(a.s.startsAt))[0];
  if (own && Date.parse(own.r.submittedAt) < now - 40 * HOUR) {
    own.r.submittedAt = iso(now - 3 * HOUR);
    own.r.updatedAt = own.r.submittedAt;
    own.s.markedAt = own.r.submittedAt;
  }
}

function buildTests(fresh: TeachingDb, now: number) {
  const minute = Math.floor(now / MIN) * MIN;
  const live = sdb.enrollments.filter((e) => e.status === 'active');
  const ofTeacher1 = live.filter((e) => e.teacher.id === 1 && e.student.familyId !== 1);
  const ofFamily1 = live.filter((e) => e.student.familyId === 1);
  const others = live.filter((e) => e.teacher.id !== 1 && e.student.familyId !== 1);
  const admin = 1;
  const all = [...TEST_SECTION_KEYS];
  const mk = (
    e: (typeof live)[number] | undefined,
    t: Partial<TestRow> & Pick<TestRow, 'status' | 'track' | 'scheduledAt'>,
  ) => {
    if (!e) return;
    fresh.tests.push({
      id: fresh.nextId.test++,
      statusReason: null,
      sections: all,
      durationMinutes: 30,
      studentId: e.student.id,
      teacherId: e.teacher.id,
      createdBy: admin,
      notes: null,
      result: null,
      decidedAt: null,
      createdAt: iso(Date.parse(t.scheduledAt) - 3 * 86_400_000),
      ...t,
    });
  };
  const result = (
    track: TestTrack,
    mistakes: number[],
    reading: number | null,
    hifz: number | null,
    at: number,
  ): TestResultRow => {
    const weight = 26;
    const tajweed = Math.round(((weight - mistakes.length) / weight) * 100);
    const parts = [
      tajweed,
      ...(track !== 'qaida' ? [reading ?? 0] : []),
      ...(track === 'hifz' ? [hifz ?? 0] : []),
    ];
    return {
      tajweed,
      reading,
      hifz,
      overall: Math.round(parts.reduce((a, b) => a + b, 0) / parts.length),
      mistakes,
      remarks: 'Good reading. Keep practising the madd rules at home.',
      recordedAt: iso(at),
      internalNotes: mistakes.length > 2 ? 'Needs a tajweed revision plan.' : null,
      teacherRating: 80,
    };
  };
  // The demo teacher examines one now (recordable: from 30 min before) and recorded one yesterday.
  mk(ofTeacher1[0], {
    status: 'scheduled',
    track: 'hifz',
    scheduledAt: iso(minute + 10 * MIN),
    createdBy: 2,
  });
  mk(ofTeacher1[1], {
    status: 'taken',
    track: 'hifz',
    scheduledAt: iso(now - 20 * HOUR),
    result: result('hifz', [2, 8, 22], 75, 100, now - 19 * HOUR),
    decidedAt: iso(now - 19 * HOUR),
  });
  // The demo family: one upcoming, one result.
  mk(ofFamily1[0], {
    status: 'scheduled',
    track: 'nazra',
    scheduledAt: iso(minute + 2 * 86_400_000),
  });
  mk(ofFamily1[1] ?? ofFamily1[0], {
    status: 'taken',
    track: 'nazra',
    sections: ['makharij', 'noon_sakin', 'madd'],
    scheduledAt: iso(now - 4 * 86_400_000),
    result: {
      ...result('nazra', [1, 22], 100, null, now - 4 * 86_400_000),
      tajweed: 88,
      overall: 94,
    },
    decidedAt: iso(now - 4 * 86_400_000),
  });
  mk(others[0], {
    status: 'scheduled',
    track: 'qaida',
    sections: ['makharij'],
    scheduledAt: iso(minute + 3 * 86_400_000),
  });
  mk(others[1], {
    status: 'taken',
    track: 'qaida',
    sections: ['makharij', 'noon_sakin'],
    scheduledAt: iso(now - 5 * 86_400_000),
    result: { ...result('qaida', [3], null, null, now - 5 * 86_400_000), tajweed: 92, overall: 92 },
    decidedAt: iso(now - 5 * 86_400_000),
  });
  mk(others[2], {
    status: 'refused',
    track: 'hifz',
    statusReason: 'The student did not attend the test.',
    scheduledAt: iso(now - 2 * 86_400_000),
    decidedAt: iso(now - 2 * 86_400_000),
  });
  mk(others[3], {
    status: 'cancelled',
    track: 'nazra',
    statusReason: 'The family asked to postpone.',
    scheduledAt: iso(now + 86_400_000),
    decidedAt: iso(now - 86_400_000),
  });
  mk(others[4], { status: 'scheduled', track: 'hifz', scheduledAt: iso(minute + 26 * HOUR) });
}

function build(): TeachingDb {
  const now = Date.now();
  const fresh: TeachingDb = { reports: new Map(), tests: [], nextId: { report: 1, test: 1 } };
  addHistory(now);
  shapeDemoTeacher(now);
  buildReports(fresh, now);
  buildTests(fresh, now);
  return fresh;
}

/** Live binding: rebuilt per test by `resetTeachingDb()` (after `resetScheduleDb()`). */
export let tdb: TeachingDb = build();

export function resetTeachingDb() {
  tdb = build();
}
