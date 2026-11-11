import { Injectable } from '@nestjs/common';
import {
  CANCEL_REASONS,
  LEAVE_REASONS,
  SESSION_ACTIONS,
  type SessionAction,
  type SessionStage,
  TERMINAL_STAGES,
} from '@qarabic/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { validationError } from '../common/errors.js';
import type { ClassSession, Prisma } from '../generated/prisma/client.js';
import type { Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService, type SettingsMap } from '../settings/settings.service.js';
import { isoZ, MINUTE } from '../schedule/time.js';
import { forbiddenAction, invalidTransition, outsideWindow, required } from './errors.js';
import { recordEvent } from './events.js';
import { ZoomMeetings } from './zoom.js';

/** Who performs a transition: a user (role + permissions + own teacher id) or the system. */
export class Actor {
  constructor(
    readonly user: AuthUser | null,
    /** The user's own teacher record, if any. */
    readonly teacherId: number | null,
  ) {}

  static system(): Actor {
    return new Actor(null, null);
  }

  static async of(prisma: PrismaService | Tx, user: AuthUser): Promise<Actor> {
    const teacher = await prisma.teacher.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    return new Actor(user, teacher?.id ?? null);
  }

  isSystem(): boolean {
    return this.user === null;
  }

  canManage(): boolean {
    return this.user === null || this.user.permissions.has('sessions.manage');
  }

  /** The class's own teacher with `sessions.conduct`. */
  isOwnTeacher(s: { teacherId: number }): boolean {
    return (
      this.user !== null &&
      this.user.permissions.has('sessions.conduct') &&
      this.teacherId !== null &&
      this.teacherId === s.teacherId
    );
  }

  canConduct(s: { teacherId: number }): boolean {
    return this.canManage() || this.isOwnTeacher(s);
  }
}

/** The client's screen is out of date: answered as 409 `stale_session` with the fresh class. */
export class StaleSessionError extends Error {
  constructor(readonly sessionId: number) {
    super('stale_session');
  }
}

export interface TransitionInput {
  expectedStage?: SessionStage;
  lockVersion?: number;
  reason?: string;
  note?: string;
  notifiedAt?: string;
  stageReason?: string;
  override?: boolean;
  requestId?: number;
}

type Action = SessionAction | 'move';

/** Fixed target stage of an action (null = depends on history). */
const TARGET: Record<Action, SessionStage | null> = {
  activate: 'activated',
  undo_activate: 'scheduled',
  start: 'in_progress',
  end: 'ended',
  mark_absent: 'absent',
  mark_declined: 'declined',
  mark_leave: 'leave',
  cancel: 'cancelled',
  move: 'moved_out',
  revert: 'scheduled',
  undo_mark: null,
};

const FROM: Record<Action, SessionStage[]> = {
  activate: ['scheduled'],
  undo_activate: ['activated', 'in_progress'],
  start: ['activated'],
  end: ['activated', 'in_progress'],
  mark_absent: ['activated'],
  mark_declined: ['activated', 'in_progress'],
  mark_leave: ['scheduled', 'activated'],
  cancel: ['scheduled'],
  move: ['scheduled'],
  undo_mark: ['absent', 'declined', 'leave', 'taken'],
  revert: ['ended', 'taken', 'absent', 'declined', 'leave', 'cancelled', 'moved_out'],
};

const EVENT: Record<Action, string> = {
  activate: 'activated',
  undo_activate: 'activation_undone',
  start: 'started',
  end: 'ended',
  mark_absent: 'marked',
  mark_declined: 'marked',
  mark_leave: 'marked',
  cancel: 'cancelled',
  move: 'moved_out',
  undo_mark: 'reverted',
  revert: 'reverted',
};

/** The marker may undo a mark for this long (the Undo toast). */
export const UNDO_MARK_MINUTES = 2;

export interface LastStageEvent {
  fromStage: string | null;
  toStage: string | null;
  actorUserId: number | null;
  occurredAt: Date;
}

/** What a guard needs besides the row; batch reads (lists, the board) preload it. */
export interface GuardContext {
  now: number;
  settings: SettingsMap;
  /** Does the class's teacher run another class right now? */
  teacherRunsAnother: () => Promise<boolean>;
  lastStageEvent: () => Promise<LastStageEvent | null>;
}

type Row = Pick<
  ClassSession,
  'id' | 'teacherId' | 'stage' | 'startsAt' | 'endsAt' | 'activatedAt' | 'lockVersion'
>;

const isTerminal = (stage: string) => (TERMINAL_STAGES as readonly string[]).includes(stage);

/**
 * The class state machine (D39, docs/14 §3), ported from Laravel `SessionStateMachine`. Every
 * stage change goes through `apply()`: one transaction, a row lock on the class, the guards, the
 * update, a `session_events` row, then side effects after commit (Zoom). `allowedActions()` runs
 * the same guards without side effects so the API can tell the UI which buttons to show.
 */
@Injectable()
export class SessionStateMachine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly zoom: ZoomMeetings,
  ) {}

  /**
   * @param effect extra writes inside the transaction (e.g. the request decision).
   * @param tx run inside the caller's transaction instead of a new one.
   */
  async apply(
    sessionId: number,
    action: Action,
    actor: Actor,
    input: TransitionInput = {},
    tx?: Tx,
  ): Promise<{ from: SessionStage; to: SessionStage }> {
    const settings = await this.settings.all();
    const run = async (db: Tx) => {
      await db.$queryRaw`SELECT id FROM "class_sessions" WHERE id = ${sessionId} FOR UPDATE`;
      const s = await db.classSession.findUniqueOrThrow({ where: { id: sessionId } });
      const current = s.stage;

      // Double click / retry: already where this action leads → no-op.
      const target = TARGET[action];
      if (target !== null && current === target && input.expectedStage !== target) {
        return { from: current, to: current, changed: false };
      }
      if (input.expectedStage !== undefined && input.expectedStage !== current) {
        throw new StaleSessionError(s.id);
      }
      if (input.lockVersion !== undefined && input.lockVersion !== s.lockVersion) {
        throw new StaleSessionError(s.id);
      }

      const now = this.clock.nowMs();
      const ctx = this.liveContext(db, s, now, settings);
      await this.guard(s, action, actor, input, false, ctx);
      const { data, to } = await this.transition(s, action, actor, input, ctx);
      await db.classSession.update({
        where: { id: s.id },
        data: { ...data, stage: to, lockVersion: { increment: 1 }, updatedAt: new Date(now) },
      });
      await recordEvent(db, this.clock, s.id, EVENT[action], {
        from: current,
        to,
        payload: payload(action, input),
        actor: actor.user,
      });
      return { from: current, to, changed: true };
    };

    const result = tx ? await run(tx) : await this.prisma.$transaction(run);
    if (result.changed && (result.to === 'cancelled' || result.to === 'moved_out') && !tx) {
      await this.zoom.delete(sessionId);
    }
    return { from: result.from, to: result.to };
  }

  /** Actions this actor may perform right now (docs/14 §3.2 server-computed `allowed_actions`). */
  async allowedActions(s: Row, actor: Actor, ctx: GuardContext): Promise<string[]> {
    const allowed: string[] = [];
    for (const action of SESSION_ACTIONS) {
      try {
        await this.guard(s, action, actor, {}, true, ctx);
        allowed.push(action);
      } catch {
        // not allowed now
      }
    }
    // The report is sent with the lesson report (N3), not as a transition: an ended class always
    // offers it; a taken one to staff with sessions.manage (the teacher's edit window comes in N3).
    if (s.stage === 'ended' && actor.canConduct(s)) allowed.push('submit_report');
    if (s.stage === 'taken' && actor.canConduct(s) && actor.canManage())
      allowed.push('submit_report');
    return allowed;
  }

  /** Time-guarded actions not allowed yet but soon (docs/14 §8.3 `upcoming_actions`). */
  upcomingActions(
    s: Row,
    actor: Actor,
    ctx: GuardContext,
  ): Array<{ action: string; availableAt: string }> {
    if (!actor.canConduct(s)) return [];
    const st = ctx.settings;
    const at: Array<[string, number]> = [];
    if (s.stage === 'scheduled') {
      at.push([
        'activate',
        s.startsAt.getTime() - st['sessions.activation_window_before_min'] * MINUTE,
      ]);
    }
    if ((s.stage === 'activated' || s.stage === 'in_progress') && !actor.canManage()) {
      const base = (s.activatedAt ?? s.startsAt).getTime();
      at.push(['end', base + st['sessions.min_duration_min'] * MINUTE]);
    }
    if (s.stage === 'activated') {
      at.push(['mark_absent', s.startsAt.getTime() + st['sessions.absent_min_wait_min'] * MINUTE]);
    }
    return at
      .filter(([, time]) => time > ctx.now)
      .map(([action, time]) => ({ action, availableAt: isoZ(time)! }));
  }

  // ------------------------------------------------------------------ guards

  private async guard(
    s: Row,
    action: Action,
    actor: Actor,
    input: TransitionInput,
    dry: boolean,
    ctx: GuardContext,
  ): Promise<void> {
    if (!FROM[action].includes(s.stage)) throw invalidTransition();
    const st = ctx.settings;
    const now = ctx.now;
    const manage = actor.canManage();
    const override = manage && !!input.override;
    const starts = s.startsAt.getTime();
    const ends = s.endsAt.getTime();

    switch (action) {
      case 'activate': {
        this.requireConduct(s, actor);
        const opens = starts - st['sessions.activation_window_before_min'] * MINUTE;
        const closes = ends + st['sessions.activation_window_after_min'] * MINUTE;
        if ((now < opens || now > closes) && !(manage && dry) && !override) {
          throw outsideWindow({ availableFrom: [isoZ(opens)!], availableUntil: [isoZ(closes)!] });
        }
        if (override && !dry) requireText(input.reason, 'reason');
        if (await ctx.teacherRunsAnother()) {
          throw invalidTransition({ teacher: ['The teacher already has a running class.'] });
        }
        break;
      }
      case 'undo_activate': {
        this.requireConduct(s, actor);
        const limit = s.activatedAt
          ? s.activatedAt.getTime() + st['sessions.undo_activation_min'] * MINUTE
          : null;
        if (!manage && (limit === null || now > limit)) throw outsideWindow();
        break;
      }
      case 'start':
        this.requireConduct(s, actor);
        break;
      case 'mark_declined':
        this.requireConduct(s, actor);
        if (!dry) requireText(input.note, 'note');
        break;
      case 'end': {
        this.requireConduct(s, actor);
        const minEnd =
          (s.activatedAt ?? s.startsAt).getTime() + st['sessions.min_duration_min'] * MINUTE;
        if (now < minEnd) {
          if (!manage) throw outsideWindow({ availableFrom: [isoZ(minEnd)!] });
          if (!dry) requireText(input.reason, 'reason');
        }
        break;
      }
      case 'mark_absent': {
        this.requireConduct(s, actor);
        const from = starts + st['sessions.absent_min_wait_min'] * MINUTE;
        if (now < from && !override) throw outsideWindow({ availableFrom: [isoZ(from)!] });
        if (!dry) requireText(input.note, 'note');
        break;
      }
      case 'mark_leave': {
        this.requireConduct(s, actor);
        const reason = input.stageReason ?? 'student';
        if (
          !(LEAVE_REASONS as readonly string[]).includes(reason) ||
          (reason === 'teacher' && !manage)
        ) {
          throw validationError({ stageReason: ['The selected stage reason is invalid.'] });
        }
        if (!manage && !dry) {
          // dry: the teacher can say when they were told
          const notified = input.notifiedAt ? new Date(input.notifiedAt).getTime() : now;
          const hours = st['sessions.leave_notice_hours'];
          const deadline = starts - hours * 60 * MINUTE;
          if (notified > deadline || notified > now) {
            throw outsideWindow({
              notifiedAt: [`A leave needs at least ${hours} hours' notice before the class.`],
            });
          }
        }
        break;
      }
      case 'cancel':
        if (!manage) throw forbiddenAction();
        if (!dry && !(CANCEL_REASONS as readonly string[]).includes(input.stageReason ?? '')) {
          throw validationError({ stageReason: ['The selected stage reason is invalid.'] });
        }
        break;
      case 'move':
        if (!actor.isSystem()) throw forbiddenAction();
        break;
      case 'undo_mark': {
        const last = await ctx.lastStageEvent();
        if (
          actor.isSystem() ||
          !last ||
          last.actorUserId !== actor.user!.id ||
          last.toStage !== s.stage ||
          last.occurredAt.getTime() < now - UNDO_MARK_MINUTES * MINUTE
        ) {
          throw invalidTransition();
        }
        break;
      }
      case 'revert':
        if (!manage) throw forbiddenAction();
        if (!dry) requireText(input.reason, 'reason');
        break;
    }
  }

  private requireConduct(s: Row, actor: Actor): void {
    if (!actor.canConduct(s)) throw forbiddenAction();
  }

  // ------------------------------------------------------------------ effects

  private async transition(
    s: Row,
    action: Action,
    actor: Actor,
    input: TransitionInput,
    ctx: GuardContext,
  ): Promise<{ data: Prisma.ClassSessionUncheckedUpdateInput; to: SessionStage }> {
    const now = new Date(ctx.now);
    const data: Prisma.ClassSessionUncheckedUpdateInput = {};
    const leaveTerminal = () =>
      Object.assign(data, { stageReason: null, markedAt: null, markedById: null });

    switch (action) {
      case 'activate':
        data.activatedAt = now;
        break;
      case 'undo_activate':
        data.activatedAt = null;
        data.startedAt = null;
        break;
      case 'start':
        data.startedAt = now;
        break;
      case 'end': {
        data.endedAt = now;
        const minEnd =
          (s.activatedAt ?? s.startsAt).getTime() +
          ctx.settings['sessions.min_duration_min'] * MINUTE;
        if (ctx.now < minEnd) {
          data.needsReview = true;
          data.reviewReason = 'short_duration';
        }
        break;
      }
      case 'mark_leave':
        data.stageReason = input.stageReason ?? 'student';
        break;
      case 'cancel':
        data.stageReason = input.stageReason ?? null;
        break;
      case 'move':
        data.stageReason = input.stageReason ?? 'rescheduled';
        break;
      case 'undo_mark': {
        const previous = (await ctx.lastStageEvent())!.fromStage as SessionStage;
        leaveTerminal();
        if (previous === 'scheduled') data.activatedAt = null;
        return { data, to: previous };
      }
      case 'revert':
        leaveTerminal();
        Object.assign(data, { activatedAt: null, startedAt: null, endedAt: null });
        return { data, to: 'scheduled' };
    }

    const to = TARGET[action]!;
    if (isTerminal(to)) {
      data.markedAt = now;
      data.markedById = actor.user?.id ?? null;
    }
    return { data, to };
  }

  /** Guard context for one class inside a write (live reads). */
  private liveContext(db: Tx, s: Row, now: number, settings: SettingsMap): GuardContext {
    return {
      now,
      settings,
      teacherRunsAnother: async () =>
        (await db.classSession.count({
          where: {
            teacherId: s.teacherId,
            id: { not: s.id },
            deletedAt: null,
            stage: { in: ['activated', 'in_progress'] },
          },
        })) > 0,
      lastStageEvent: () =>
        db.sessionEvent.findFirst({
          where: { sessionId: s.id, toStage: { not: null } },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          select: { fromStage: true, toStage: true, actorUserId: true, occurredAt: true },
        }),
    };
  }
}

function requireText(value: string | undefined, field: string): void {
  if (!value || value.trim() === '') throw required(field);
}

function payload(action: Action, input: TransitionInput): Record<string, unknown> | null {
  const out: Record<string, unknown> = { action };
  if (input.reason) out.reason = input.reason;
  if (input.note) out.note = input.note;
  if (input.notifiedAt) out.notifiedAt = input.notifiedAt;
  if (input.stageReason) out.stageReason = input.stageReason;
  if (input.override) out.override = true;
  if (action === 'undo_mark') out.undo = true;
  if (input.requestId) out.requestId = input.requestId;
  return out;
}
