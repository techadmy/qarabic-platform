import {
  allowedMistakes,
  ayahsInRange,
  createTestSchema,
  HIFZ_TYPES,
  lessonReportInputSchema,
  needsHifz,
  needsReading,
  orderedSections,
  overallScore,
  progressQuerySchema,
  QURAN_AYAH_COUNT,
  QURAN_SURAHS,
  rangePieces,
  recordTestResultSchema,
  REPORT_STATES,
  reportListQuerySchema,
  tajweedScore,
  TEST_RECORD_LEAD_MINUTES,
  TEST_STATUSES,
  TEST_ERROR_MESSAGES,
  testListQuerySchema,
  testReasonSchema,
  testSummaryQuerySchema,
  teacherWeekQuerySchema,
  updateTestSchema,
  type HifzEntryDto,
  type LastPositionDto,
  type ProgressDto,
  type ReportState,
  type TestDto,
  type TestErrorCode,
  trialReportInputSchema,
  type TrialReportDto,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { addDays, dateKeyIn, isoWeekday, zonedInstant } from '@/lib/schedule-time';
import type { MockUser } from './data';
import { COURSES, db as people } from './people-db';
import { addEvent, sdb, type SessionRow } from './schedule-db';
import {
  body,
  isParent,
  isTeacher,
  ownFamilyId,
  ownTeacherId,
  paginate,
  presentSession,
  queryOf,
  seesSession,
  sessionOr404,
  touch,
} from './schedule-handlers';
import { apiError, guard, guardAny, notFound, validationFailed } from './session';
import { tdb, type TestRow } from './teaching-db';
import { dueAtOf, editableUntil, presentReport, reportOf } from './teaching-present';

/**
 * MSW handlers for the N3 teaching endpoints (apps/api/README.md, N3): the lesson report, the
 * staff reports list, a student's progress, the Quran reference, student tests and the teacher
 * portal. Same row scopes as the class endpoints (404 outside them). Fake data only.
 */
const API = '*/api/v1';
const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const settings = () => sdb.settings;
const academyTz = () => settings()['academy.timezone'];
const canManage = (me: MockUser) => me.permissions.includes('sessions.manage');
const studentOf = (id: number) => people.students.find((s) => s.id === id);
const teacherOf = (id: number) => people.teachers.find((t) => t.id === id);
const familyTz = (studentId: number) =>
  people.families.find((f) => f.id === studentOf(studentId)?.familyId)?.timezone ?? 'UTC';
const actorOf = (me: MockUser) => ({ id: me.id, name: me.name });

function seesStudent(me: MockUser, studentId: number) {
  const s = studentOf(studentId);
  if (!s) return false;
  if (isTeacher(me)) return s.teacher?.id === ownTeacherId(me);
  if (isParent(me)) return s.familyId === ownFamilyId(me);
  return true;
}

// ------------------------------------------------------------------ lesson reports

function reportStateOf(s: SessionRow, now: number): ReportState {
  const r = reportOf(s.id);
  if (r) return r.late ? 'late' : 'on_time';
  return now > dueAtOf(s) ? 'missing' : 'pending';
}

// ------------------------------------------------------------------ progress

function progressOf(studentId: number, me: MockUser, type?: string): ProgressDto {
  const student = studentOf(studentId)!;
  const parent = isParent(me);
  const showRating = !parent || settings()['reports.parent_sees_rating'];
  const rows = sdb.sessions
    .filter((s) => s.studentId === studentId && !s.deleted && reportOf(s.id))
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const lastPositions: LastPositionDto[] = [];
  for (const t of HIFZ_TYPES) {
    for (const s of rows) {
      const h = reportOf(s.id)!.hifz.find((x) => x.type === t);
      if (h) {
        lastPositions.push({ ...h, sessionId: s.id, date: s.startsAt });
        break;
      }
    }
  }
  const timeline = rows.slice(0, 200).map((s) => {
    const r = reportOf(s.id)!;
    const teacher = teacherOf(s.teacherId);
    return {
      sessionId: s.id,
      reportId: r.id,
      startsAt: s.startsAt,
      teacher: teacher ? { id: teacher.id, name: teacher.name } : null,
      summary: r.summary,
      homework: r.homework,
      tajweedNotes: r.tajweedNotes,
      ...(parent ? {} : { teacherNotes: r.teacherNotes }),
      ...(showRating ? { rating: r.rating } : {}),
      submittedAt: r.submittedAt,
      late: r.late,
      hifz: type ? r.hifz.filter((h) => h.type === type) : r.hifz,
    };
  });
  // New ayahs (sabaq) per academy month, the last 12 months.
  const tz = academyTz();
  const thisMonth = dateKeyIn(tz).slice(0, 7);
  const months: string[] = [];
  let [y, m] = thisMonth.split('-').map(Number) as [number, number];
  for (let i = 0; i < 12; i += 1) {
    months.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  const perMonth = new Map(months.map((k) => [k, 0]));
  const covered = new Map<number, Set<number>>();
  for (const s of rows) {
    const month = dateKeyIn(tz, new Date(s.startsAt)).slice(0, 7);
    for (const h of reportOf(s.id)!.hifz) {
      if (h.type !== 'sabaq') continue;
      if (perMonth.has(month)) perMonth.set(month, perMonth.get(month)! + h.ayahs);
      for (const p of rangePieces(h.from, h.to)) {
        const set = covered.get(p.surah) ?? new Set<number>();
        for (let a = p.first; a <= p.last; a += 1) set.add(a);
        covered.set(p.surah, set);
      }
    }
  }
  const surahs = [...covered.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, set]) => {
      const ayahCount = QURAN_SURAHS[number - 1]!.ayahCount;
      return { number, memorisedAyahs: set.size, ayahCount, complete: set.size >= ayahCount };
    });
  const memorised = surahs.reduce((a, s) => a + s.memorisedAyahs, 0);
  return {
    studentId,
    student: { id: student.id, name: student.name, timezone: familyTz(student.id) },
    lastPositions,
    timeline,
    monthlyAyahs: months.map((month) => ({ month, ayahs: perMonth.get(month)! })),
    coverage: {
      memorisedAyahs: memorised,
      totalAyahs: QURAN_AYAH_COUNT,
      percent: Math.round((memorised / QURAN_AYAH_COUNT) * 1000) / 10,
      completeSurahs: surahs.filter((s) => s.complete).length,
      surahs,
    },
  };
}

// ------------------------------------------------------------------ tests

const testError = (status: number, code: TestErrorCode, field?: string) =>
  apiError(
    status,
    code,
    TEST_ERROR_MESSAGES[code].en,
    field ? { [field]: [TEST_ERROR_MESSAGES[code].en] } : undefined,
  );
const isTestStaff = (me: MockUser) => me.permissions.includes('tests.manage');

function seesTest(me: MockUser, t: TestRow) {
  if (isTestStaff(me) || (!isTeacher(me) && !isParent(me))) return true;
  if (isTeacher(me)) {
    const own = ownTeacherId(me);
    return t.teacherId === own || studentOf(t.studentId)?.teacher?.id === own;
  }
  return studentOf(t.studentId)?.familyId === ownFamilyId(me) && t.status !== 'cancelled';
}

function testCan(me: MockUser, t: TestRow): TestDto['can'] {
  const staff = isTestStaff(me);
  const examiner =
    me.permissions.includes('tests.conduct') && isTeacher(me) && ownTeacherId(me) === t.teacherId;
  const scheduled = t.status === 'scheduled';
  const opens = Date.parse(t.scheduledAt) - TEST_RECORD_LEAD_MINUTES * MIN;
  const until = testEditableUntil(t);
  return {
    update: scheduled && (staff || examiner),
    record: scheduled && (staff || examiner) && Date.now() >= opens,
    editResult:
      t.status === 'taken' && (staff || (examiner && !!until && Date.now() <= Date.parse(until))),
    refuse: scheduled && (staff || examiner),
    cancel: scheduled && (staff || examiner || t.createdBy === me.id),
    reopen: staff && (t.status === 'refused' || t.status === 'cancelled'),
    setExaminer: staff && scheduled,
  };
}

function testEditableUntil(t: TestRow) {
  const at = t.result?.recordedAt;
  return at ? iso(Date.parse(at) + settings()['sessions.report_edit_hours'] * HOUR) : null;
}

function presentTest(t: TestRow, me: MockUser): TestDto {
  const student = studentOf(t.studentId)!;
  const teacher = teacherOf(t.teacherId)!;
  const parent = isParent(me);
  const staff = !isTeacher(me) && !parent;
  const enrollment = sdb.enrollments.find((e) => e.student.id === t.studentId);
  return {
    id: t.id,
    status: t.status,
    statusReason: t.statusReason,
    track: t.track,
    sections: orderedSections(t.sections),
    scheduledAt: t.scheduledAt,
    durationMinutes: t.durationMinutes,
    month: dateKeyIn(academyTz(), new Date(t.scheduledAt)).slice(0, 7),
    student: { id: student.id, name: student.name, timezone: familyTz(student.id) },
    teacher: { id: teacher.id, name: teacher.name, timezone: teacher.timezone },
    course: enrollment ? enrollment.course : null,
    notes: parent ? null : t.notes,
    result: t.result
      ? {
          tajweed: t.result.tajweed,
          reading: t.result.reading,
          hifz: t.result.hifz,
          overall: t.result.overall,
          mistakes: t.result.mistakes,
          remarks: t.result.remarks,
          recordedAt: t.result.recordedAt,
          ...(parent
            ? {}
            : { internalNotes: t.result.internalNotes, editableUntil: testEditableUntil(t) }),
          ...(staff ? { teacherRating: t.result.teacherRating } : {}),
        }
      : null,
    decidedAt: t.decidedAt,
    createdAt: t.createdAt,
    can: testCan(me, t),
  };
}

function monthRange(month: string) {
  const tz = academyTz();
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [
    Date.parse(zonedInstant(`${month}-01`, '00:00', tz)),
    Date.parse(zonedInstant(`${next}-01`, '00:00', tz)),
  ] as const;
}

function summaryCounts(rows: TestRow[]) {
  const live = rows.filter((t) => t.status !== 'cancelled');
  return {
    created: live.length,
    taken: live.filter((t) => t.status === 'taken').length,
    remaining: live.filter((t) => t.status === 'scheduled').length,
    refused: live.filter((t) => t.status === 'refused').length,
    cancelled: rows.filter((t) => t.status === 'cancelled').length,
  };
}

const testOr404 = (id: string, me: MockUser) => {
  const t = tdb.tests.find((x) => x.id === Number(id));
  return t && seesTest(me, t) ? t : null;
};

// ------------------------------------------------------------------ teacher portal

function weekOf(me: MockUser, date: string | undefined) {
  const teacher = teacherOf(ownTeacherId(me)!)!;
  const tz = teacher.timezone;
  const today = dateKeyIn(tz);
  const key = date ?? today;
  // Saturday → Friday.
  const back = (isoWeekday(key) + 1) % 7;
  const start = addDays(key, -back);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const from = Date.parse(zonedInstant(start, '00:00', tz));
  const to = Date.parse(zonedInstant(addDays(start, 7), '00:00', tz));
  const rows = sdb.sessions
    .filter(
      (s) =>
        !s.deleted &&
        s.teacherId === teacher.id &&
        Date.parse(s.startsAt) >= from &&
        Date.parse(s.startsAt) < to,
    )
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const shown = rows.filter((s) => s.stage !== 'moved_out');
  const count = (stages: string[]) => shown.filter((s) => stages.includes(s.stage)).length;
  return {
    teacher: { id: teacher.id, name: teacher.name, timezone: tz },
    timezone: tz,
    weekStart: start,
    weekEnd: addDays(start, 6),
    today,
    previousWeek: addDays(start, -7),
    nextWeek: addDays(start, 7),
    summary: {
      total: shown.length,
      taken: count(['taken']),
      remaining: count(['scheduled', 'activated', 'in_progress']),
      needsReport: shown.filter((s) => s.stage === 'ended').length,
      absent: count(['absent']),
      leave: count(['leave']),
    },
    days: days.map((d) => ({
      date: d,
      sessions: rows
        .filter((s) => dateKeyIn(tz, new Date(s.startsAt)) === d)
        .map((s) => presentSession(s, me)),
    })),
  };
}

function lastPositionsOf(studentId: number): LastPositionDto[] {
  const rows = sdb.sessions
    .filter((s) => s.studentId === studentId && reportOf(s.id))
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  return HIFZ_TYPES.flatMap((t) => {
    for (const s of rows) {
      const h = reportOf(s.id)!.hifz.find((x) => x.type === t);
      if (h) return [{ ...h, sessionId: s.id, date: s.startsAt }];
    }
    return [];
  });
}

// ------------------------------------------------------------------ handlers

/** T4 trial reports (`PUT /sessions/:id/trial-report`), by session id. */
const trialReports = new Map<number, TrialReportDto>();
export const resetTrialReports = () => trialReports.clear();

export const teachingHandlers: HttpHandler[] = [
  http.get(`${API}/sessions/:id/trial-report`, ({ request, params }) => {
    const g = guardAny(request, 'sessions.conduct', 'sessions.manage');
    if ('error' in g) return g.error;
    const s = sessionOr404(params.id as string, g.me);
    if (!s) return notFound();
    return HttpResponse.json({ data: trialReports.get(s.id) ?? null });
  }),

  http.put(`${API}/sessions/:id/trial-report`, async ({ request, params }) => {
    const g = guardAny(request, 'sessions.conduct', 'sessions.manage');
    if ('error' in g) return g.error;
    const s = sessionOr404(params.id as string, g.me);
    if (!s) return notFound();
    if (s.kind !== 'trial') return apiError(422, 'not_a_trial', 'This is not a trial class.');
    const parsed = trialReportInputSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    const manage = canManage(g.me);
    const own = g.me.permissions.includes('sessions.conduct') && ownTeacherId(g.me) === s.teacherId;
    if (!manage && !own) return apiError(403, 'forbidden', 'Forbidden.');
    const now = Date.now();
    const by = actorOf(g.me);
    const old = trialReports.get(s.id);
    if (s.stage === 'ended') {
      s.stage = 'taken';
      s.markedAt = iso(now);
      s.markedFrom = 'ended';
      addEvent(s.id, 'report_submitted', 'ended', 'taken', {
        ...by,
        role: g.me.role?.name ?? null,
      });
    } else if (s.stage === 'taken') {
      const until = editableUntil(s);
      if (!manage && (!until || now > Date.parse(until))) {
        return apiError(
          422,
          'trial_report_locked',
          'The edit window of this trial report has closed.',
        );
      }
    } else {
      return apiError(409, 'invalid_transition', 'Not allowed from this stage.');
    }
    const course = input.recommendedCourseId
      ? COURSES.find((c) => c.id === input.recommendedCourseId)
      : null;
    const report: TrialReportDto = {
      sessionId: s.id,
      leadId: null,
      attendance: input.attendance,
      level: input.level,
      recommendedCourse: course
        ? { id: course.id, nameAr: course.nameAr, nameEn: course.nameEn }
        : null,
      classesPerWeek: input.classesPerWeek,
      minutesPerClass: input.minutesPerClass,
      engagement: input.engagement,
      notes: input.notes ?? null,
      submittedBy: old?.submittedBy ?? by,
      submittedAt: old?.submittedAt ?? iso(now),
      updatedAt: iso(now),
    };
    trialReports.set(s.id, report);
    touch(s);
    return HttpResponse.json({ data: report });
  }),

  http.get(`${API}/sessions/:id/report`, ({ request, params }) => {
    const g = guard(request, 'sessions.view');
    if ('error' in g) return g.error;
    const s = sessionOr404(params.id as string, g.me);
    if (!s) return notFound();
    return HttpResponse.json({ data: presentReport(s, g.me) });
  }),

  http.put(`${API}/sessions/:id/report`, async ({ request, params }) => {
    const g = guardAny(request, 'sessions.conduct', 'sessions.manage');
    if ('error' in g) return g.error;
    const s = sessionOr404(params.id as string, g.me);
    if (!s) return notFound();
    const parsed = lessonReportInputSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    const manage = canManage(g.me);
    const own = g.me.permissions.includes('sessions.conduct') && ownTeacherId(g.me) === s.teacherId;
    if (!manage && !own) return apiError(403, 'forbidden', 'Forbidden.');
    if (input.expectedStage && input.expectedStage !== s.stage) {
      return apiError(409, 'stale_session', 'The class has changed.', undefined, {
        ...presentSession(s, g.me),
      });
    }
    const now = Date.now();
    const hifz: HifzEntryDto[] = (input.hifz ?? []).map((h) => ({
      type: h.type,
      from: h.from,
      to: h.to,
      ayahs: ayahsInRange(h.from, h.to),
      pages: h.pages ?? null,
      grade: h.grade ?? null,
      mistakes: h.mistakes ?? null,
      notes: h.notes ?? null,
    }));
    const by = actorOf(g.me);
    const actor = { ...by, role: g.me.role?.name ?? null };
    if (s.stage === 'ended') {
      const due = dueAtOf(s);
      tdb.reports.set(s.id, {
        id: tdb.nextId.report++,
        sessionId: s.id,
        summary: input.summary,
        homework: input.homework ?? null,
        tajweedNotes: input.tajweedNotes ?? null,
        teacherNotes: input.teacherNotes ?? null,
        rating: input.rating ?? null,
        hifz,
        dueAt: iso(due),
        late: now > due,
        submittedAt: iso(now),
        submittedBy: by,
        updatedAt: iso(now),
        updatedBy: by,
      });
      s.stage = 'taken';
      s.markedAt = iso(now);
      s.markedFrom = 'ended';
      addEvent(s.id, 'report_submitted', 'ended', 'taken', actor);
    } else if (s.stage === 'taken') {
      const until = editableUntil(s);
      if (!manage && (!until || now > Date.parse(until))) {
        return apiError(422, 'outside_window', 'The edit time has passed.', {
          availableUntil: [until ?? iso(now)],
        });
      }
      const old = reportOf(s.id);
      const due = dueAtOf(s);
      tdb.reports.set(s.id, {
        id: old?.id ?? tdb.nextId.report++,
        sessionId: s.id,
        summary: input.summary,
        homework: input.homework ?? null,
        tajweedNotes: input.tajweedNotes ?? null,
        teacherNotes: input.teacherNotes ?? null,
        rating: input.rating ?? null,
        hifz: input.hifz ? hifz : (old?.hifz ?? []),
        dueAt: old?.dueAt ?? iso(due),
        late: old?.late ?? now > due,
        submittedAt: old?.submittedAt ?? iso(now),
        submittedBy: old?.submittedBy ?? by,
        updatedAt: iso(now),
        updatedBy: by,
      });
      addEvent(s.id, old ? 'report_updated' : 'report_submitted', 'taken', 'taken', actor);
    } else {
      return apiError(409, 'invalid_transition', 'Not allowed from this stage.');
    }
    touch(s);
    return HttpResponse.json({ data: presentSession(s, g.me) });
  }),

  http.get(`${API}/lesson-reports`, ({ request }) => {
    const g = guard(request, 'sessions.view');
    if ('error' in g) return g.error;
    if (isParent(g.me)) return apiError(403, 'forbidden', 'Forbidden.');
    const parsed = reportListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const now = Date.now();
    const base = sdb.sessions.filter(
      (s) =>
        !s.deleted &&
        (s.stage === 'ended' || s.stage === 'taken') &&
        seesSession(g.me, s) &&
        (!q.from || Date.parse(s.startsAt) >= Date.parse(q.from)) &&
        (!q.to || Date.parse(s.startsAt) < Date.parse(q.to)) &&
        (!q.teacherId || s.teacherId === q.teacherId) &&
        (!q.studentId || s.studentId === q.studentId),
    );
    const counts: Record<string, number> = { all: base.length };
    for (const k of REPORT_STATES)
      counts[k] = base.filter((s) => reportStateOf(s, now) === k).length;
    const rows = base
      .filter((s) => !q.state?.length || q.state.includes(reportStateOf(s, now)))
      .sort((a, b) => b.startsAt.localeCompare(a.startsAt) || b.id - a.id)
      .map((s) => {
        const r = reportOf(s.id);
        return {
          state: reportStateOf(s, now),
          dueAt: r?.dueAt ?? iso(dueAtOf(s)),
          session: presentSession(s, g.me),
          report: r
            ? {
                id: r.id,
                submittedAt: r.submittedAt,
                submittedBy: r.submittedBy,
                rating: r.rating,
                late: r.late,
              }
            : null,
        };
      });
    return HttpResponse.json(paginate(rows, q.page, q.perPage, counts));
  }),

  http.get(`${API}/students/:id/progress`, ({ request, params }) => {
    const g = guardAny(request, 'families.view', 'sessions.conduct');
    if ('error' in g) return g.error;
    const id = Number(params.id);
    if (!seesStudent(g.me, id)) return notFound();
    const parsed = progressQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    return HttpResponse.json({ data: progressOf(id, g.me, parsed.data.type) });
  }),

  http.get(`${API}/quran/surahs`, ({ request }) => {
    const g = guard(request);
    if ('error' in g) return g.error;
    return HttpResponse.json({ data: QURAN_SURAHS });
  }),

  // ---------------------------------------------------------------- tests
  http.get(`${API}/tests/summary`, ({ request }) => {
    const g = guard(request, 'tests.view');
    if ('error' in g) return g.error;
    if (isParent(g.me)) return apiError(403, 'forbidden', 'Forbidden.');
    const parsed = testSummaryQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const [from, to] = monthRange(parsed.data.month);
    const rows = tdb.tests.filter(
      (t) =>
        seesTest(g.me, t) && Date.parse(t.scheduledAt) >= from && Date.parse(t.scheduledAt) < to,
    );
    const teacherIds = [...new Set(rows.map((t) => t.teacherId))];
    return HttpResponse.json({
      data: {
        month: parsed.data.month,
        counts: summaryCounts(rows),
        byTeacher: teacherIds.map((id) => ({
          teacher: { id, name: teacherOf(id)?.name ?? '' },
          ...summaryCounts(rows.filter((t) => t.teacherId === id)),
        })),
      },
    });
  }),

  http.get(`${API}/tests`, ({ request }) => {
    const g = guard(request, 'tests.view');
    if ('error' in g) return g.error;
    const parsed = testListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const [mFrom, mTo] = q.month ? monthRange(q.month) : [-Infinity, Infinity];
    const base = tdb.tests.filter((t) => {
      const at = Date.parse(t.scheduledAt);
      return (
        seesTest(g.me, t) &&
        at >= mFrom &&
        at < mTo &&
        (!q.from || at >= Date.parse(q.from)) &&
        (!q.to || at < Date.parse(q.to)) &&
        (!q.date || dateKeyIn(academyTz(), new Date(at)) === q.date) &&
        (!q.teacherId || t.teacherId === q.teacherId) &&
        (!q.studentId || t.studentId === q.studentId) &&
        (!q.track || t.track === q.track)
      );
    });
    const counts: Record<string, number> = { all: base.length };
    for (const st of TEST_STATUSES) counts[st] = base.filter((t) => t.status === st).length;
    const rows = base
      .filter((t) => !q.status?.length || q.status.includes(t.status))
      .sort((a, b) => {
        const sa = a.status === 'scheduled' ? 0 : 1;
        const sb = b.status === 'scheduled' ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return sa === 0
          ? a.scheduledAt.localeCompare(b.scheduledAt)
          : b.scheduledAt.localeCompare(a.scheduledAt);
      })
      .map((t) => presentTest(t, g.me));
    return HttpResponse.json(paginate(rows, q.page, q.perPage, counts));
  }),

  http.post(`${API}/tests`, async ({ request }) => {
    const g = guardAny(request, 'tests.manage', 'tests.conduct');
    if ('error' in g) return g.error;
    const parsed = createTestSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    const student = studentOf(input.studentId);
    if (!student || !seesStudent(g.me, input.studentId)) {
      return validationFailed([
        { path: ['studentId'], message: 'The selected student is invalid.' },
      ]);
    }
    let teacherId = isTestStaff(g.me)
      ? (input.teacherId ?? student.teacher?.id)
      : ownTeacherId(g.me);
    if (!teacherId) return testError(422, 'no_examiner', 'teacherId');
    if (!teacherOf(teacherId)) teacherId = student.teacher?.id;
    if (
      tdb.tests.some(
        (t) => t.studentId === student.id && t.track === input.track && t.status === 'scheduled',
      )
    ) {
      return testError(422, 'test_already_scheduled', 'track');
    }
    const row: TestRow = {
      id: tdb.nextId.test++,
      status: 'scheduled',
      statusReason: null,
      track: input.track,
      sections: orderedSections(input.sections),
      scheduledAt: new Date(input.scheduledAt).toISOString().replace('.000Z', 'Z'),
      durationMinutes: input.durationMinutes ?? 30,
      studentId: student.id,
      teacherId: teacherId!,
      createdBy: g.me.id,
      notes: input.notes ?? null,
      result: null,
      decidedAt: null,
      createdAt: iso(Date.now()),
    };
    tdb.tests.push(row);
    return HttpResponse.json({ data: presentTest(row, g.me) }, { status: 201 });
  }),

  http.get(`${API}/tests/:id`, ({ request, params }) => {
    const g = guard(request, 'tests.view');
    if ('error' in g) return g.error;
    const t = testOr404(params.id as string, g.me);
    return t ? HttpResponse.json({ data: presentTest(t, g.me) }) : notFound();
  }),

  http.patch(`${API}/tests/:id`, async ({ request, params }) => {
    const g = guardAny(request, 'tests.manage', 'tests.conduct');
    if ('error' in g) return g.error;
    const t = testOr404(params.id as string, g.me);
    if (!t) return notFound();
    const parsed = updateTestSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    if (!testCan(g.me, t).update) return testError(409, 'invalid_test_status');
    const input = parsed.data;
    if (input.sections) t.sections = orderedSections(input.sections);
    if (input.scheduledAt) t.scheduledAt = new Date(input.scheduledAt).toISOString();
    if (input.durationMinutes) t.durationMinutes = input.durationMinutes;
    if (input.teacherId && isTestStaff(g.me)) t.teacherId = input.teacherId;
    if (input.notes !== undefined) t.notes = input.notes;
    return HttpResponse.json({ data: presentTest(t, g.me) });
  }),

  http.put(`${API}/tests/:id/result`, async ({ request, params }) => {
    const g = guardAny(request, 'tests.manage', 'tests.conduct');
    if ('error' in g) return g.error;
    const t = testOr404(params.id as string, g.me);
    if (!t) return notFound();
    const can = testCan(g.me, t);
    const staff = isTestStaff(g.me);
    if (t.status === 'scheduled') {
      if (!can.update) return apiError(403, 'forbidden', 'Forbidden.');
      if (!can.record) return testError(409, 'test_not_started');
    } else if (t.status === 'taken') {
      if (!can.editResult) return testError(409, 'edit_window_closed');
    } else {
      return testError(409, 'invalid_test_status');
    }
    const parsed = recordTestResultSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    if (t.status === 'taken' && staff && !input.reason) {
      return testError(422, 'reason_required', 'reason');
    }
    const allowed = new Set(allowedMistakes(t.sections));
    if (input.mistakes.some((m) => !allowed.has(m))) {
      return testError(422, 'mistake_outside_sections', 'mistakes');
    }
    const field = (name: string) =>
      validationFailed([{ path: [name], message: 'This field is required.' }]);
    if (needsReading(t.track) && input.readingScore == null) return field('readingScore');
    if (needsHifz(t.track) && input.hifzScore == null) return field('hifzScore');
    const tajweed = tajweedScore(t.sections, input.mistakes);
    const reading = needsReading(t.track) ? (input.readingScore ?? 0) : null;
    const hifz = needsHifz(t.track) ? (input.hifzScore ?? 0) : null;
    const now = iso(Date.now());
    t.result = {
      tajweed,
      reading,
      hifz,
      overall: overallScore(t.track, tajweed, reading, hifz),
      mistakes: [...input.mistakes].sort((a, b) => a - b),
      remarks: input.remarks ?? null,
      internalNotes: input.internalNotes ?? null,
      teacherRating: staff
        ? (input.teacherRating ?? t.result?.teacherRating ?? null)
        : (t.result?.teacherRating ?? null),
      recordedAt: t.status === 'taken' && !staff ? (t.result?.recordedAt ?? now) : now,
    };
    if (t.status === 'scheduled') {
      t.status = 'taken';
      t.decidedAt = now;
    }
    return HttpResponse.json({ data: presentTest(t, g.me) });
  }),

  http.post(`${API}/tests/:id/:act`, async ({ request, params }) => {
    const act = params.act as string;
    if (!['refuse', 'cancel', 'reopen'].includes(act)) return notFound();
    const g =
      act === 'reopen'
        ? guard(request, 'tests.manage')
        : guardAny(request, 'tests.manage', 'tests.conduct');
    if ('error' in g) return g.error;
    const t = testOr404(params.id as string, g.me);
    if (!t) return notFound();
    const parsed = testReasonSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const can = testCan(g.me, t);
    const ok = act === 'refuse' ? can.refuse : act === 'cancel' ? can.cancel : can.reopen;
    if (!ok) return testError(409, 'invalid_test_status');
    if (
      act === 'reopen' &&
      tdb.tests.some(
        (x) =>
          x.id !== t.id &&
          x.studentId === t.studentId &&
          x.track === t.track &&
          x.status === 'scheduled',
      )
    ) {
      return testError(422, 'test_already_scheduled', 'track');
    }
    t.status = act === 'refuse' ? 'refused' : act === 'cancel' ? 'cancelled' : 'scheduled';
    t.statusReason = act === 'reopen' ? null : parsed.data.reason;
    t.decidedAt = act === 'reopen' ? null : iso(Date.now());
    return HttpResponse.json({ data: presentTest(t, g.me) });
  }),

  // ---------------------------------------------------------------- teacher portal
  http.get(`${API}/teacher-portal/week`, ({ request }) => {
    const g = guard(request, 'sessions.conduct');
    if ('error' in g) return g.error;
    if (!isTeacher(g.me) || !ownTeacherId(g.me)) return apiError(403, 'forbidden', 'Forbidden.');
    const parsed = teacherWeekQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    return HttpResponse.json({ data: weekOf(g.me, parsed.data.date) });
  }),

  http.get(`${API}/teacher-portal/students`, ({ request }) => {
    const g = guard(request, 'sessions.conduct');
    if ('error' in g) return g.error;
    const own = ownTeacherId(g.me);
    if (!isTeacher(g.me) || !own) return apiError(403, 'forbidden', 'Forbidden.');
    const now = Date.now();
    const students = people.students.filter(
      (s) => s.teacher?.id === own && !s.archive && s.status.value === 'active',
    );
    return HttpResponse.json({
      data: students.map((st) => {
        const mine = sdb.sessions.filter((s) => s.studentId === st.id && !s.deleted);
        const next = mine
          .filter((s) => s.stage === 'scheduled' && Date.parse(s.startsAt) > now)
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
        const last = mine
          .filter((s) => reportOf(s.id))
          .sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0];
        return {
          id: st.id,
          name: st.name,
          age: st.age,
          timezone: familyTz(st.id),
          remarkTeacher: st.remarkTeacher,
          enrollments: sdb.enrollments
            .filter((e) => e.student.id === st.id && e.teacher.id === own)
            .map((e) => ({ id: e.id, status: e.status, course: e.course })),
          nextSession: next ? { id: next.id, startsAt: next.startsAt } : null,
          lastReport: last
            ? { sessionId: last.id, submittedAt: reportOf(last.id)!.submittedAt }
            : null,
          reportsMissing: mine.filter(
            (s) =>
              s.stage === 'ended' || (s.stage === 'taken' && !reportOf(s.id) && now > dueAtOf(s)),
          ).length,
          lastPositions: lastPositionsOf(st.id),
        };
      }),
    });
  }),
];
