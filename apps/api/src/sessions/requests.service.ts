import { Injectable, Logger } from '@nestjs/common';
import {
  type approveSessionRequestSchema,
  type createSessionRequestSchema,
  type Paginated,
  REQUEST_STATUSES,
  REQUEST_TYPES,
  type RequestCountsDto,
  type SessionRequestDto,
  type sessionRequestListQuerySchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound, validationError } from '../common/errors.js';
import { pageArgs, pageMeta, statusCounts } from '../common/pagination.js';
import { Prisma } from '../generated/prisma/client.js';
import type { SessionRequestStatus, SessionRequestType } from '../generated/prisma/enums.js';
import { isParentViewer, isTeacherViewer } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConflictChecker, insideWorkHours, zoneOr } from '../schedule/conflicts.js';
import { sessionScopeWhere, viewerScope } from '../schedule/scope.js';
import { DAY, HOUR, Interval, isoZ } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { conflictState, forbiddenAction } from './errors.js';
import { SessionPresenter, sessionInclude } from './presenter.js';
import { SessionsService } from './sessions.service.js';
import { Actor, SessionStateMachine } from './state-machine.js';
import { ZoomMeetings } from './zoom.js';

const include = {
  session: { include: sessionInclude },
  student: { select: { id: true, name: true } },
  requestedBy: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
} satisfies Prisma.SessionRequestInclude;
type Row = Prisma.SessionRequestGetPayload<{ include: typeof include }>;

type CreateInput = z.output<typeof createSessionRequestSchema>;
type ApproveInput = z.output<typeof approveSessionRequestSchema>;

const notPending = () => conflictState({ status: ['The request is no longer pending.'] });

/**
 * Leave / reschedule / advance / extra requests (D46, D135, docs/14 §3.4), port of Laravel
 * `SessionRequestService`:
 * - a leave notified ≥ `sessions.leave_notice_hours` before the class is auto-approved (leave);
 * - a requester who holds `session_requests.approve` gets the request approved on creation;
 * - a reschedule into the teacher's published work hours, same teacher, without any conflict or
 *   warning and at least `sessions.reschedule_auto_approve_hours` ahead, is auto-approved;
 * - approval re-runs the conflict check (409) and may change the time or the teacher;
 * - pending requests expire when their class starts (hourly).
 * Notifications (Laravel mail/database) arrive with the notification centre.
 */
@Injectable()
export class SessionRequestsService {
  private readonly logger = new Logger(SessionRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly machine: SessionStateMachine,
    private readonly sessions: SessionsService,
    private readonly checker: ConflictChecker,
    private readonly presenter: SessionPresenter,
    private readonly audit: AuditService,
    private readonly zoom: ZoomMeetings,
  ) {}

  // ------------------------------------------------------------------ reads

  /** Teacher: requests on own classes or made by them; family: own children; staff: all. */
  private async scopeWhere(viewer: AuthUser): Promise<Prisma.SessionRequestWhereInput> {
    const scope = await viewerScope(this.prisma, viewer);
    if (scope.kind === 'teacher') {
      return { OR: [{ requestedById: viewer.id }, { session: { teacherId: scope.teacherId } }] };
    }
    if (scope.kind === 'family') return { studentId: { in: scope.studentIds } };
    return {};
  }

  async list(
    q: z.output<typeof sessionRequestListQuerySchema>,
    viewer: AuthUser,
  ): Promise<Paginated<SessionRequestDto>> {
    const and: Prisma.SessionRequestWhereInput[] = [await this.scopeWhere(viewer)];
    if (q.type) and.push({ type: q.type });
    if (q.studentId) and.push({ studentId: q.studentId });
    if (q.mine) and.push({ requestedById: viewer.id });
    const where: Prisma.SessionRequestWhereInput = { AND: and };
    const statusWhere: Prisma.SessionRequestWhereInput | null =
      q.status === 'decided'
        ? { status: { not: 'pending' } }
        : q.status
          ? { status: q.status }
          : null;
    const listWhere = statusWhere ? { AND: [...and, statusWhere] } : where;
    const [rows, total, groups] = await Promise.all([
      // Pending first (the enum's first value), then oldest first: the inbox order.
      this.prisma.sessionRequest.findMany({
        where: listWhere,
        include,
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        ...pageArgs(q),
      }),
      this.prisma.sessionRequest.count({ where: listWhere }),
      this.prisma.sessionRequest.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);
    return {
      data: await this.toDtos(rows, viewer),
      meta: pageMeta(q, total, statusCounts(REQUEST_STATUSES, groups)),
    };
  }

  async counts(viewer: AuthUser): Promise<RequestCountsDto> {
    const groups = await this.prisma.sessionRequest.groupBy({
      by: ['type'],
      where: { AND: [await this.scopeWhere(viewer), { status: 'pending' }] },
      _count: { _all: true },
    });
    const byType = Object.fromEntries(
      REQUEST_TYPES.map((t) => [t, 0]),
    ) as RequestCountsDto['byType'];
    for (const g of groups) byType[g.type] = g._count._all;
    return { pending: Object.values(byType).reduce((a, b) => a + b, 0), byType };
  }

  async show(id: number, viewer: AuthUser): Promise<SessionRequestDto> {
    return (await this.toDtos([await this.find(id, viewer)], viewer))[0]!;
  }

  private async find(id: number, viewer: AuthUser): Promise<Row> {
    const row = await this.prisma.sessionRequest.findFirst({
      where: { AND: [{ id }, await this.scopeWhere(viewer)] },
      include,
    });
    if (!row) throw notFound();
    return row;
  }

  // ------------------------------------------------------------------ writes

  async create(input: CreateInput, user: AuthUser): Promise<number> {
    const scope = await viewerScope(this.prisma, user);
    const session = await this.prisma.classSession.findFirst({
      where: { AND: [{ id: input.sessionId, deletedAt: null }, sessionScopeWhere(scope)] },
    });
    if (!session) throw notFound();
    const st = await this.settings.all();
    this.assertCanRequest(
      input.type,
      session,
      user,
      scope.kind === 'teacher' ? scope.teacherId : null,
    );
    this.validateTarget(input, session, st['sessions.makeup_window_days']);

    const now = this.clock.nowMs();
    const notified = input.notifiedAt ? new Date(input.notifiedAt).getTime() : now;
    if (notified > now) {
      throw validationError({ notifiedAt: ['The notified time cannot be in the future.'] });
    }
    const id = await this.prisma
      .$transaction(async (tx) => {
        const pending = await tx.sessionRequest.findFirst({
          where: { sessionId: session.id, type: input.type, status: 'pending' },
          select: { id: true },
        });
        if (pending) throw alreadyPending();
        const r = await tx.sessionRequest.create({
          data: {
            type: input.type,
            sessionId: session.id,
            enrollmentId: session.enrollmentId,
            studentId: session.studentId,
            requestedById: user.id,
            requesterRole: user.role?.name ?? null,
            reason: input.reason,
            notifiedAt: input.type === 'leave' ? new Date(notified) : null,
            proposedStartsAt: input.proposedStartsAt ? new Date(input.proposedStartsAt) : null,
            proposedDurationMinutes: input.proposedDurationMinutes ?? null,
            proposedTeacherId: input.proposedTeacherId ?? null,
            createdAt: new Date(now),
            updatedAt: new Date(now),
          },
        });
        await this.audit.record(
          {
            actorId: user.id,
            action: 'created',
            subjectType: 'session_request',
            subjectId: r.id,
            after: { type: input.type, sessionId: session.id, reason: input.reason },
          },
          tx,
        );
        return r.id;
      })
      .catch(rethrowPendingTaken);

    const autoLeave =
      input.type === 'leave' &&
      notified <= session.startsAt.getTime() - st['sessions.leave_notice_hours'] * HOUR;
    if (autoLeave) {
      await this.decide(id, null, {
        status: 'auto_approved',
        acknowledgeWarnings: input.acknowledgeWarnings,
      });
      return id;
    }
    if (user.permissions.has('session_requests.approve')) {
      await this.decide(id, user, { acknowledgeWarnings: input.acknowledgeWarnings });
      return id;
    }
    if (await this.qualifiesForAutoApproval(id)) {
      try {
        await this.decide(id, null, { status: 'auto_approved', acknowledgeWarnings: [] });
        return id;
      } catch {
        // Lost a race for the slot: it waits for a person, like any other request.
      }
    }
    await this.touchSession(session.id);
    return id;
  }

  /** Approve (or auto-approve): apply the effect and record the decision in one transaction. */
  async decide(
    id: number,
    approver: AuthUser | null,
    input: Partial<ApproveInput> & { status?: SessionRequestStatus },
  ): Promise<void> {
    const status = input.status ?? 'approved';
    const system = Actor.system();
    const ack = input.acknowledgeWarnings ?? [];
    const current = await this.prisma.sessionRequest.findUnique({
      where: { id },
      include: { session: true },
    });
    if (!current) throw notFound();
    const s0 = current.session;
    const targetTeacher = input.teacherId ?? current.proposedTeacherId ?? s0.teacherId;

    const moved = await this.checker.locked(
      [targetTeacher, s0.teacherId],
      [s0.studentId],
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "session_requests" WHERE id = ${id} FOR UPDATE`;
        const r = await tx.sessionRequest.findUniqueOrThrow({ where: { id } });
        if (r.status !== 'pending') throw notPending();
        const session = await tx.classSession.findUniqueOrThrow({ where: { id: r.sessionId } });
        let resultId: number | null = null;
        let movedOut = false;

        if (r.type === 'leave') {
          if (session.stage === 'scheduled' || session.stage === 'activated') {
            await this.machine.apply(
              session.id,
              'mark_leave',
              system,
              {
                stageReason: 'student',
                notifiedAt: isoZ(r.notifiedAt) ?? undefined,
                requestId: r.id,
              },
              tx,
            );
          }
          resultId = session.id;
        } else {
          const startsAt = input.startsAt ?? isoZ(r.proposedStartsAt);
          if (!startsAt) throw validationError({ startsAt: ['The starts at field is required.'] });
          if (r.type !== 'extra' && session.stage === 'scheduled') {
            await this.machine.apply(
              session.id,
              'move',
              system,
              { stageReason: r.type === 'advance' ? 'advanced' : 'rescheduled', requestId: r.id },
              tx,
            );
            movedOut = true;
          }
          resultId = await this.sessions.create(
            {
              enrollmentId: session.enrollmentId,
              studentId: session.studentId,
              courseId: session.courseId,
              teacherId: targetTeacher,
              kind: r.type === 'advance' ? 'advance' : r.type === 'extra' ? 'extra' : 'rescheduled',
              startsAt,
              durationMinutes: r.proposedDurationMinutes ?? session.durationMinutes,
              originSessionId: session.id,
              source: 'request',
            },
            approver ? await Actor.of(tx, approver) : system,
            ack,
            { type: 'note', payload: { createdFromRequest: r.id, type: r.type } },
            tx,
          );
        }

        const now = this.clock.now();
        await tx.sessionRequest.update({
          where: { id },
          data: {
            status,
            decidedById: approver?.id ?? (status === 'auto_approved' ? null : r.requestedById),
            decidedAt: now,
            decisionNote: input.note ?? null,
            resultSessionId: resultId,
            lockVersion: { increment: 1 },
            updatedAt: now,
          },
        });
        await tx.classSession.update({ where: { id: session.id }, data: { updatedAt: now } });
        await this.audit.record(
          {
            actorId: approver?.id ?? null,
            action: status,
            subjectType: 'session_request',
            subjectId: id,
            before: { status: 'pending' },
            after: { status, resultSessionId: resultId, note: input.note ?? null },
          },
          tx,
        );
        return movedOut ? session.id : null;
      },
    );
    if (moved) await this.zoom.delete(moved);
  }

  async reject(id: number, approver: AuthUser, note: string): Promise<void> {
    await this.find(id, approver);
    await this.close(id, 'rejected', approver, note);
  }

  async cancel(id: number, user: AuthUser): Promise<void> {
    const r = await this.find(id, user);
    if (r.requestedById !== user.id) throw forbiddenAction();
    await this.close(id, 'cancelled', user, null);
  }

  /** Pending requests whose class has started (hourly). An extra class or a make-up stays. */
  async expireStarted(): Promise<number> {
    const rows = await this.prisma.sessionRequest.findMany({
      where: { status: 'pending', session: { startsAt: { lte: this.clock.now() } } },
      include: { session: { select: { stage: true } } },
    });
    let expired = 0;
    for (const r of rows) {
      if (r.type === 'extra' || (r.type === 'reschedule' && r.session.stage === 'leave')) continue;
      try {
        await this.close(r.id, 'expired', null, null);
        expired += 1;
      } catch (error) {
        this.logger.warn(`Could not expire request ${r.id}: ${String(error)}`);
      }
    }
    return expired;
  }

  async allowedActions(
    r: { status: string; requestedById: number },
    viewer: AuthUser,
  ): Promise<Array<'approve' | 'reject' | 'cancel'>> {
    if (r.status !== 'pending') return [];
    const out: Array<'approve' | 'reject' | 'cancel'> = [];
    if (viewer.permissions.has('session_requests.approve')) out.push('approve', 'reject');
    if (r.requestedById === viewer.id) out.push('cancel');
    return Promise.resolve(out);
  }

  // ------------------------------------------------------------------ rules

  /**
   * D135 (B73): a reschedule (or the make-up of a leave class) is approved without a person when
   * the new time is at least `sessions.reschedule_auto_approve_hours` ahead (0 = off), stays with
   * the same teacher, lies inside the teacher's published work hours (a teacher without work hours
   * never qualifies) and has no conflict or warning at all.
   */
  private async qualifiesForAutoApproval(id: number): Promise<boolean> {
    const st = await this.settings.all();
    const hours = st['sessions.reschedule_auto_approve_hours'];
    const r = await this.prisma.sessionRequest.findUniqueOrThrow({
      where: { id },
      include: { session: { include: { teacher: { include: { workHours: true } } } } },
    });
    const proposed = r.proposedStartsAt?.getTime();
    if (r.type !== 'reschedule' || hours <= 0 || proposed === undefined) return false;
    const s = r.session;
    if (r.proposedTeacherId !== null && r.proposedTeacherId !== s.teacherId) return false;
    if (proposed < this.clock.nowMs() + hours * HOUR) return false;
    if (!s.teacher.workHours.length) return false;
    const minutes = r.proposedDurationMinutes ?? s.durationMinutes;
    const academy = st['academy.timezone'];
    if (
      !insideWorkHours(
        s.teacher.workHours,
        Interval.of(proposed, minutes),
        zoneOr(s.teacher.timezone, academy),
        academy,
      )
    ) {
      return false;
    }
    const result = await this.checker.checkSession(
      this.prisma,
      {
        teacherId: s.teacherId,
        studentId: s.studentId,
        startsAt: proposed,
        durationMinutes: minutes,
        enrollmentId: s.enrollmentId,
        excludeSessionId: s.id,
      },
      st,
    );
    return !result.hasHard() && result.warnings.length === 0;
  }

  private assertCanRequest(
    type: SessionRequestType,
    session: { teacherId: number },
    user: AuthUser,
    ownTeacherId: number | null,
  ): void {
    const has = (p: string) => user.permissions.has(p);
    const staff = has('session_requests.manage') || has('session_requests.approve');
    // A staff role that may file requests on a family's behalf (CSR today, docs/29).
    const kind = user.role?.kind;
    const requester = (kind === 'owner' || kind === 'staff') && has('session_requests.request');
    const ownTeacher = isTeacherViewer(user) && ownTeacherId === session.teacherId;
    const ok =
      type === 'leave' || type === 'reschedule'
        ? staff || isParentViewer(user) || ownTeacher || requester
        : type === 'advance'
          ? staff || requester || ownTeacher
          : has('session_requests.approve') || has('sessions.manage');
    if (!ok) throw forbiddenAction();
  }

  private validateTarget(
    input: CreateInput,
    session: { stage: string; startsAt: Date },
    makeupDays: number,
  ): void {
    const now = this.clock.nowMs();
    const starts = session.startsAt.getTime();
    const proposed = input.proposedStartsAt ? new Date(input.proposedStartsAt).getTime() : null;
    const fail422 = (field: string, message: string) => {
      throw validationError({ [field]: [message] });
    };
    switch (input.type) {
      case 'leave':
        if (session.stage !== 'scheduled' || starts <= now) {
          fail422(
            'sessionId',
            'A leave can only be asked for a scheduled class that has not started.',
          );
        }
        break;
      case 'reschedule': {
        const makeUp = session.stage === 'leave';
        if (!makeUp && !(session.stage === 'scheduled' && starts > now)) {
          fail422(
            'sessionId',
            'Only a scheduled class that has not started, or a leave class, can be rescheduled.',
          );
        }
        if (proposed !== null && makeUp && proposed > starts + makeupDays * DAY) {
          fail422('proposedStartsAt', `A make-up must be within ${makeupDays} days of the class.`);
        }
        if (proposed !== null && !makeUp && proposed <= starts) {
          fail422('proposedStartsAt', 'The new time must be later than the class.');
        }
        break;
      }
      case 'advance':
        if (session.stage !== 'scheduled' || starts <= now) {
          fail422('sessionId', 'Only a scheduled class that has not started can be advanced.');
        }
        if (proposed === null || proposed >= starts || proposed < now) {
          fail422(
            'proposedStartsAt',
            'The new time must be earlier than the class and not in the past.',
          );
        }
        break;
      case 'extra':
        if (session.stage !== 'absent' && session.stage !== 'declined') {
          fail422('sessionId', 'An extra class is given for an absent or declined class.');
        }
        if (proposed === null) fail422('proposedStartsAt', 'The proposed time is required.');
        break;
    }
  }

  private async close(
    id: number,
    status: SessionRequestStatus,
    user: AuthUser | null,
    note: string | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "session_requests" WHERE id = ${id} FOR UPDATE`;
      const r = await tx.sessionRequest.findUniqueOrThrow({ where: { id } });
      if (r.status !== 'pending') throw notPending();
      const now = this.clock.now();
      await tx.sessionRequest.update({
        where: { id },
        data: {
          status,
          decidedById: user?.id ?? null,
          decidedAt: now,
          decisionNote: note,
          lockVersion: { increment: 1 },
          updatedAt: now,
        },
      });
      await tx.classSession.update({ where: { id: r.sessionId }, data: { updatedAt: now } });
      await this.audit.record(
        {
          actorId: user?.id ?? null,
          action: status,
          subjectType: 'session_request',
          subjectId: id,
          before: { status: 'pending' },
          after: { status, note },
        },
        tx,
      );
    });
  }

  /** The board's delta picks up the pending-request marker. */
  private async touchSession(sessionId: number): Promise<void> {
    await this.prisma.classSession.update({
      where: { id: sessionId },
      data: { updatedAt: this.clock.now() },
    });
  }

  private async toDtos(
    rows: Row[],
    viewer: AuthUser,
    withSession = true,
  ): Promise<SessionRequestDto[]> {
    const sessions = withSession
      ? await this.presenter.many(
          rows.map((r) => r.session),
          viewer,
        )
      : [];
    const out: SessionRequestDto[] = [];
    for (const [i, r] of rows.entries()) {
      out.push({
        id: r.id,
        type: r.type,
        status: r.status,
        ...(withSession ? { session: sessions[i] ?? null } : {}),
        student: r.student ? { id: r.student.id, name: r.student.name } : null,
        requestedBy: { id: r.requestedById, name: r.requestedBy.name, role: r.requesterRole },
        reason: r.reason,
        notifiedAt: isoZ(r.notifiedAt),
        proposedStartsAt: isoZ(r.proposedStartsAt),
        proposedDurationMinutes: r.proposedDurationMinutes,
        proposedTeacherId: r.proposedTeacherId,
        decidedBy: r.decidedBy ? { id: r.decidedBy.id, name: r.decidedBy.name } : null,
        decidedAt: isoZ(r.decidedAt),
        decisionNote: r.decisionNote,
        resultSessionId: r.resultSessionId,
        allowedActions: await this.allowedActions(r, viewer),
        dueAt:
          r.status === 'pending' && r.session.startsAt.getTime() > this.clock.nowMs()
            ? isoZ(r.session.startsAt)
            : null,
        createdAt: isoZ(r.createdAt)!,
      });
    }
    return out;
  }
}

const alreadyPending = () =>
  conflictState({ sessionId: ['The same request is already pending for this class.'] });

/** The partial unique index on pending requests lost a race: same answer as the check. */
function rethrowPendingTaken(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw alreadyPending();
  }
  throw error;
}
