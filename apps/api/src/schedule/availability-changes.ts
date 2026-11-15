import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type {
  AffectedClassDto,
  AvailabilityChangeDto,
  AvailabilityChangeKind,
  approveAvailabilityChangeSchema,
  availabilityChangeQuerySchema,
  createTeacherBlockSchema,
  replaceWorkHoursSchema,
  updateTeacherBlockSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { expandRecurring, expandWorkHours, type Span } from '../calendar/expand.js';
import { Clock } from '../common/clock.js';
import { ApiException, notFound, validationError } from '../common/errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import { isTeacherViewer } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { teacherName } from '../sessions/presenter.js';
import { CalendarService } from './calendar.service.js';
import { assertStaffOrTeacher, forbidden, viewerScope } from './scope.js';
import { addDays, fromDbDate, localDate, toDbDate, toUtc } from './time.js';

/** How far ahead the affected-classes check looks. */
const AFFECTED_DAYS = 60;

const include = {
  teacher: { select: { id: true, firstName: true, lastName: true, timezone: true, userId: true } },
} satisfies Prisma.AvailabilityChangeInclude;
type Row = Prisma.AvailabilityChangeGetPayload<{ include: typeof include }>;

const conflict = (code: string, message: string) =>
  new ApiException(HttpStatus.CONFLICT, { message, code });
/** P0-3 (B116): nobody decides their own request. */
const selfDecision = () =>
  new ApiException(HttpStatus.FORBIDDEN, {
    message: 'You cannot approve or reject your own availability change.',
    code: 'self_decision',
  });

type WorkHoursInput = z.output<typeof replaceWorkHoursSchema>;
type BlockInput =
  z.output<typeof createTeacherBlockSchema> | z.output<typeof updateTeacherBlockSchema>;

/**
 * A1 (docs/42 §4, D148; B131): a teacher's change to their own work hours or blocks waits for staff
 * with `schedule.manage`, who see the booked classes it would leave outside the hours before
 * deciding. Approved work hours apply from `effectiveFrom` (an hourly job applies future ones);
 * block changes apply on approval. Every step is audited.
 */
@Injectable()
export class AvailabilityChangesService {
  private readonly logger = new Logger(AvailabilityChangesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: CalendarService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Is this the teacher changing their own availability (no staff rights)? */
  async isOwnRequest(teacherId: number, actor: AuthUser): Promise<boolean> {
    if (actor.permissions.has('schedule.manage') || !isTeacherViewer(actor)) return false;
    // Another teacher: 404, as for reading their calendar.
    await this.calendar.assertCanSee(teacherId, actor);
    return true;
  }

  // ---------------------------------------------------------------- requests (the teacher)

  async requestWorkHours(
    teacherId: number,
    input: WorkHoursInput,
    actor: AuthUser,
  ): Promise<AvailabilityChangeDto> {
    const teacher = await this.prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    const today = localDate(this.clock.nowMs(), teacher.timezone);
    const effectiveFrom = input.effectiveFrom ?? today;
    if (effectiveFrom < today) {
      throw validationError({ effectiveFrom: ['The change cannot start in the past.'] });
    }
    const payload = {
      workHours: input.workHours.map((w) => ({ ...w, timezone: w.timezone ?? teacher.timezone })),
    };
    return this.create(
      teacherId,
      'work_hours',
      null,
      payload,
      effectiveFrom,
      input.requestNote,
      actor,
    );
  }

  async requestBlock(
    teacherId: number,
    kind: 'block_create' | 'block_update' | 'block_delete',
    blockId: number | null,
    input: BlockInput | null,
    actor: AuthUser,
  ): Promise<AvailabilityChangeDto> {
    const teacher = await this.prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    if (blockId !== null) {
      const block = await this.prisma.teacherBlock.findFirst({ where: { id: blockId, teacherId } });
      if (!block) throw notFound();
    }
    return this.create(
      teacherId,
      kind,
      blockId,
      (input ?? {}),
      localDate(this.clock.nowMs(), teacher.timezone),
      null,
      actor,
    );
  }

  private async create(
    teacherId: number,
    kind: AvailabilityChangeKind,
    blockId: number | null,
    payload: Record<string, unknown>,
    effectiveFrom: string,
    note: string | null | undefined,
    actor: AuthUser,
  ): Promise<AvailabilityChangeDto> {
    const now = this.clock.now();
    const row = await this.prisma.$transaction(async (tx) => {
      // A newer work-hours request replaces an older pending one.
      if (kind === 'work_hours') {
        await tx.availabilityChange.updateMany({
          where: { teacherId, kind: 'work_hours', status: 'pending' },
          data: {
            status: 'withdrawn',
            decisionReason: 'Replaced by a newer request.',
            updatedAt: now,
          },
        });
      }
      const created = await tx.availabilityChange.create({
        data: {
          teacherId,
          kind,
          blockId,
          payload: payload as Prisma.InputJsonValue,
          effectiveFrom: toDbDate(effectiveFrom),
          note: note ?? null,
          requestedById: actor.id,
          createdAt: now,
          updatedAt: now,
        },
        include,
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'availability_change_requested',
          subjectType: 'teacher',
          subjectId: teacherId,
          after: { changeId: created.id, kind, blockId, effectiveFrom },
        },
        tx,
      );
      return created;
    });
    return this.dto(row, actor);
  }

  // ---------------------------------------------------------------- reads

  async list(
    q: z.output<typeof availabilityChangeQuerySchema>,
    viewer: AuthUser,
  ): Promise<AvailabilityChangeDto[]> {
    assertStaffOrTeacher(viewer, 'schedule.view');
    const scope = await viewerScope(this.prisma, viewer);
    if (scope.kind === 'family') throw forbidden();
    const rows = await this.prisma.availabilityChange.findMany({
      where: {
        ...(scope.kind === 'teacher' ? { teacherId: scope.teacherId } : {}),
        ...(q.teacherId && scope.kind !== 'teacher' ? { teacherId: q.teacherId } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      include,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return Promise.all(rows.map((r) => this.dto(r, viewer)));
  }

  async show(id: number, viewer: AuthUser): Promise<AvailabilityChangeDto> {
    return this.dto(await this.visible(id, viewer), viewer);
  }

  private async visible(id: number, viewer: AuthUser): Promise<Row> {
    assertStaffOrTeacher(viewer, 'schedule.view');
    const scope = await viewerScope(this.prisma, viewer);
    if (scope.kind === 'family') throw forbidden();
    const row = await this.prisma.availabilityChange.findUnique({ where: { id }, include });
    if (!row || (scope.kind === 'teacher' && row.teacherId !== scope.teacherId)) throw notFound();
    return row;
  }

  // ---------------------------------------------------------------- decisions (staff)

  async approve(
    id: number,
    input: z.output<typeof approveAvailabilityChangeSchema>,
    actor: AuthUser,
  ): Promise<AvailabilityChangeDto> {
    const row = await this.pending(id, actor);
    const today = localDate(this.clock.nowMs(), row.teacher.timezone);
    const requested = fromDbDate(row.effectiveFrom);
    const effectiveFrom = input.effectiveFrom ?? (requested < today ? today : requested);
    if (effectiveFrom < today) {
      throw validationError({ effectiveFrom: ['The change cannot start in the past.'] });
    }
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.availabilityChange.update({
        where: { id },
        data: {
          status: 'approved',
          effectiveFrom: toDbDate(effectiveFrom),
          decidedById: actor.id,
          decidedAt: now,
          decisionReason: input.note ?? null,
          updatedAt: now,
        },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'availability_change_approved',
          subjectType: 'teacher',
          subjectId: row.teacherId,
          after: { changeId: id, kind: row.kind, effectiveFrom },
          reason: input.note ?? null,
        },
        tx,
      );
    });
    // Blocks, and work hours due today, apply now; later work hours on their date (hourly job).
    if (row.kind !== 'work_hours' || effectiveFrom <= today) await this.apply(id);
    return this.show(id, actor);
  }

  async reject(id: number, reason: string, actor: AuthUser): Promise<AvailabilityChangeDto> {
    const row = await this.pending(id, actor);
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.availabilityChange.update({
        where: { id },
        data: {
          status: 'rejected',
          decidedById: actor.id,
          decidedAt: now,
          decisionReason: reason,
          updatedAt: now,
        },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'availability_change_rejected',
          subjectType: 'teacher',
          subjectId: row.teacherId,
          after: { changeId: id, kind: row.kind },
          reason,
        },
        tx,
      );
    });
    return this.show(id, actor);
  }

  /** The teacher takes back their own pending request. */
  async withdraw(id: number, actor: AuthUser): Promise<AvailabilityChangeDto> {
    const row = await this.visible(id, actor);
    if (row.requestedById !== actor.id) throw forbidden();
    if (row.status !== 'pending')
      throw conflict('not_pending', 'Only a pending change can be withdrawn.');
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.availabilityChange.update({
        where: { id },
        data: { status: 'withdrawn', updatedAt: now },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'availability_change_withdrawn',
          subjectType: 'teacher',
          subjectId: row.teacherId,
          after: { changeId: id },
        },
        tx,
      );
    });
    return this.show(id, actor);
  }

  private async pending(id: number, actor: AuthUser): Promise<Row> {
    if (!actor.permissions.has('schedule.manage')) throw forbidden();
    const row = await this.prisma.availabilityChange.findUnique({ where: { id }, include });
    if (!row) throw notFound();
    if (row.requestedById === actor.id || row.teacher.userId === actor.id) throw selfDecision();
    if (row.status !== 'pending') throw conflict('not_pending', 'This change was already decided.');
    return row;
  }

  // ---------------------------------------------------------------- applying

  /** Approved work hours whose date has come (hourly job). */
  async applyDue(): Promise<number> {
    const soon = addDays(localDate(this.clock.nowMs(), 'UTC'), 1);
    const due = await this.prisma.availabilityChange.findMany({
      where: { status: 'approved', effectiveFrom: { lte: toDbDate(soon) } },
      include,
    });
    let applied = 0;
    for (const row of due) {
      if (fromDbDate(row.effectiveFrom) > localDate(this.clock.nowMs(), row.teacher.timezone))
        continue;
      try {
        await this.apply(row.id);
        applied++;
      } catch (error) {
        this.logger.error(`availability change ${row.id} failed`, error as Error);
      }
    }
    return applied;
  }

  private async apply(id: number): Promise<void> {
    const row = await this.prisma.availabilityChange.findUniqueOrThrow({ where: { id } });
    if (row.status !== 'approved') return;
    const actorId = row.decidedById;
    if (actorId === null) throw new Error(`Approved availability change ${id} has no approver.`);
    // The approver is the actor of the resulting block / work-hours change.
    const approver = { id: actorId };
    const payload = row.payload as Record<string, unknown>;
    switch (row.kind) {
      case 'work_hours':
        await this.calendar.writeWorkHours(
          row.teacherId,
          (payload.workHours as Parameters<CalendarService['writeWorkHours']>[1]) ?? [],
          actorId,
          { availabilityChangeId: id },
        );
        break;
      case 'block_create':
        await this.calendar.createBlock(
          row.teacherId,
          payload as z.output<typeof createTeacherBlockSchema>,
          approver,
        );
        break;
      case 'block_update':
        await this.calendar.updateBlock(
          row.teacherId,
          row.blockId!,
          payload,
          approver,
        );
        break;
      case 'block_delete':
        // Already gone (deleted by staff meanwhile): nothing to do.
        if (await this.prisma.teacherBlock.findUnique({ where: { id: row.blockId! } })) {
          await this.calendar.deleteBlock(row.teacherId, row.blockId!, approver);
        }
        break;
    }
    await this.prisma.availabilityChange.update({
      where: { id },
      data: { status: 'applied', appliedAt: this.clock.now(), updatedAt: this.clock.now() },
    });
  }

  // ---------------------------------------------------------------- affected classes

  /** Booked classes (next 60 days) the change would leave outside the hours or inside a block. */
  private async affected(row: Row): Promise<AffectedClassDto[]> {
    if (row.kind === 'block_delete' || row.status === 'rejected' || row.status === 'withdrawn') {
      return [];
    }
    const zone = row.teacher.timezone;
    const fromDate = fromDbDate(row.effectiveFrom);
    const from = Math.max(toUtc(fromDate, '00:00', zone), this.clock.nowMs());
    const to = toUtc(addDays(fromDate, AFFECTED_DAYS), '00:00', zone);
    const sessions = await this.prisma.classSession.findMany({
      where: {
        teacherId: row.teacherId,
        deletedAt: null,
        stage: 'scheduled',
        startsAt: { gte: new Date(from), lt: new Date(to) },
      },
      include: { student: { select: { id: true, name: true } } },
      orderBy: { startsAt: 'asc' },
    });
    const payload = row.payload as Record<string, unknown>;
    let hit: (s: Span) => boolean;
    if (row.kind === 'work_hours') {
      const hours = expandWorkHours(
        (payload.workHours as Array<{
          weekday: number;
          localStartTime: string;
          localEndTime: string;
          timezone: string;
        }>) ?? [],
        from,
        to,
      );
      hit = (s) => !hours.some((h) => h.start <= s.start && h.end >= s.end);
    } else {
      const spans = blockSpans(payload, zone, from, to);
      hit = (s) => spans.some((b) => b.start < s.end && s.start < b.end);
    }
    return sessions
      .filter((s) => hit({ start: s.startsAt.getTime(), end: s.endsAt.getTime() }))
      .map((s) => ({
        id: s.id,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        kind: s.kind,
        student: s.student,
      }));
  }

  private async dto(row: Row, viewer: AuthUser): Promise<AvailabilityChangeDto> {
    const ids = [row.requestedById, row.decidedById].filter((x): x is number => x !== null);
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        })
      : [];
    const user = (userId: number | null) => users.find((u) => u.id === userId) ?? null;
    const pending = row.status === 'pending';
    const decides =
      pending &&
      viewer.permissions.has('schedule.manage') &&
      row.requestedById !== viewer.id &&
      row.teacher.userId !== viewer.id;
    return {
      id: row.id,
      teacher: {
        id: row.teacher.id,
        name: teacherName(row.teacher),
        timezone: row.teacher.timezone,
      },
      kind: row.kind,
      status: row.status,
      blockId: row.blockId,
      payload: row.payload as Record<string, unknown>,
      effectiveFrom: fromDbDate(row.effectiveFrom),
      note: row.note,
      requestedBy: user(row.requestedById),
      requestedAt: row.createdAt.toISOString(),
      decidedBy: user(row.decidedById),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionReason: row.decisionReason,
      appliedAt: row.appliedAt?.toISOString() ?? null,
      affected: await this.affected(row),
      can: {
        approve: decides,
        reject: decides,
        withdraw: pending && row.requestedById === viewer.id,
      },
    };
  }
}

/** The block a request would create or become, as spans in [from, to). */
function blockSpans(
  p: Record<string, unknown>,
  teacherZone: string,
  from: number,
  to: number,
): Span[] {
  if (p.kind === 'one_off' || (p.startsAt && p.endsAt)) {
    const start = Date.parse(p.startsAt as string);
    const end = Date.parse(p.endsAt as string);
    return start < to && end > from ? [{ start, end }] : [];
  }
  if (p.weekday && p.localStartTime && p.durationMinutes) {
    return expandRecurring(
      {
        weekday: Number(p.weekday),
        localStartTime: p.localStartTime as string,
        durationMinutes: Number(p.durationMinutes),
        timezone: (p.timezone as string | null) ?? teacherZone,
        validFrom: (p.validFrom as string | null) ?? null,
        validTo: (p.validTo as string | null) ?? null,
      },
      from,
      to,
    );
  }
  return [];
}
