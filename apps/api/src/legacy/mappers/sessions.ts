import {
  bool,
  camelizeJson,
  dateOnly,
  int,
  json,
  localToUtc,
  minutesOfTime,
  oneOf,
  type Row,
  sessionStage,
  str,
  text,
} from '../convert.js';
import {
  batch,
  type MapContext,
  type ModuleMapper,
  type SelfRef,
  type TargetBatch,
} from '../plan.js';
import { fit, stamps, t } from './people.js';
import { reEncrypt } from './schedule.js';

const KINDS = ['regular', 'trial', 'rescheduled', 'advance', 'extra'] as const;
const SOURCES = ['generated', 'manual', 'request', 'migrated'] as const;
const ZOOM = ['none', 'pending', 'ready', 'failed', 'external', 'deleted'] as const;

/**
 * The class instant. `starts_at` (UTC, written by the M2 model) wins; a row the old admin wrote
 * without it has only `date` + `start_time`, which Laravel's `ClassSession::fillFromLegacy`
 * reads as academy-local wall time (Settings `academy.timezone`).
 */
export function classTiming(
  ctx: MapContext,
  r: Row,
): { startsAt: Date; endsAt: Date; durationMinutes: number; fromLegacy: boolean } | null {
  const duration = int(r, 'duration_minutes') ?? minutesOfTime(r.duration);
  const durationMinutes = duration && duration > 0 ? duration : 30;
  let startsAt = t(ctx, r.starts_at);
  let fromLegacy = false;
  if (!startsAt) {
    const date = str(r, 'date');
    const time = str(r, 'start_time');
    if (!date || !time || !dateOnly(date)) return null;
    startsAt = localToUtc(date.slice(0, 10), time, ctx.opts.academyTimezone);
    fromLegacy = true;
  }
  const stored = !fromLegacy ? t(ctx, r.ends_at) : null;
  const endsAt =
    stored && stored > startsAt ? stored : new Date(startsAt.getTime() + durationMinutes * 60_000);
  return { startsAt, endsAt, durationMinutes, fromLegacy };
}

export const sessionsMapper: ModuleMapper = {
  name: 'sessions',
  sources: ['classes', 'session_events', 'session_requests'],
  dependsOn: ['people', 'schedule'],
  tables: ['class_sessions', 'session_events', 'session_requests'],
  map(ctx: MapContext): TargetBatch[] {
    const out: TargetBatch[] = [];
    const sessions: Row[] = [];
    const origins: SelfRef = { column: 'origin_session_id', pairs: [] };
    const sessionStart = new Map<number, unknown>();
    const sessionEnd = new Map<number, unknown>();
    const slotKeys = new Set<string>();
    let legacyTimed = 0;

    for (const r of ctx.rows('classes')) {
      const id = int(r, 'id')!;
      const teacherId = int(r, 'teacher_id');
      const studentId = int(r, 'student_id');
      if (!ctx.has('teachers', teacherId) || !ctx.has('students', studentId)) {
        ctx.report.skip('classes', id, `teacher ${teacherId} or student ${studentId} not imported`);
        continue;
      }
      const timing = classTiming(ctx, r);
      if (!timing) {
        ctx.report.skip('classes', id, 'no starts_at and no valid legacy date/start_time');
        continue;
      }
      if (timing.fromLegacy) legacyTimed++;
      const stage = sessionStage(str(r, 'stage'), str(r, 'status'));
      let kind = oneOf(str(r, 'kind'), KINDS);
      if (!kind) {
        ctx.report.change('classes', id, `kind "${str(r, 'kind')}" unknown: regular`);
        kind = 'regular';
      }
      let scheduleSlotId = int(r, 'schedule_slot_id');
      if (scheduleSlotId !== null && !ctx.has('schedule_slots', scheduleSlotId)) {
        ctx.report.change(
          'classes',
          id,
          `schedule_slot_id=${scheduleSlotId} not imported: set to null`,
        );
        scheduleSlotId = null;
      }
      const occurrenceDate = dateOnly(r.occurrence_date);
      if (scheduleSlotId !== null && occurrenceDate) {
        const key = `${scheduleSlotId}:${occurrenceDate.toISOString()}`;
        if (slotKeys.has(key)) {
          ctx.report.change(
            'classes',
            id,
            'second class for the same slot and date: slot link cleared',
          );
          scheduleSlotId = null;
        } else slotKeys.add(key);
      }
      let enrollmentId = int(r, 'enrollment_id');
      if (enrollmentId !== null && !ctx.has('enrollments', enrollmentId)) {
        ctx.report.change('classes', id, `enrollment_id=${enrollmentId} not imported: set to null`);
        enrollmentId = null;
      }
      const origin = int(r, 'origin_session_id');
      if (origin !== null) origins.pairs.push([id, origin]);
      let zoomStatus = oneOf(str(r, 'zoom_status'), ZOOM) ?? 'none';
      const joinUrl = reEncrypt(ctx, 'classes', id, 'zoom_join_url', str(r, 'zoom_join_url'));
      if (str(r, 'zoom_join_url') && !joinUrl && zoomStatus === 'ready') zoomStatus = 'pending';
      const { createdAt, updatedAt } = stamps(ctx, r);
      sessions.push({
        id,
        enrollmentId,
        scheduleSlotId,
        occurrenceDate: scheduleSlotId !== null ? occurrenceDate : occurrenceDate,
        teacherId,
        studentId,
        courseId: ctx.ref('courses', int(r, 'course_id'), 'classes', id, 'course_id'),
        startsAt: timing.startsAt,
        endsAt: timing.endsAt,
        durationMinutes: timing.durationMinutes,
        kind,
        stage,
        stageReason: fit(ctx, 'classes', id, 'stage_reason', text(r, 'stage_reason'), 32),
        originSessionId: null,
        source: oneOf(str(r, 'source'), SOURCES) ?? 'migrated',
        isDetached: bool(r, 'is_detached') ?? false,
        activatedAt: t(ctx, r.activated_at),
        startedAt: t(ctx, r.started_at),
        endedAt: t(ctx, r.ended_at),
        markedAt: t(ctx, r.marked_at),
        markedById: ctx.has('users', int(r, 'marked_by')) ? int(r, 'marked_by') : null,
        needsReview: bool(r, 'needs_review') ?? false,
        reviewReason: fit(ctx, 'classes', id, 'review_reason', text(r, 'review_reason'), 32),
        zoomStatus,
        zoomMeetingId: fit(ctx, 'classes', id, 'zoom_meeting_id', text(r, 'zoom_meeting_id'), 32),
        zoomHostId: ctx.has('zoom_hosts', int(r, 'zoom_host_id')) ? int(r, 'zoom_host_id') : null,
        zoomJoinUrl: joinUrl,
        zoomError: fit(ctx, 'classes', id, 'zoom_error', text(r, 'zoom_error'), 255),
        actualStartedAt: t(ctx, r.actual_started_at),
        actualEndedAt: t(ctx, r.actual_ended_at),
        teacherJoinedAt: t(ctx, r.teacher_joined_at),
        studentJoinedAt: t(ctx, r.student_joined_at),
        payHours: str(r, 'pay_hours'),
        payRuleKey: fit(ctx, 'classes', id, 'pay_rule_key', text(r, 'pay_rule_key'), 40),
        payRuleSetId: ctx.has('pay_rule_sets', int(r, 'pay_rule_set_id'))
          ? int(r, 'pay_rule_set_id')
          : null,
        billable: bool(r, 'billable'),
        lockVersion: int(r, 'lock_version') ?? 0,
        createdById: ctx.has('users', int(r, 'created_by')) ? int(r, 'created_by') : null,
        deletedAt: t(ctx, r.deleted_at),
        createdAt,
        updatedAt,
      });
      sessionStart.set(id, timing.startsAt);
      sessionEnd.set(id, timing.endsAt);
    }
    ctx.remember(
      'class_sessions',
      sessions.map((s) => s.id as number),
    );
    origins.pairs = origins.pairs.filter(([id, ref]) => {
      if (ctx.has('class_sessions', ref)) return true;
      ctx.report.change('classes', id, `origin_session_id=${ref} not imported: set to null`);
      return false;
    });
    ctx.lookups.set('sessionStart', sessionStart);
    ctx.lookups.set('sessionEnd', sessionEnd);
    if (legacyTimed) {
      ctx.report.warn(
        'classes',
        `${legacyTimed} class(es) had no starts_at: timed from date + start_time in ${ctx.opts.academyTimezone}`,
      );
    }
    ctx.dropped('classes', ['teacher_note', 'teacher_transaction_id']);
    out.push(
      batch(
        'class_sessions',
        'classSession',
        'classes',
        ctx.rows('classes').length,
        sessions,
        true,
        [origins],
      ),
    );

    const events: Row[] = [];
    for (const r of ctx.rows('session_events')) {
      const sessionId = int(r, 'session_id');
      if (!ctx.has('class_sessions', sessionId)) {
        ctx.report.skip('session_events', r.id, `class ${sessionId} not imported`);
        continue;
      }
      events.push({
        id: int(r, 'id')!,
        sessionId,
        type: fit(ctx, 'session_events', r.id, 'type', text(r, 'type') ?? 'note', 32),
        fromStage: text(r, 'from_stage'),
        toStage: text(r, 'to_stage'),
        actorUserId: ctx.has('users', int(r, 'actor_user_id')) ? int(r, 'actor_user_id') : null,
        actorRole: fit(ctx, 'session_events', r.id, 'actor_role', text(r, 'actor_role'), 100),
        payload: camelizeJson(json(r, 'payload')) ?? undefined,
        occurredAt: t(ctx, r.occurred_at) ?? ctx.opts.fallbackNow,
      });
    }
    out.push(
      batch(
        'session_events',
        'sessionEvent',
        'session_events',
        ctx.rows('session_events').length,
        events,
      ),
    );

    const requests: Row[] = [];
    const pending = new Set<string>();
    for (const r of ctx.rows('session_requests')) {
      const id = int(r, 'id')!;
      const sessionId = int(r, 'session_id');
      const type = oneOf(str(r, 'type'), ['leave', 'reschedule', 'advance', 'extra'] as const);
      const status = oneOf(str(r, 'status'), [
        'pending',
        'approved',
        'auto_approved',
        'rejected',
        'cancelled',
        'expired',
      ] as const);
      const studentId = int(r, 'student_id');
      const requestedById = int(r, 'requested_by');
      if (!ctx.has('class_sessions', sessionId)) {
        ctx.report.skip(
          'session_requests',
          id,
          sessionId === null
            ? `${type ?? '?'} request without a class (the new schema needs one)`
            : `class ${sessionId} not imported`,
        );
        continue;
      }
      if (!type || !status || !ctx.has('students', studentId) || !ctx.has('users', requestedById)) {
        ctx.report.skip(
          'session_requests',
          id,
          `type/status unknown or student ${studentId} / requester ${requestedById} missing`,
        );
        continue;
      }
      if (status === 'pending') {
        const key = `${sessionId}:${type}`;
        if (pending.has(key)) {
          ctx.report.skip(
            'session_requests',
            id,
            'second pending request of the same type for the class',
          );
          continue;
        }
        pending.add(key);
      }
      requests.push({
        id,
        type,
        sessionId,
        enrollmentId: ctx.has('enrollments', int(r, 'enrollment_id'))
          ? int(r, 'enrollment_id')
          : null,
        studentId,
        requestedById,
        requesterRole: fit(
          ctx,
          'session_requests',
          id,
          'requester_role',
          text(r, 'requester_role'),
          100,
        ),
        reason: str(r, 'reason') ?? '',
        notifiedAt: t(ctx, r.notified_at),
        proposedStartsAt: t(ctx, r.proposed_starts_at),
        proposedDurationMinutes: int(r, 'proposed_duration_minutes'),
        proposedTeacherId: int(r, 'proposed_teacher_id'),
        status,
        decidedById: ctx.has('users', int(r, 'decided_by')) ? int(r, 'decided_by') : null,
        decidedAt: t(ctx, r.decided_at),
        decisionNote: text(r, 'decision_note'),
        resultSessionId: ctx.ref(
          'class_sessions',
          int(r, 'result_session_id'),
          'session_requests',
          id,
          'result_session_id',
        ),
        lockVersion: int(r, 'lock_version') ?? 0,
        ...stamps(ctx, r),
      });
    }
    ctx.dropped('session_requests', ['sla_due_at', 'sla_breach_notified_at']);
    out.push(
      batch(
        'session_requests',
        'sessionRequest',
        'session_requests',
        ctx.rows('session_requests').length,
        requests,
      ),
    );
    return out;
  },
};
