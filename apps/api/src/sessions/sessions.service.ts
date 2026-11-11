import { HttpStatus, Injectable } from '@nestjs/common';
import type { SessionKind, SessionSource } from '@qarabic/shared';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import type { Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConflictChecker } from '../schedule/conflicts.js';
import { SettingsService } from '../settings/settings.service.js';
import { fail, forbiddenAction } from './errors.js';
import { recordEvent } from './events.js';
import { type Actor, StaleSessionError } from './state-machine.js';
import { ZoomMeetings } from './zoom.js';

export interface CreateSessionData {
  enrollmentId?: number | null;
  studentId?: number;
  courseId?: number | null;
  teacherId?: number | null;
  kind?: SessionKind;
  startsAt: string;
  durationMinutes: number;
  originSessionId?: number | null;
  source?: SessionSource;
}

/**
 * Single-class writes outside the state machine (Laravel `SessionService`): one-off classes
 * (`POST /sessions`, approved requests) and class shifts / teacher changes (`PATCH
 * /sessions/:id`), always conflict-checked under row locks.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checker: ConflictChecker,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly zoom: ZoomMeetings,
  ) {}

  /**
   * Creates a scheduled class. With `tx`, runs inside the caller's transaction (which must
   * already hold the teacher and student locks); otherwise it takes them.
   */
  async create(
    data: CreateSessionData,
    actor: Actor,
    acknowledged: readonly string[],
    event: { type?: string; payload?: Record<string, unknown> } = {},
    tx?: Tx,
  ): Promise<number> {
    const write = async (db: Tx) => {
      const enrollment = data.enrollmentId
        ? await db.enrollment.findUnique({ where: { id: data.enrollmentId } })
        : null;
      if (data.enrollmentId && !enrollment) throw notFound();
      const teacherId = data.teacherId ?? enrollment!.teacherId;
      const studentId = data.studentId ?? enrollment!.studentId;
      const startsAt = new Date(data.startsAt).getTime();
      const st = await this.settings.all();
      (
        await this.checker.checkSession(
          db,
          {
            teacherId,
            studentId,
            startsAt,
            durationMinutes: data.durationMinutes,
            enrollmentId: enrollment?.id ?? null,
          },
          st,
        )
      ).assertPasses(acknowledged);

      const external = enrollment?.meetingMode === 'external';
      const now = this.clock.now();
      const session = await db.classSession.create({
        data: {
          enrollmentId: enrollment?.id ?? null,
          studentId,
          teacherId,
          courseId: data.courseId ?? enrollment?.courseId ?? null,
          startsAt: new Date(startsAt),
          endsAt: new Date(startsAt + data.durationMinutes * 60_000),
          durationMinutes: data.durationMinutes,
          kind: data.kind ?? 'regular',
          stage: 'scheduled',
          source: data.source ?? 'manual',
          originSessionId: data.originSessionId ?? null,
          zoomStatus: external ? 'external' : 'none',
          // The enrollment's link is stored encrypted: its ciphertext is copied as is.
          zoomJoinUrl: external ? enrollment.externalMeetingUrl : null,
          createdById: actor.user?.id ?? null,
          createdAt: now,
          updatedAt: now,
        },
      });
      await recordEvent(db, this.clock, session.id, event.type ?? 'note', {
        to: 'scheduled',
        payload: event.payload ?? { created: data.source ?? 'manual' },
        actor: actor.user,
      });
      return session.id;
    };
    if (tx) return write(tx);

    const ids = await this.lockTargets(data);
    return this.checker.locked([ids.teacherId], [ids.studentId], write);
  }

  /**
   * Class shift / teacher change of a class that has not started (docs/14 §3.2 edit_time,
   * change_teacher). The class becomes detached: the generator's re-sync leaves it alone.
   */
  async reschedule(
    sessionId: number,
    data: {
      startsAt?: string;
      durationMinutes?: number;
      teacherId?: number;
      expectedStage?: string;
      lockVersion?: number;
      reason?: string;
    },
    actor: Actor,
    acknowledged: readonly string[],
  ): Promise<void> {
    if (!actor.canManage()) throw forbiddenAction();
    const current = await this.prisma.classSession.findUnique({ where: { id: sessionId } });
    if (!current) throw notFound();
    const teacherId = data.teacherId ?? current.teacherId;

    const changed = await this.checker.locked(
      [teacherId, current.teacherId],
      [current.studentId],
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "class_sessions" WHERE id = ${sessionId} FOR UPDATE`;
        const s = await tx.classSession.findUniqueOrThrow({ where: { id: sessionId } });
        if (
          (data.expectedStage !== undefined && data.expectedStage !== s.stage) ||
          (data.lockVersion !== undefined && data.lockVersion !== s.lockVersion)
        ) {
          throw new StaleSessionError(s.id);
        }
        if (s.stage !== 'scheduled' || s.deletedAt) {
          throw fail(HttpStatus.CONFLICT, 'invalid_transition');
        }
        const startsAt = data.startsAt ? new Date(data.startsAt).getTime() : s.startsAt.getTime();
        const minutes = data.durationMinutes ?? s.durationMinutes;
        const st = await this.settings.all();
        (
          await this.checker.checkSession(
            tx,
            {
              teacherId,
              studentId: s.studentId,
              startsAt,
              durationMinutes: minutes,
              excludeSessionId: s.id,
            },
            st,
          )
        ).assertPasses(acknowledged);

        const old = {
          startsAt: s.startsAt.toISOString().replace('.000Z', 'Z'),
          durationMinutes: s.durationMinutes,
          teacherId: s.teacherId,
        };
        const timeChanged = startsAt !== s.startsAt.getTime() || minutes !== s.durationMinutes;
        const teacherChanged = teacherId !== s.teacherId;
        if (!timeChanged && !teacherChanged) return false;

        const now = this.clock.now();
        await tx.classSession.update({
          where: { id: s.id },
          data: {
            startsAt: new Date(startsAt),
            endsAt: new Date(startsAt + minutes * 60_000),
            durationMinutes: minutes,
            teacherId,
            isDetached: true,
            lockVersion: { increment: 1 },
            updatedAt: now,
          },
        });
        const next = {
          startsAt: new Date(startsAt).toISOString().replace('.000Z', 'Z'),
          durationMinutes: minutes,
          teacherId,
        };
        if (timeChanged) {
          await recordEvent(tx, this.clock, s.id, 'time_changed', {
            payload: { old, new: next, reason: data.reason ?? null },
            actor: actor.user,
          });
        }
        if (teacherChanged) {
          await recordEvent(tx, this.clock, s.id, 'teacher_changed', {
            payload: { old: old.teacherId, new: teacherId, reason: data.reason ?? null },
            actor: actor.user,
          });
        }
        return true;
      },
    );
    if (changed) await this.zoom.update(sessionId);
  }

  private async lockTargets(
    data: CreateSessionData,
  ): Promise<{ teacherId: number; studentId: number }> {
    if (data.teacherId && data.studentId)
      return { teacherId: data.teacherId, studentId: data.studentId };
    const enrollment = data.enrollmentId
      ? await this.prisma.enrollment.findUnique({ where: { id: data.enrollmentId } })
      : null;
    if (!enrollment) throw notFound();
    return {
      teacherId: data.teacherId ?? enrollment.teacherId,
      studentId: data.studentId ?? enrollment.studentId,
    };
  }
}
