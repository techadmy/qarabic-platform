import type { LessonReportDto } from '@qarabic/shared';
import type { MockUser } from './data';
import { sdb, type SessionRow } from './schedule-db';
import { tdb } from './teaching-db';

/**
 * Lesson report rules shared by the class presenter and the N3 handlers (apps/api
 * `reportEditableUntil`, `attentionFor`): the teacher may edit for `sessions.report_edit_hours`
 * from the submission; a class ended (or taken without a report) past `sessions.report_due_hours`
 * is `report_missing`. Parents never get the internal note, the authors or the edit time.
 */
const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

export const reportOf = (sessionId: number) => tdb.reports.get(sessionId) ?? null;

export function editableUntil(s: SessionRow): string | null {
  if (s.stage !== 'taken') return null;
  const from = reportOf(s.id)?.submittedAt ?? s.markedAt;
  return from ? iso(Date.parse(from) + sdb.settings['sessions.report_edit_hours'] * HOUR) : null;
}

export function dueAtOf(s: SessionRow): number {
  const ended = s.endedAt
    ? Date.parse(s.endedAt)
    : Date.parse(s.startsAt) + s.durationMinutes * MIN;
  return ended + sdb.settings['sessions.report_due_hours'] * HOUR;
}

export function reportMissing(s: SessionRow, now = Date.now()): boolean {
  return (s.stage === 'ended' || s.stage === 'taken') && !reportOf(s.id) && now > dueAtOf(s);
}

const isParent = (me: MockUser) => me.role?.kind === 'parent';

export function presentReport(s: SessionRow, me: MockUser): LessonReportDto | null {
  const r = reportOf(s.id);
  if (!r) return null;
  const parent = isParent(me);
  const showRating = !parent || sdb.settings['reports.parent_sees_rating'];
  return {
    id: r.id,
    sessionId: s.id,
    studentId: s.studentId,
    teacherId: s.teacherId,
    summary: r.summary,
    homework: r.homework,
    tajweedNotes: r.tajweedNotes,
    ...(parent ? {} : { teacherNotes: r.teacherNotes }),
    ...(showRating ? { rating: r.rating } : {}),
    hifz: r.hifz,
    dueAt: r.dueAt,
    late: r.late,
    submittedAt: r.submittedAt,
    updatedAt: r.updatedAt,
    ...(parent
      ? {}
      : {
          submittedBy: r.submittedBy,
          updatedBy: r.updatedBy,
          editableUntil: editableUntil(s),
        }),
  };
}
