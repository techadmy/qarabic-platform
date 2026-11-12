import {
  bool,
  camelizeJson,
  dateOnly,
  hhmm,
  int,
  isZone,
  json,
  oneOf,
  type Row,
  str,
  text,
  zoneOr,
} from '../convert.js';
import { batch, type MapContext, type ModuleMapper, type TargetBatch } from '../plan.js';
import { fit, stamps, t } from './people.js';

/** A Laravel `encrypted` value (meeting link) → the new `v1:` AES-GCM form, or null (reported). */
export function reEncrypt(
  ctx: MapContext,
  table: string,
  id: unknown,
  col: string,
  stored: string | null,
): string | null {
  if (!stored) return null;
  if (!ctx.opts.legacyCipher) {
    ctx.report.change(
      table,
      id,
      `${col} is encrypted with the old APP_KEY and LEGACY_APP_KEY is not set: left empty`,
    );
    return null;
  }
  const plain = ctx.opts.legacyCipher.decrypt(stored);
  if (plain === null) {
    ctx.report.change(table, id, `${col} cannot be decrypted with LEGACY_APP_KEY: left empty`);
    return null;
  }
  return ctx.opts.targetCipher.encrypt(plain);
}

export const scheduleMapper: ModuleMapper = {
  name: 'schedule',
  sources: [
    'holidays',
    'zoom_hosts',
    'teacher_work_hours',
    'teacher_blocks',
    'pay_rule_sets',
    'enrollments',
    'schedule_slots',
  ],
  dependsOn: ['people'],
  tables: [
    'holidays',
    'zoom_hosts',
    'teacher_work_hours',
    'teacher_blocks',
    'pay_rule_sets',
    'enrollments',
    'schedule_slots',
  ],
  map(ctx: MapContext): TargetBatch[] {
    const out: TargetBatch[] = [];

    const holidays = ctx.rows('holidays').map((r) => {
      const date = dateOnly(r.date);
      let endsOn = dateOnly(r.ends_on);
      if (endsOn && date && endsOn < date) {
        ctx.report.change('holidays', r.id, 'ends_on before date: cleared (one-day holiday)');
        endsOn = null;
      }
      return {
        id: int(r, 'id')!,
        name: fit(ctx, 'holidays', r.id, 'name', text(r, 'name') ?? 'Holiday', 255),
        date,
        endsOn,
        paid: bool(r, 'paid') ?? true,
        appliesTo: fit(ctx, 'holidays', r.id, 'applies_to', text(r, 'applies_to') ?? 'all', 16),
        ...stamps(ctx, r),
      };
    });
    out.push(batch('holidays', 'holiday', 'holidays', ctx.rows('holidays').length, holidays));

    const hosts = ctx.rows('zoom_hosts').map((r) => ({
      id: int(r, 'id')!,
      zoomUserId: str(r, 'zoom_user_id'),
      email: str(r, 'email'),
      label: fit(ctx, 'zoom_hosts', r.id, 'label', text(r, 'label'), 100),
      teacherId: ctx.ref('teachers', int(r, 'teacher_id'), 'zoom_hosts', r.id, 'teacher_id'),
      isActive: bool(r, 'is_active') ?? true,
      ...stamps(ctx, r),
    }));
    ctx.remember(
      'zoom_hosts',
      hosts.map((h) => h.id),
    );
    out.push(batch('zoom_hosts', 'zoomHost', 'zoom_hosts', ctx.rows('zoom_hosts').length, hosts));

    const hours: Row[] = [];
    for (const r of ctx.rows('teacher_work_hours')) {
      const teacherId = int(r, 'teacher_id');
      const wd = int(r, 'weekday') ?? 0;
      if (
        !ctx.has('teachers', teacherId) ||
        wd < 1 ||
        wd > 7 ||
        !hhmm(r.local_start_time) ||
        !hhmm(r.local_end_time)
      ) {
        ctx.report.skip(
          'teacher_work_hours',
          r.id,
          `teacher ${teacherId} missing or weekday/time invalid`,
        );
        continue;
      }
      hours.push({
        id: int(r, 'id')!,
        teacherId,
        weekday: int(r, 'weekday'),
        localStartTime: hhmm(r.local_start_time),
        localEndTime: hhmm(r.local_end_time),
        timezone: zoneOr(text(r, 'timezone'), 'Africa/Cairo'),
        createdAt: stamps(ctx, r).createdAt,
      });
    }
    out.push(
      batch(
        'teacher_work_hours',
        'teacherWorkHour',
        'teacher_work_hours',
        ctx.rows('teacher_work_hours').length,
        hours,
      ),
    );

    const blocks: Row[] = [];
    for (const r of ctx.rows('teacher_blocks')) {
      const teacherId = int(r, 'teacher_id');
      if (t(ctx, r.deleted_at)) {
        ctx.report.skip('teacher_blocks', r.id, 'soft-deleted (no longer in force)');
        continue;
      }
      const kind = oneOf(str(r, 'kind'), ['recurring', 'one_off'] as const);
      if (!ctx.has('teachers', teacherId) || !kind) {
        ctx.report.skip(
          'teacher_blocks',
          r.id,
          !kind ? `kind "${str(r, 'kind')}" unknown` : `teacher ${teacherId} missing`,
        );
        continue;
      }
      blocks.push({
        id: int(r, 'id')!,
        teacherId,
        kind,
        reason: fit(ctx, 'teacher_blocks', r.id, 'reason', text(r, 'reason') ?? 'other', 16),
        weekday: int(r, 'weekday'),
        localStartTime: hhmm(r.local_start_time),
        durationMinutes: int(r, 'duration_minutes'),
        timezone: text(r, 'timezone'),
        validFrom: dateOnly(r.valid_from),
        validTo: dateOnly(r.valid_to),
        startsAt: t(ctx, r.starts_at),
        endsAt: t(ctx, r.ends_at),
        note: fit(ctx, 'teacher_blocks', r.id, 'note', text(r, 'note'), 500),
        createdById: ctx.has('users', int(r, 'created_by')) ? int(r, 'created_by') : null,
        ...stamps(ctx, r),
      });
    }
    out.push(
      batch(
        'teacher_blocks',
        'teacherBlock',
        'teacher_blocks',
        ctx.rows('teacher_blocks').length,
        blocks,
      ),
    );

    // Pay rule sets (immutable versions): `paid_holiday_only` → `paidHolidayOnly`.
    const rules = ctx.rows('pay_rule_sets').map((r) => ({
      id: int(r, 'id')!,
      effectiveFrom: t(ctx, r.effective_from),
      rules: camelizeJson(json(r, 'rules') ?? {}),
      note: fit(ctx, 'pay_rule_sets', r.id, 'note', text(r, 'note'), 255),
      createdById: ctx.has('users', int(r, 'created_by')) ? int(r, 'created_by') : null,
      createdAt: stamps(ctx, r).createdAt,
    }));
    ctx.remember(
      'pay_rule_sets',
      rules.map((r) => r.id),
    );
    out.push(
      batch(
        'pay_rule_sets',
        'payRuleSet',
        'pay_rule_sets',
        ctx.rows('pay_rule_sets').length,
        rules,
      ),
    );

    // Enrollments. At most one live (active/paused) per student and course (partial unique index).
    const enrollments: Row[] = [];
    const live = new Map<string, Row>();
    for (const r of ctx.rows('enrollments')) {
      const id = int(r, 'id')!;
      if (t(ctx, r.deleted_at)) {
        ctx.report.skip(
          'enrollments',
          id,
          'soft-deleted enrollment (the new schema has no deleted enrollments; its classes keep their data without the link)',
        );
        continue;
      }
      const studentId = int(r, 'student_id');
      const courseId = int(r, 'course_id');
      const teacherId = int(r, 'teacher_id');
      if (
        !ctx.has('students', studentId) ||
        !ctx.has('courses', courseId) ||
        !ctx.has('teachers', teacherId)
      ) {
        ctx.report.skip(
          'enrollments',
          id,
          `student ${studentId}, course ${courseId} or teacher ${teacherId} missing`,
        );
        continue;
      }
      let status = oneOf(str(r, 'status'), ['active', 'paused', 'ended'] as const);
      if (!status) {
        ctx.report.change('enrollments', id, `status "${str(r, 'status')}" unknown: ended`);
        status = 'ended';
      }
      const kind = oneOf(str(r, 'kind'), ['regular', 'trial'] as const) ?? 'regular';
      const tz = text(r, 'timezone');
      if (!isZone(tz))
        ctx.report.change('enrollments', id, `timezone "${tz}" invalid: Africa/Cairo`);
      const row: Row = {
        id,
        studentId,
        courseId,
        teacherId,
        kind,
        status,
        pausedReason:
          status === 'paused'
            ? fit(ctx, 'enrollments', id, 'paused_reason', text(r, 'paused_reason'), 32)
            : null,
        startsOn: dateOnly(r.starts_on),
        endsOn: dateOnly(r.ends_on),
        sessionMinutes: int(r, 'session_minutes') ?? 30,
        timezone: zoneOr(tz, 'Africa/Cairo'),
        meetingMode: oneOf(str(r, 'meeting_mode'), ['zoom', 'external'] as const) ?? 'zoom',
        externalMeetingUrl: reEncrypt(
          ctx,
          'enrollments',
          id,
          'external_meeting_url',
          str(r, 'external_meeting_url'),
        ),
        notes: text(r, 'notes'),
        createdById: ctx.has('users', int(r, 'created_by')) ? int(r, 'created_by') : null,
        ...stamps(ctx, r),
      };
      if (status !== 'ended') {
        const key = `${studentId}:${courseId}`;
        const prev = live.get(key);
        if (prev) {
          // Keep the newest live one; the older is ended (the new schema allows one live pair).
          prev.status = 'ended';
          prev.pausedReason = null;
          ctx.report.change(
            'enrollments',
            prev.id,
            `second live enrollment of student ${studentId} / course ${courseId} (newer #${id}): ended`,
          );
        }
        live.set(key, row);
      }
      enrollments.push(row);
    }
    ctx.remember(
      'enrollments',
      enrollments.map((e) => e.id as number),
    );
    ctx.dropped('enrollments', ['package_id'], ctx.rows('enrollments'));
    out.push(
      batch(
        'enrollments',
        'enrollment',
        'enrollments',
        ctx.rows('enrollments').length,
        enrollments,
      ),
    );

    const slots: Row[] = [];
    for (const r of ctx.rows('schedule_slots')) {
      const id = int(r, 'id')!;
      if (t(ctx, r.deleted_at)) {
        ctx.report.skip('schedule_slots', id, 'soft-deleted weekly time');
        continue;
      }
      const enrollmentId = int(r, 'enrollment_id');
      const teacherId = int(r, 'teacher_id');
      if (!ctx.has('enrollments', enrollmentId) || !ctx.has('teachers', teacherId)) {
        ctx.report.skip(
          'schedule_slots',
          id,
          `enrollment ${enrollmentId} or teacher ${teacherId} not imported`,
        );
        continue;
      }
      const weekday = int(r, 'weekday') ?? 0;
      const start = hhmm(r.local_start_time);
      const minutes = int(r, 'duration_minutes') ?? 0;
      const from = dateOnly(r.valid_from);
      const to = dateOnly(r.valid_to);
      if (weekday < 1 || weekday > 7 || !start || minutes < 5 || minutes > 1440 || !from) {
        ctx.report.skip(
          'schedule_slots',
          id,
          `weekday ${weekday}, time ${start}, duration ${minutes} or valid_from invalid`,
        );
        continue;
      }
      if (to && to.getTime() < from.getTime() - 86_400_000) {
        ctx.report.skip('schedule_slots', id, 'valid_to before valid_from');
        continue;
      }
      slots.push({
        id,
        enrollmentId,
        teacherId,
        weekday: int(r, 'weekday'),
        localStartTime: hhmm(r.local_start_time),
        durationMinutes: int(r, 'duration_minutes'),
        timezone: zoneOr(text(r, 'timezone'), 'Africa/Cairo'),
        validFrom: dateOnly(r.valid_from),
        validTo: dateOnly(r.valid_to),
        createdById: ctx.has('users', int(r, 'created_by')) ? int(r, 'created_by') : null,
        ...stamps(ctx, r),
      });
    }
    ctx.remember(
      'schedule_slots',
      slots.map((s) => s.id as number),
    );
    out.push(
      batch(
        'schedule_slots',
        'scheduleSlot',
        'schedule_slots',
        ctx.rows('schedule_slots').length,
        slots,
      ),
    );
    return out;
  },
};
