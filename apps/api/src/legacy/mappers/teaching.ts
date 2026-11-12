import { ayahCountOf, ayahsInRange } from '@qarabic/shared';
import { int, json, oneOf, type Row, str, text } from '../convert.js';
import { batch, type MapContext, type ModuleMapper, type TargetBatch } from '../plan.js';
import { fit, stamps, t } from './people.js';

const HOUR = 3_600_000;

/** A 0–100 score; anything else is reported and left empty (CHECK constraint). */
function pct(ctx: MapContext, id: number, r: Row, col: string): number | null {
  const v = int(r, col);
  if (v === null || (v >= 0 && v <= 100)) return v;
  ctx.report.change('student_tests', id, `${col} ${v} is outside 0–100: left empty`);
  return null;
}

export const teachingMapper: ModuleMapper = {
  name: 'teaching',
  sources: ['lesson_reports', 'hifz_entries', 'student_tests'],
  dependsOn: ['people', 'sessions'],
  tables: ['lesson_reports', 'hifz_entries', 'student_tests'],
  map(ctx: MapContext): TargetBatch[] {
    const out: TargetBatch[] = [];
    const ends = ctx.lookups.get('sessionEnd') ?? new Map<number, unknown>();
    const starts = ctx.lookups.get('sessionStart') ?? new Map<number, unknown>();

    // Reports. due_at / submitted_late are new: end of class + `sessions.report_due_hours`.
    const reports: Row[] = [];
    const reportSession = new Map<number, number>();
    const seenSession = new Set<number>();
    for (const r of ctx.rows('lesson_reports')) {
      const id = int(r, 'id')!;
      const sessionId = int(r, 'session_id');
      if (
        !ctx.has('class_sessions', sessionId) ||
        !ctx.has('students', int(r, 'student_id')) ||
        !ctx.has('teachers', int(r, 'teacher_id'))
      ) {
        ctx.report.skip(
          'lesson_reports',
          id,
          `class ${sessionId}, student or teacher not imported`,
        );
        continue;
      }
      if (seenSession.has(sessionId!)) {
        ctx.report.skip('lesson_reports', id, `second report for class ${sessionId}`);
        continue;
      }
      seenSession.add(sessionId!);
      const submittedAt = t(ctx, r.submitted_at) ?? stamps(ctx, r).createdAt;
      const end = ends.get(sessionId!) as Date;
      const dueAt = new Date(end.getTime() + ctx.opts.reportDueHours * HOUR);
      const behaviour = int(r, 'behaviour');
      reports.push({
        id,
        sessionId,
        studentId: int(r, 'student_id'),
        teacherId: int(r, 'teacher_id'),
        summary: str(r, 'summary') ?? '',
        homework: text(r, 'homework'),
        tajweedNotes: null,
        teacherNotes: text(r, 'teacher_notes'),
        rating: behaviour !== null && behaviour >= 1 && behaviour <= 5 ? behaviour : null,
        dueAt,
        submittedLate: submittedAt.getTime() > dueAt.getTime(),
        submittedById: ctx.has('users', int(r, 'submitted_by')) ? int(r, 'submitted_by') : null,
        submittedAt,
        updatedById: null,
        ...stamps(ctx, r),
      });
      reportSession.set(id, sessionId!);
    }
    ctx.remember(
      'lesson_reports',
      reports.map((x) => x.id as number),
    );
    ctx.dropped('lesson_reports', ['lesson_id']);
    out.push(
      batch(
        'lesson_reports',
        'lessonReport',
        'lesson_reports',
        ctx.rows('lesson_reports').length,
        reports,
      ),
    );

    // Hifz rows need a full surah/ayah range (the new schema computes `ayahs` from it).
    const hifz: Row[] = [];
    const position = new Map<number, number>();
    for (const r of ctx.rows('hifz_entries')) {
      const id = int(r, 'id')!;
      const reportId = int(r, 'lesson_report_id');
      if (!ctx.has('lesson_reports', reportId)) {
        ctx.report.skip('hifz_entries', id, `report ${reportId} not imported`);
        continue;
      }
      const type = oneOf(str(r, 'type'), ['sabaq', 'sabaqi', 'manzil'] as const);
      const from = { surah: int(r, 'from_surah') ?? 0, ayah: int(r, 'from_ayah') ?? 0 };
      const to = { surah: int(r, 'to_surah') ?? 0, ayah: int(r, 'to_ayah') ?? 0 };
      const valid = (p: { surah: number; ayah: number }) =>
        p.surah >= 1 && p.surah <= 114 && p.ayah >= 1;
      if (!type || !valid(from) || !valid(to)) {
        const legacy = text(r, 'legacy_text');
        ctx.report.skip(
          'hifz_entries',
          id,
          `no valid surah/ayah range (${from.surah}:${from.ayah} → ${to.surah}:${to.ayah})${legacy ? ` (old free text: "${legacy.slice(0, 60)}")` : ''}`,
        );
        continue;
      }
      if (from.ayah > ayahCountOf(from.surah) || to.ayah > ayahCountOf(to.surah)) {
        ctx.report.change(
          'hifz_entries',
          id,
          `ayah beyond the surah's length (${from.surah}:${from.ayah} → ${to.surah}:${to.ayah}): kept as entered`,
        );
      }
      const sessionId = reportSession.get(reportId!)!;
      const pos = position.get(reportId!) ?? 0;
      position.set(reportId!, pos + 1);
      hifz.push({
        id,
        reportId,
        sessionId,
        studentId: int(r, 'student_id'),
        position: pos,
        type,
        fromSurah: from.surah,
        fromAyah: from.ayah,
        toSurah: to.surah,
        toAyah: to.ayah,
        ayahs: ayahsInRange(from, to),
        pages: null,
        grade: oneOf(str(r, 'grade'), [
          'excellent',
          'very_good',
          'good',
          'needs_work',
          'not_memorised',
        ] as const),
        mistakes: int(r, 'mistakes'),
        notes: fit(ctx, 'hifz_entries', id, 'notes', text(r, 'notes'), 500),
        lessonAt: starts.get(sessionId),
        createdAt: stamps(ctx, r).createdAt,
      });
    }
    out.push(
      batch('hifz_entries', 'hifzEntry', 'hifz_entries', ctx.rows('hifz_entries').length, hifz),
    );

    // Tests (one scheduled test per student and track: partial unique index).
    const tests: Row[] = [];
    const open = new Set<string>();
    for (const r of ctx.rows('student_tests')) {
      const id = int(r, 'id')!;
      const track = oneOf(str(r, 'track'), ['qaida', 'nazra', 'hifz'] as const);
      const status = oneOf(str(r, 'status'), [
        'scheduled',
        'taken',
        'refused',
        'cancelled',
      ] as const);
      if (
        !track ||
        !status ||
        !ctx.has('students', int(r, 'student_id')) ||
        !ctx.has('teachers', int(r, 'teacher_id'))
      ) {
        ctx.report.skip(
          'student_tests',
          id,
          'track/status unknown or student/teacher not imported',
        );
        continue;
      }
      if (status === 'scheduled') {
        const key = `${int(r, 'student_id')}:${track}`;
        if (open.has(key)) {
          ctx.report.skip('student_tests', id, 'second scheduled test of the same track');
          continue;
        }
        open.add(key);
      }
      const sections = json(r, 'sections');
      const mistakes = json(r, 'mistakes');
      tests.push({
        id,
        studentId: int(r, 'student_id'),
        teacherId: int(r, 'teacher_id'),
        courseId: ctx.has('courses', int(r, 'course_id')) ? int(r, 'course_id') : null,
        track,
        sections: Array.isArray(sections) ? sections.map(String) : [],
        scheduledAt: t(ctx, r.scheduled_at),
        durationMinutes: int(r, 'duration_minutes') ?? 30,
        studentTimezone: text(r, 'student_timezone') ?? 'Africa/Cairo',
        notes: text(r, 'notes'),
        status,
        statusReason: fit(ctx, 'student_tests', id, 'status_reason', text(r, 'status_reason'), 500),
        tajweedScore: pct(ctx, id, r, 'tajweed_score'),
        readingScore: pct(ctx, id, r, 'reading_score'),
        hifzScore: pct(ctx, id, r, 'hifz_score'),
        overallScore: pct(ctx, id, r, 'overall_score'),
        mistakes: Array.isArray(mistakes)
          ? [...new Set(mistakes.map(Number).filter(Number.isInteger))].sort((a, b) => a - b)
          : [],
        remarks: text(r, 'remarks'),
        internalNotes: text(r, 'internal_notes'),
        teacherRating: pct(ctx, id, r, 'teacher_rating'),
        recordedAt: t(ctx, r.recorded_at),
        recordedById: ctx.has('users', int(r, 'recorded_by')) ? int(r, 'recorded_by') : null,
        createdById: ctx.has('users', int(r, 'created_by')) ? int(r, 'created_by') : null,
        decidedById: ctx.has('users', int(r, 'decided_by')) ? int(r, 'decided_by') : null,
        decidedAt: t(ctx, r.decided_at),
        legacyId: int(r, 'legacy_id'),
        ...stamps(ctx, r),
      });
    }
    out.push(
      batch(
        'student_tests',
        'studentTest',
        'student_tests',
        ctx.rows('student_tests').length,
        tests,
      ),
    );
    return out;
  },
};
