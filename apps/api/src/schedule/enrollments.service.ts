import { Injectable } from '@nestjs/common';
import {
  type addSlotSchema,
  type createEnrollmentSchema,
  ENROLLMENT_STATUSES,
  type EnrollmentDetailDto,
  type EnrollmentDto,
  type enrollmentListQuerySchema,
  OCCUPYING_STAGES,
  type Paginated,
  type ScheduleSlotDto,
  type SessionDto,
  type updateEnrollmentSchema,
  type updateSlotSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { pageArgs, pageMeta, statusCounts } from '../common/pagination.js';
import { contains } from '../common/search.js';
import { Prisma } from '../generated/prisma/client.js';
import type { EnrollmentStatus } from '../generated/prisma/enums.js';
import { invalid, recordStatusChange, type Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { conflictState } from '../sessions/errors.js';
import { SessionPresenter, sessionInclude } from '../sessions/presenter.js';
import { type ResyncScope, ResyncService } from '../sessions/resync.js';
import { ZoomDriver } from '../sessions/zoom.js';
import { SettingsService, type SettingsMap } from '../settings/settings.service.js';
import {
  ConflictChecker,
  ConflictResult,
  patternOf,
  type SlotCandidate,
  validBetween,
  zoneOr,
} from './conflicts.js';
import {
  assertStaffOrTeacher,
  enrollmentScopeWhere,
  LIVE_ENROLLMENT,
  viewerScope,
} from './scope.js';
import {
  addDays,
  fromDbDate,
  isoZ,
  local,
  localDate,
  maxDate,
  OffsetProbe,
  toDbDate,
  toUtc,
} from './time.js';

const include = {
  student: {
    select: { id: true, name: true, familyId: true, family: { select: { timezone: true } } },
  },
  course: { select: { id: true, nameAr: true, nameEn: true } },
  teacher: { select: { id: true, firstName: true, lastName: true, timezone: true } },
  slots: {
    include: { teacher: { select: { timezone: true } } },
    orderBy: [{ weekday: 'asc' }, { localStartTime: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.EnrollmentInclude;
type Row = Prisma.EnrollmentGetPayload<{ include: typeof include }>;

export const slotDtoInclude = {
  teacher: { select: { timezone: true } },
  enrollment: {
    select: { student: { select: { name: true } }, course: { select: { nameAr: true } } },
  },
} satisfies Prisma.ScheduleSlotInclude;
type SlotRow = Prisma.ScheduleSlotGetPayload<{ include: typeof slotDtoInclude }>;

const MANUAL_EVENT_TYPES = ['generated', 'migrated', 'zoom_created', 'zoom_updated', 'zoom_failed'];

type CreateInput = z.output<typeof createEnrollmentSchema>;
type UpdateInput = z.output<typeof updateEnrollmentSchema>;

const name = (t: { firstName: string; lastName: string | null }) =>
  [t.firstName, t.lastName].filter(Boolean).join(' ');

/**
 * Enrollments and weekly slots (docs/14 §2.2, §2.3), port of Laravel `EnrollmentService`. Slots
 * are versioned, never edited in place. Every write is conflict-checked under row locks, then
 * re-syncs future generated classes; classes a person touched are only reported
 * (`affectedManualSessions`), never changed.
 */
@Injectable()
export class EnrollmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checker: ConflictChecker,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly resync: ResyncService,
    private readonly presenter: SessionPresenter,
    private readonly zoom: ZoomDriver,
  ) {}

  // ------------------------------------------------------------------ reads

  async list(
    q: z.output<typeof enrollmentListQuerySchema>,
    viewer: AuthUser,
  ): Promise<Paginated<EnrollmentDto>> {
    assertStaffOrTeacher(viewer, 'schedule.view');
    const scope = await viewerScope(this.prisma, viewer);
    const and: Prisma.EnrollmentWhereInput[] = [enrollmentScopeWhere(scope)];
    if (q.studentId) and.push({ studentId: q.studentId });
    if (q.teacherId) and.push({ teacherId: q.teacherId });
    if (q.courseId) and.push({ courseId: q.courseId });
    if (q.q) {
      // "Search by student or teacher".
      and.push({
        OR: [
          { student: { name: contains(q.q) } },
          { teacher: { firstName: contains(q.q) } },
          { teacher: { lastName: contains(q.q) } },
        ],
      });
    }
    const where: Prisma.EnrollmentWhereInput = { AND: and };
    const listWhere = q.status ? { AND: [...and, { status: q.status }] } : where;
    const [rows, total, groups, st] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: listWhere,
        include,
        orderBy: { id: q.order ?? 'desc' },
        ...pageArgs(q),
      }),
      this.prisma.enrollment.count({ where: listWhere }),
      this.prisma.enrollment.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.settings.all(),
    ]);
    return {
      data: rows.map((r) => this.toDto(r, viewer, st)),
      meta: pageMeta(q, total, statusCounts(ENROLLMENT_STATUSES, groups)),
    };
  }

  async show(id: number, viewer: AuthUser): Promise<EnrollmentDetailDto> {
    assertStaffOrTeacher(viewer, 'schedule.view');
    const row = await this.find(id, viewer);
    const st = await this.settings.all();
    const upcoming = await this.prisma.classSession.findMany({
      where: {
        enrollmentId: id,
        deletedAt: null,
        startsAt: { gte: new Date(this.clock.nowMs() - 3_600_000) },
      },
      include: sessionInclude,
      orderBy: { startsAt: 'asc' },
      take: 20,
    });
    return {
      ...this.toDto(row, viewer, st),
      upcomingSessions: await this.presenter.many(upcoming, viewer),
    };
  }

  /** Staff writes see every enrollment; a 404 outside the viewer's scope otherwise. */
  private async find(id: number, viewer: AuthUser): Promise<Row> {
    const scope = await viewerScope(this.prisma, viewer);
    const row = await this.prisma.enrollment.findFirst({
      where: { AND: [{ id }, enrollmentScopeWhere(scope)] },
      include,
    });
    if (!row) throw notFound();
    return row;
  }

  async dto(id: number, viewer: AuthUser): Promise<EnrollmentDto> {
    return this.toDto(await this.find(id, viewer), viewer, await this.settings.all());
  }

  // ------------------------------------------------------------------ writes

  async create(input: CreateInput, actor: AuthUser): Promise<number> {
    const student = await this.prisma.student.findUnique({
      where: { id: input.studentId },
      include: { family: { select: { timezone: true } } },
    });
    if (!student || student.archivedAt) throw invalid('studentId');
    if (!(await this.prisma.course.findUnique({ where: { id: input.courseId } }))) {
      throw invalid('courseId');
    }
    if (!(await this.prisma.teacher.findUnique({ where: { id: input.teacherId } }))) {
      throw invalid('teacherId');
    }
    this.assertMeetingMode(input.meetingMode);
    const st = await this.settings.all();
    const zone = input.timezone ?? zoneOr(student.family.timezone, st['academy.timezone']);
    const minutes = input.sessionMinutes ?? 30;

    const id = await this.checker
      .locked([input.teacherId], [student.id], async (tx) => {
        const live = await tx.enrollment.findFirst({
          where: { studentId: student.id, courseId: input.courseId, ...LIVE_ENROLLMENT },
          select: { id: true },
        });
        if (live) throw enrollmentExists();
        const now = this.clock.now();
        const enrollment = await tx.enrollment.create({
          data: {
            studentId: student.id,
            courseId: input.courseId,
            teacherId: input.teacherId,
            kind: input.kind,
            status: 'active',
            startsOn: toDbDate(input.startsOn),
            sessionMinutes: minutes,
            timezone: zone,
            meetingMode: input.meetingMode,
            externalMeetingUrl: input.externalMeetingUrl ?? null,
            notes: input.notes ?? null,
            statusChangedAt: now,
            createdById: actor.id,
          },
        });
        const result = new ConflictResult();
        for (const slot of input.slots) {
          const candidate: SlotCandidate = {
            teacherId: input.teacherId,
            studentId: student.id,
            weekday: slot.weekday,
            localStartTime: slot.localStartTime,
            durationMinutes: slot.durationMinutes ?? minutes,
            timezone: zone,
            validFrom: input.startsOn,
            validTo: null,
          };
          // earlier slots of this payload are already inserted, so they are checked too
          result.merge(await this.checker.checkSlot(tx, candidate, st));
          await this.insertSlot(tx, enrollment.id, candidate, actor.id);
        }
        result.assertPasses(input.acknowledgeWarnings);
        await recordStatusChange(tx, 'enrollment', enrollment.id, null, 'active', null, actor.id);
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'created',
            subjectType: 'enrollment',
            subjectId: enrollment.id,
            after: {
              studentId: student.id,
              courseId: input.courseId,
              teacherId: input.teacherId,
              kind: input.kind,
              startsOn: input.startsOn,
              timezone: zone,
              meetingMode: input.meetingMode,
              slots: input.slots,
            },
          },
          tx,
        );
        return enrollment.id;
      })
      .catch(rethrowLiveTaken);
    await this.resync.run({ enrollmentId: id });
    return id;
  }

  async addSlot(
    enrollmentId: number,
    input: z.output<typeof addSlotSchema>,
    actor: AuthUser,
  ): Promise<number> {
    const enrollment = await this.prisma.enrollment.findUnique({ where: { id: enrollmentId } });
    if (!enrollment) throw notFound();
    assertLive(enrollment);
    const st = await this.settings.all();
    const startsOn = fromDbDate(enrollment.startsOn);
    const candidate: SlotCandidate = {
      teacherId: enrollment.teacherId,
      studentId: enrollment.studentId,
      weekday: input.weekday,
      localStartTime: input.localStartTime,
      durationMinutes: input.durationMinutes ?? enrollment.sessionMinutes,
      timezone: enrollment.timezone,
      validFrom:
        input.validFrom ?? maxDate(startsOn, localDate(this.clock.nowMs(), enrollment.timezone)),
      validTo: enrollment.endsOn ? fromDbDate(enrollment.endsOn) : null,
      enrollmentId,
    };
    const id = await this.checker.locked(
      [enrollment.teacherId],
      [enrollment.studentId],
      async (tx) => {
        (await this.checker.checkSlot(tx, candidate, st)).assertPasses(input.acknowledgeWarnings);
        const slotId = await this.insertSlot(tx, enrollmentId, candidate, actor.id);
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'slot_added',
            subjectType: 'enrollment',
            subjectId: enrollmentId,
            after: { slotId, ...slotSnapshot(candidate) },
          },
          tx,
        );
        return slotId;
      },
    );
    await this.resync.run({ enrollmentId });
    return id;
  }

  /** New version of a slot from `effectiveFrom` (docs/14 §2.3). */
  async versionSlot(
    slotId: number,
    changes: z.output<typeof updateSlotSchema>,
    actor: AuthUser,
  ): Promise<{ slotId: number; affected: SessionDto[] }> {
    const slot = await this.prisma.scheduleSlot.findUnique({
      where: { id: slotId },
      include: { enrollment: true },
    });
    if (!slot) throw notFound();
    const enrollment = slot.enrollment;
    assertLive(enrollment);
    const effective = changes.effectiveFrom;
    if (effective < fromDbDate(slot.validFrom)) {
      throw invalid('effectiveFrom', 'The change cannot start before the slot itself.');
    }
    const st = await this.settings.all();
    const candidate: SlotCandidate = {
      teacherId: slot.teacherId,
      studentId: enrollment.studentId,
      weekday: changes.weekday ?? slot.weekday,
      localStartTime: changes.localStartTime ?? slot.localStartTime,
      durationMinutes: changes.durationMinutes ?? slot.durationMinutes,
      timezone: slot.timezone,
      validFrom: effective,
      validTo: slot.validTo ? fromDbDate(slot.validTo) : null,
      enrollmentId: enrollment.id,
      excludeSlotIds: [slot.id],
    };
    const newId = await this.checker.locked(
      [slot.teacherId],
      [enrollment.studentId],
      async (tx) => {
        (await this.checker.checkSlot(tx, candidate, st)).assertPasses(changes.acknowledgeWarnings);
        await closeSlot(tx, slot, addDays(effective, -1));
        const id = await this.insertSlot(tx, enrollment.id, candidate, actor.id);
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'slot_versioned',
            subjectType: 'enrollment',
            subjectId: enrollment.id,
            before: {
              slotId: slot.id,
              ...slotSnapshot({ ...slot, validFrom: fromDbDate(slot.validFrom) }),
            },
            after: { slotId: id, ...slotSnapshot(candidate) },
          },
          tx,
        );
        return id;
      },
    );
    await this.resync.run({ enrollmentId: enrollment.id, from: effective });
    return { slotId: newId, affected: await this.affectedManual(enrollment, effective, actor) };
  }

  async endSlot(slotId: number, validTo: string, actor: AuthUser): Promise<void> {
    const slot = await this.prisma.scheduleSlot.findUnique({ where: { id: slotId } });
    if (!slot) throw notFound();
    if (validTo < addDays(fromDbDate(slot.validFrom), -1)) {
      throw invalid('validTo', 'The end cannot be before the slot starts.');
    }
    await this.prisma.$transaction(async (tx) => {
      await closeSlot(tx, slot, validTo);
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'slot_ended',
          subjectType: 'enrollment',
          subjectId: slot.enrollmentId,
          after: { slotId, validTo },
        },
        tx,
      );
    });
    await this.resync.run({ enrollmentId: slot.enrollmentId, from: validTo });
  }

  /** `PATCH /enrollments/:id`: a new teacher versions every live slot from `effectiveFrom`. */
  async update(id: number, data: UpdateInput, actor: AuthUser): Promise<SessionDto[]> {
    const enrollment = await this.prisma.enrollment.findUnique({ where: { id } });
    if (!enrollment) throw notFound();
    if (data.meetingMode !== undefined && data.meetingMode !== enrollment.meetingMode) {
      this.assertMeetingMode(data.meetingMode);
    }
    const effective = data.effectiveFrom ?? localDate(this.clock.nowMs(), enrollment.timezone);
    const st = await this.settings.all();
    let affected: SessionDto[] = [];

    if (data.teacherId !== undefined && data.teacherId !== enrollment.teacherId) {
      assertLive(enrollment);
      const teacherId = data.teacherId;
      if (!(await this.prisma.teacher.findUnique({ where: { id: teacherId } }))) {
        throw invalid('teacherId');
      }
      await this.checker.locked(
        [teacherId, enrollment.teacherId],
        [enrollment.studentId],
        async (tx) => {
          const slots = await tx.scheduleSlot.findMany({
            where: { enrollmentId: id, ...validBetween(effective, null) },
          });
          const result = new ConflictResult();
          const candidates = new Map<number, SlotCandidate>();
          for (const slot of slots) {
            const c: SlotCandidate = {
              teacherId,
              studentId: enrollment.studentId,
              weekday: slot.weekday,
              localStartTime: slot.localStartTime,
              durationMinutes: slot.durationMinutes,
              timezone: slot.timezone,
              validFrom: maxDate(effective, fromDbDate(slot.validFrom)),
              validTo: slot.validTo ? fromDbDate(slot.validTo) : null,
              excludeSlotIds: slots.map((s) => s.id),
            };
            candidates.set(slot.id, c);
            result.merge(await this.checker.checkSlot(tx, c, st));
          }
          result.assertPasses(data.acknowledgeWarnings);
          for (const slot of slots) {
            const c = candidates.get(slot.id)!;
            await closeSlot(tx, slot, addDays(c.validFrom, -1));
            await this.insertSlot(tx, id, c, actor.id);
          }
          await tx.enrollment.update({ where: { id }, data: { teacherId } });
          await this.audit.record(
            {
              actorId: actor.id,
              action: 'teacher_changed',
              subjectType: 'enrollment',
              subjectId: id,
              before: { teacherId: enrollment.teacherId },
              after: { teacherId, effectiveFrom: effective },
            },
            tx,
          );
        },
      );
    }

    const fields: Prisma.EnrollmentUncheckedUpdateInput = {};
    if (data.sessionMinutes !== undefined) fields.sessionMinutes = data.sessionMinutes;
    if (data.meetingMode !== undefined) fields.meetingMode = data.meetingMode;
    if (data.externalMeetingUrl !== undefined) fields.externalMeetingUrl = data.externalMeetingUrl;
    if (data.notes !== undefined) fields.notes = data.notes;
    // Existing slots keep their zone (immutable on the row); new slots use the new one.
    if (data.timezone !== undefined) fields.timezone = data.timezone;
    const meetingChanged =
      (data.meetingMode !== undefined && data.meetingMode !== enrollment.meetingMode) ||
      (data.externalMeetingUrl !== undefined &&
        data.externalMeetingUrl !== enrollment.externalMeetingUrl);
    if (Object.keys(fields).length) {
      await this.prisma.$transaction(async (tx) => {
        const after = await tx.enrollment.update({ where: { id }, data: fields });
        const before = {
          sessionMinutes: enrollment.sessionMinutes,
          meetingMode: enrollment.meetingMode,
          timezone: enrollment.timezone,
          notes: enrollment.notes,
        };
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'updated',
            subjectType: 'enrollment',
            subjectId: id,
            before,
            after: {
              sessionMinutes: after.sessionMinutes,
              meetingMode: after.meetingMode,
              timezone: after.timezone,
              notes: after.notes,
              ...(meetingChanged ? { externalMeetingUrl: 'changed' } : {}),
            },
          },
          tx,
        );
        if (meetingChanged) await this.syncMeetingLinks(tx, after);
      });
    }
    await this.resync.run({ enrollmentId: id, from: effective });
    if (data.teacherId !== undefined && data.teacherId !== enrollment.teacherId) {
      affected = await this.affectedManual(enrollment, effective, actor);
    }
    return affected;
  }

  async pause(id: number, reason: string, actor: AuthUser): Promise<void> {
    const scope = await this.prisma.$transaction(async (tx) => {
      const e = await this.lock(tx, id);
      return this.pauseIn(tx, e, reason, actor.id);
    });
    if (scope) await this.resync.run(scope);
  }

  async resume(id: number, actor: AuthUser): Promise<void> {
    const scope = await this.prisma.$transaction(async (tx) => {
      const e = await this.lock(tx, id);
      return this.resumeIn(tx, e, actor.id);
    });
    if (scope) await this.resync.run(scope);
  }

  async end(id: number, endsOn: string, actor: AuthUser): Promise<void> {
    const scope = await this.prisma.$transaction(async (tx) => {
      const e = await this.lock(tx, id);
      return this.endIn(tx, e, endsOn, actor.id, null);
    });
    await this.resync.run(scope);
  }

  // ------------------------------------------------------------------ People side effects (N1 follow-ups)

  /**
   * docs/14 §4.2: family status → its live enrollments. Suspended / on leave pause them (a family
   * reason), deactivated ends them today, back to regular / trial resumes the ones paused for a
   * family reason. Runs in the family's transaction; returns the re-syncs to run after commit.
   */
  async syncWithFamilyStatus(
    tx: Tx,
    familyId: number,
    status: string,
    actorId: number,
  ): Promise<ResyncScope[]> {
    const enrollments = await tx.enrollment.findMany({
      where: { ...LIVE_ENROLLMENT, student: { familyId } },
      orderBy: { id: 'asc' },
    });
    const scopes: ResyncScope[] = [];
    for (const e of enrollments) {
      let scope: ResyncScope | null = null;
      if (status === 'suspended') scope = await this.pauseIn(tx, e, 'family_suspended', actorId);
      else if (status === 'on_leave') scope = await this.pauseIn(tx, e, 'family_on_leave', actorId);
      else if (status === 'deactivated') {
        scope = await this.endIn(
          tx,
          e,
          localDate(this.clock.nowMs(), e.timezone),
          actorId,
          'family_deactivated',
        );
      } else if (
        e.status === 'paused' &&
        (e.pausedReason === 'family_suspended' || e.pausedReason === 'family_on_leave')
      ) {
        scope = await this.resumeIn(tx, e, actorId);
      }
      if (scope) scopes.push(scope);
    }
    return scopes;
  }

  /** An inactive student's live enrollments end today (D125; the old system deleted the schedule). */
  async endForStudent(tx: Tx, studentId: number, actorId: number): Promise<ResyncScope[]> {
    const enrollments = await tx.enrollment.findMany({ where: { studentId, ...LIVE_ENROLLMENT } });
    const scopes: ResyncScope[] = [];
    for (const e of enrollments) {
      scopes.push(
        await this.endIn(
          tx,
          e,
          localDate(this.clock.nowMs(), e.timezone),
          actorId,
          'student_inactive',
        ),
      );
    }
    return scopes;
  }

  async resyncAll(scopes: ResyncScope[]): Promise<void> {
    for (const scope of scopes) await this.resync.run(scope);
  }

  // ------------------------------------------------------------------ internals

  private async lock(tx: Tx, id: number) {
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM "enrollments" WHERE id = ${id} FOR UPDATE`;
    if (!rows.length) throw notFound();
    return tx.enrollment.findUniqueOrThrow({ where: { id } });
  }

  private async pauseIn(
    tx: Tx,
    e: { id: number; status: EnrollmentStatus; pausedReason: string | null },
    reason: string,
    actorId: number,
  ): Promise<ResyncScope | null> {
    if (e.status === 'ended') throw conflictState({ enrollment: ['The enrollment has ended.'] });
    if (e.status === 'paused' && e.pausedReason === reason) return null;
    await tx.enrollment.update({
      where: { id: e.id },
      data: { status: 'paused', pausedReason: reason, statusChangedAt: this.clock.now() },
    });
    await this.statusChanged(tx, e.id, e.status, 'paused', reason, actorId);
    return { enrollmentId: e.id };
  }

  private async resumeIn(
    tx: Tx,
    e: { id: number; status: EnrollmentStatus },
    actorId: number,
  ): Promise<ResyncScope | null> {
    if (e.status === 'ended') throw conflictState({ enrollment: ['The enrollment has ended.'] });
    if (e.status === 'active') return null;
    await tx.enrollment.update({
      where: { id: e.id },
      data: { status: 'active', pausedReason: null, statusChangedAt: this.clock.now() },
    });
    await this.statusChanged(tx, e.id, e.status, 'active', null, actorId);
    return { enrollmentId: e.id };
  }

  private async endIn(
    tx: Tx,
    e: { id: number; status: EnrollmentStatus },
    endsOn: string,
    actorId: number,
    reason: string | null,
  ): Promise<ResyncScope> {
    await tx.enrollment.update({
      where: { id: e.id },
      data: { status: 'ended', endsOn: toDbDate(endsOn), statusChangedAt: this.clock.now() },
    });
    const slots = await tx.scheduleSlot.findMany({
      where: { enrollmentId: e.id, ...validBetween(endsOn, null) },
    });
    for (const slot of slots) await closeSlot(tx, slot, endsOn);
    if (e.status !== 'ended') {
      await this.statusChanged(tx, e.id, e.status, 'ended', reason, actorId, { endsOn });
    }
    return { enrollmentId: e.id, from: endsOn };
  }

  private async statusChanged(
    tx: Tx,
    id: number,
    from: string,
    to: string,
    reason: string | null,
    actorId: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await recordStatusChange(tx, 'enrollment', id, from, to, reason, actorId);
    await this.audit.record(
      {
        actorId,
        action: 'status_changed',
        subjectType: 'enrollment',
        subjectId: id,
        before: { status: from },
        after: { status: to, reason, ...extra },
        reason,
      },
      tx,
    );
  }

  private async insertSlot(
    tx: Tx,
    enrollmentId: number,
    c: SlotCandidate,
    userId: number,
  ): Promise<number> {
    const slot = await tx.scheduleSlot.create({
      data: {
        enrollmentId,
        teacherId: c.teacherId,
        weekday: c.weekday,
        localStartTime: c.localStartTime,
        durationMinutes: c.durationMinutes,
        timezone: c.timezone,
        validFrom: toDbDate(c.validFrom),
        validTo: c.validTo ? toDbDate(c.validTo) : null,
        createdById: userId,
      },
    });
    return slot.id;
  }

  /**
   * The enrollment's meeting mode or link changed: apply it to its classes that have not started
   * yet, and to running ones that still have no working link, so the teacher's Start and the
   * family's Join use the new link right away (the generator only writes new rows). Zoom mode
   * clears a fixed link; the Zoom job then creates meetings when Zoom is configured.
   */
  private async syncMeetingLinks(
    tx: Tx,
    e: { id: number; meetingMode: string; externalMeetingUrl: string | null },
  ): Promise<void> {
    const external = e.meetingMode === 'external';
    const url = external ? e.externalMeetingUrl : null;
    const status = external ? 'external' : 'none';
    const rows = await tx.classSession.findMany({
      where: {
        enrollmentId: e.id,
        deletedAt: null,
        endsAt: { gt: this.clock.now() },
        OR: [
          { stage: 'scheduled' },
          { stage: { in: ['activated', 'in_progress'] }, zoomStatus: { not: 'ready' } },
        ],
      },
    });
    for (const s of rows) {
      // Already on Zoom (none / pending / ready / failed): leave the meeting alone.
      if (!external && s.zoomStatus !== 'external') continue;
      if (s.zoomStatus === status && s.zoomJoinUrl === url) continue;
      await tx.classSession.update({
        where: { id: s.id },
        data: {
          zoomStatus: status,
          zoomJoinUrl: url,
          zoomError: null,
          lockVersion: { increment: 1 },
          updatedAt: this.clock.now(),
        },
      });
      await tx.sessionEvent.create({
        data: {
          sessionId: s.id,
          type: 'zoom_updated',
          payload: { meetingMode: e.meetingMode, fromStatus: s.zoomStatus, toStatus: status },
          occurredAt: this.clock.now(),
        },
      });
    }
  }

  /**
   * Future classes of the enrollment the re-sync will not change because someone touched them
   * (manual, detached, or with a non-system event): the admin decides (§4.4).
   */
  private async affectedManual(
    e: { id: number; timezone: string },
    from: string,
    viewer: AuthUser,
  ): Promise<SessionDto[]> {
    const rows = await this.prisma.classSession.findMany({
      where: {
        enrollmentId: e.id,
        deletedAt: null,
        startsAt: { gte: new Date(toUtc(from, '00:00', e.timezone)) },
        stage: { in: [...OCCUPYING_STAGES] },
        OR: [
          { source: { not: 'generated' } },
          { isDetached: true },
          { events: { some: { type: { notIn: MANUAL_EVENT_TYPES } } } },
        ],
      },
      include: sessionInclude,
      orderBy: { startsAt: 'asc' },
    });
    return this.presenter.many(rows, viewer);
  }

  private assertMeetingMode(mode: string): void {
    if (mode === 'zoom' && !this.zoom.client.enabled()) {
      throw invalid(
        'meetingMode',
        'Zoom is not set up yet: choose a fixed external meeting link for this enrollment.',
      );
    }
  }

  toDto(row: Row, viewer: AuthUser, st: SettingsMap): EnrollmentDto {
    const academy = st['academy.timezone'];
    const today = localDate(this.clock.nowMs(), row.timezone);
    const manage = viewer.permissions.has('schedule.manage');
    return {
      id: row.id,
      student: {
        id: row.student.id,
        name: row.student.name,
        familyId: row.student.familyId,
        timezone: zoneOr(row.student.family.timezone, academy),
      },
      course: row.course,
      teacher: {
        id: row.teacher.id,
        name: name(row.teacher),
        timezone: zoneOr(row.teacher.timezone, academy),
      },
      kind: row.kind === 'trial' ? 'trial' : 'regular',
      status: row.status,
      pausedReason: row.pausedReason,
      startsOn: fromDbDate(row.startsOn),
      endsOn: row.endsOn ? fromDbDate(row.endsOn) : null,
      sessionMinutes: row.sessionMinutes,
      timezone: row.timezone,
      meetingMode: row.meetingMode,
      ...(manage ? { externalMeetingUrl: row.externalMeetingUrl, notes: row.notes } : {}),
      slots: row.slots
        .filter((s) => !s.validTo || fromDbDate(s.validTo) >= today)
        .map((s) => this.slotDto(s, academy)),
      createdAt: isoZ(row.createdAt)!,
    };
  }

  /** A slot with its next occurrence seen from the teacher's zone (`teacherLocal`). */
  slotDto(
    s: {
      id: number;
      enrollmentId: number;
      teacherId: number;
      weekday: number;
      localStartTime: string;
      durationMinutes: number;
      timezone: string;
      validFrom: Date;
      validTo: Date | null;
      teacher: { timezone: string };
    },
    academy: string,
    label?: string,
  ): ScheduleSlotDto {
    const teacherZone = zoneOr(s.teacher.timezone, academy);
    const pattern = patternOf(s);
    const from = maxDate(fromDbDate(s.validFrom), localDate(this.clock.nowMs(), s.timezone));
    const date = pattern.firstDateFrom(from);
    const occ = date ? pattern.occurrenceOn(date) : null;
    const l = occ ? local(occ.start, teacherZone) : null;
    return {
      id: s.id,
      enrollmentId: s.enrollmentId,
      teacherId: s.teacherId,
      weekday: s.weekday,
      localStartTime: s.localStartTime,
      durationMinutes: s.durationMinutes,
      timezone: s.timezone,
      validFrom: fromDbDate(s.validFrom),
      validTo: s.validTo ? fromDbDate(s.validTo) : null,
      teacherLocal: {
        timezone: teacherZone,
        weekday: l?.weekday ?? null,
        time: l?.time ?? null,
        variesWithDst: OffsetProbe.localTimesIn(pattern, teacherZone, from).length > 1,
      },
      ...(label !== undefined ? { label } : {}),
    };
  }

  async slot(id: number): Promise<ScheduleSlotDto> {
    const s = await this.prisma.scheduleSlot.findUnique({ where: { id }, include: slotDtoInclude });
    if (!s) throw notFound();
    return this.slotDto(s, (await this.settings.all())['academy.timezone']);
  }

  labelledSlot(s: SlotRow, academy: string): ScheduleSlotDto {
    return this.slotDto(
      s,
      academy,
      [s.enrollment.student.name, s.enrollment.course.nameAr].filter(Boolean).join(' — '),
    );
  }
}

function assertLive(e: { status: EnrollmentStatus }): void {
  if (e.status === 'ended') throw conflictState({ enrollment: ['The enrollment has ended.'] });
}

async function closeSlot(
  tx: Tx,
  slot: { id: number; validFrom: Date; validTo: Date | null },
  validTo: string,
): Promise<void> {
  if (slot.validTo === null || fromDbDate(slot.validTo) > validTo) {
    // A version that never started ends the day before its start (empty, kept for history).
    const end = maxDate(validTo, addDays(fromDbDate(slot.validFrom), -1));
    await tx.scheduleSlot.update({ where: { id: slot.id }, data: { validTo: toDbDate(end) } });
  }
}

function slotSnapshot(c: {
  weekday: number;
  localStartTime: string;
  durationMinutes: number;
  timezone: string;
  validFrom: string;
}) {
  return {
    weekday: c.weekday,
    localStartTime: c.localStartTime,
    durationMinutes: c.durationMinutes,
    timezone: c.timezone,
    validFrom: c.validFrom,
  };
}

const enrollmentExists = () =>
  invalid('courseId', 'The student already has a live enrollment in this course.');

/** The partial unique index on live enrollments lost a race: same answer as the check. */
function rethrowLiveTaken(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    JSON.stringify(error.meta ?? {}).includes('enrollments')
  ) {
    throw enrollmentExists();
  }
  throw error;
}
