import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { Clock } from '../common/clock.js';
import { ENV, type Env } from '../config/env.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { recordEvent } from '../sessions/events.js';
import { SettingsService } from '../settings/settings.service.js';
import { ZoomApi } from './zoom.api.js';
import { ZoomConfig } from './zoom.config.js';

const MINUTE = 60_000;
/** A class "owns" events from 15 minutes before its start to 15 minutes after its end. */
const WINDOW_MS = 15 * MINUTE;
/** Zoom signs with a timestamp; older requests are replays. */
export const SIGNATURE_MAX_AGE_MS = 5 * MINUTE;
/** A row left `processing` this long (a crashed run) is taken back. */
const STUCK_MS = 10 * MINUTE;
const MAX_ATTEMPTS = 5;
/** Event log retention (docs/42 §6.1). */
export const RETENTION_DAYS = 60;
const HANDLED = new Set([
  'meeting.started',
  'meeting.ended',
  'meeting.participant_joined',
  'meeting.participant_left',
]);

// ------------------------------------------------------------------ signatures

/** `x-zm-signature`: `v0=` + HMAC-SHA256(secret, `v0:{timestamp}:{raw body}`), hex. */
/** Over the raw bytes as received (never a re-encoded string). */
export function zoomSignature(secret: string, timestamp: string, rawBody: Buffer | string): string {
  return `v0=${createHmac('sha256', secret)
    .update(`v0:${timestamp}:`)
    .update(rawBody)
    .digest('hex')}`;
}

export function signatureValid(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: Buffer | undefined,
  nowMs: number,
): boolean {
  if (!secret || !timestamp || !signature || !rawBody) return false;
  // Zoom sends seconds; accept milliseconds too.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const ms = ts > 1e12 ? ts : ts * 1000;
  if (Math.abs(nowMs - ms) > SIGNATURE_MAX_AGE_MS) return false;
  const want = Buffer.from(zoomSignature(secret, timestamp, rawBody));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** `endpoint.url_validation`: `{ plainToken, encryptedToken = HMAC-SHA256(secret, plainToken) }`. */
export function urlValidation(secret: string, plainToken: string) {
  return {
    plainToken,
    encryptedToken: createHmac('sha256', secret).update(plainToken).digest('hex'),
  };
}

// ------------------------------------------------------------------ payload helpers

interface Participant {
  id?: string;
  user_id?: string;
  participant_uuid?: string;
  user_name?: string;
  email?: string;
  /** Stored instead of the email (review P2): sha256 of the lower-cased address. */
  email_hash?: string;
  join_time?: string;
  leave_time?: string;
}
export interface ZoomBody {
  event?: string;
  event_ts?: number;
  payload?: {
    object?: {
      id?: string | number;
      uuid?: string;
      host_id?: string;
      start_time?: string;
      end_time?: string;
      participant?: Participant;
    };
  };
}

function eventTime(body: ZoomBody): number {
  const o = body.payload?.object;
  const p = o?.participant;
  const raw =
    (body.event === 'meeting.participant_left' ? p?.leave_time : p?.join_time) ??
    (body.event === 'meeting.ended' ? o?.end_time : o?.start_time);
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : (body.event_ts ?? 0);
}

const participantKey = (p: Participant | undefined) =>
  p
    ? (p.user_id ??
      p.participant_uuid ??
      p.id ??
      p.email_hash ??
      (p.email ? emailHash(p.email) : null) ??
      p.user_name ??
      '')
    : '';

/** One row per real-world happening, whether it came from the webhook (or its retry) or the report. */
export function eventKey(body: ZoomBody): string {
  const o = body.payload?.object;
  return createHash('sha256')
    .update(
      [body.event, o?.uuid ?? o?.id ?? '', participantKey(o?.participant), eventTime(body)].join(
        '|',
      ),
    )
    .digest('hex');
}

/** The host is the teacher (1-to-1 classes, D134): anyone else in the meeting is the student. */
export const emailHash = (email: string) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/**
 * The host is the teacher (1-to-1 classes, D134): anyone else in the meeting is the student. The
 * Zoom user id decides; the (hashed) email only when the event carries no user id.
 */
function isHost(
  p: Participant | undefined,
  host: { zoomUserId: string; email: string },
  hostId: string | null,
): boolean {
  if (!p) return false;
  if (p.id) return p.id === host.zoomUserId || p.id === hostId;
  const hash = p.email_hash ?? (p.email ? emailHash(p.email) : null);
  return hash !== null && hash === emailHash(host.email);
}

/**
 * What is kept of an event (review P2): handled events without names and with the email hashed;
 * any other event as metadata only.
 */
function storedPayload(body: ZoomBody, handled: boolean): Prisma.InputJsonValue {
  const o = body.payload?.object;
  if (!handled) {
    return {
      event: body.event ?? null,
      event_ts: body.event_ts ?? null,
      payload: {
        object: { id: o?.id ?? null, uuid: o?.uuid ?? null, host_id: o?.host_id ?? null },
      },
    };
  }
  const p = o?.participant;
  const participant = p
    ? {
        ...(p.id ? { id: p.id } : {}),
        ...(p.user_id ? { user_id: p.user_id } : {}),
        ...(p.participant_uuid ? { participant_uuid: p.participant_uuid } : {}),
        ...(p.email || p.email_hash ? { email_hash: p.email_hash ?? emailHash(p.email!) } : {}),
        ...(p.join_time ? { join_time: p.join_time } : {}),
        ...(p.leave_time ? { leave_time: p.leave_time } : {}),
      }
    : undefined;
  return {
    event: body.event,
    event_ts: body.event_ts ?? null,
    payload: {
      object: {
        id: o?.id ?? null,
        uuid: o?.uuid ?? null,
        host_id: o?.host_id ?? null,
        ...(o?.start_time ? { start_time: o.start_time } : {}),
        ...(o?.end_time ? { end_time: o.end_time } : {}),
        ...(participant ? { participant } : {}),
      },
    },
  };
}

const ACTIVE_STAGES: Prisma.EnumSessionStageFilter = { notIn: ['cancelled', 'moved_out'] };

/**
 * Z1 (docs/42 §6, D148): Zoom attendance. Each teacher's classes run on their personal meeting
 * (PMI), classes are 1-to-1 (D134), so the host is the teacher and anyone else is the student.
 * Events are stored once and processed in the background; a minute job raises the review flags;
 * after a meeting ends, the participant report fills missed events.
 */
@Injectable()
export class ZoomAttendance implements OnApplicationBootstrap {
  private readonly logger = new Logger(ZoomAttendance.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: ZoomConfig,
    private readonly api: ZoomApi,
    private readonly settings: SettingsService,
    private readonly registry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.SCHEDULER_ENABLED) return;
    const job = CronJob.from({
      cronTime: '0 * * * * *',
      onTick: () => {
        if (!this.config.enabled) return;
        this.tick().catch((e: unknown) => this.logger.error('zoom:attendance failed', e as Error));
      },
    });
    this.registry.addCronJob('zoom:attendance', job);
    job.start();
    const prune = CronJob.from({
      cronTime: '0 40 3 * * *',
      onTick: () => {
        this.prune().catch((e: unknown) => this.logger.error('zoom:prune failed', e as Error));
      },
    });
    this.registry.addCronJob('zoom:prune', prune);
    prune.start();
  }

  /** Every minute: pending events, finished meetings' reports, then the review flags. */
  async tick(): Promise<void> {
    await this.processPending();
    await this.reconcile();
    await this.carryOverTeachers();
    await this.flagFinished();
  }

  /**
   * Classes of tracked teachers that started (or start within 15 minutes) without a join of the
   * teacher: if the teacher is already in their meeting from the class before, they joined.
   */
  async carryOverTeachers(): Promise<number> {
    if (!this.config.enabled) return 0;
    const now = this.clock.nowMs();
    const hosts = await this.prisma.zoomHost.findMany({
      where: { teacherId: { not: null }, pmiMeetingId: { not: null }, isActive: true },
    });
    let n = 0;
    for (const host of hosts) {
      const rows = await this.prisma.classSession.findMany({
        where: {
          teacherId: host.teacherId!,
          deletedAt: null,
          teacherJoinedAt: null,
          stage: ACTIVE_STAGES,
          startsAt: { gte: new Date(now - 6 * 60 * MINUTE), lte: new Date(now + WINDOW_MS) },
        },
      });
      for (const s of rows) {
        const opened = s.startsAt.getTime() - WINDOW_MS;
        if (!(await this.teacherPresentAt(host, opened))) continue;
        await this.prisma.classSession.update({
          where: { id: s.id },
          data: { teacherJoinedAt: new Date(opened), updatedAt: this.clock.now() },
        });
        n++;
      }
    }
    return n;
  }

  // ---------------------------------------------------------------- intake

  /** Stores the event (idempotent). Returns false for a duplicate. */
  async store(body: ZoomBody, source: 'webhook' | 'report' = 'webhook'): Promise<boolean> {
    const o = body.payload?.object;
    const at = eventTime(body);
    const data: Prisma.ZoomWebhookEventCreateInput = {
      eventKey: eventKey(body),
      event: String(body.event ?? 'unknown').slice(0, 64),
      source,
      meetingId: o?.id !== undefined ? String(o.id).slice(0, 32) : null,
      meetingUuid: o?.uuid?.slice(0, 128) ?? null,
      hostId: o?.host_id?.slice(0, 64) ?? null,
      payload: storedPayload(body, HANDLED.has(String(body.event))),
      eventAt: new Date(at || this.clock.nowMs()),
      status: HANDLED.has(String(body.event)) ? 'received' : 'ignored',
      receivedAt: this.clock.now(),
    };
    const created = await this.prisma.zoomWebhookEvent.createMany({ data, skipDuplicates: true });
    return created.count === 1;
  }

  private running: Promise<number> | null = null;
  private dirty = false;

  /**
   * Processes due events in time order. One run at a time in this process: a call during a run
   * marks it dirty and the run goes round again (coalesced), so a burst of webhooks costs one
   * pass. Rows are also claimed once and their class row locked, for several processes.
   */
  processPending(limit = 500): Promise<number> {
    if (this.running) {
      this.dirty = true;
      return this.running;
    }
    const run = (async () => {
      let total = 0;
      try {
        do {
          this.dirty = false;
          total += await this.processBatch(limit);
        } while (this.dirty);
      } finally {
        this.running = null;
      }
      return total;
    })();
    this.running = run;
    return run;
  }

  private async processBatch(limit: number): Promise<number> {
    const now = this.clock.now();
    // A run that died mid-row leaves it `processing`: take it back after a while.
    await this.prisma.zoomWebhookEvent.updateMany({
      where: { status: 'processing', claimedAt: { lt: new Date(now.getTime() - STUCK_MS) } },
      data: { status: 'received' },
    });
    const rows = await this.prisma.zoomWebhookEvent.findMany({
      where: {
        OR: [
          { status: 'received' },
          // Failed rows are retried with backoff, a few times.
          { status: 'failed', attempts: { lt: MAX_ATTEMPTS }, nextAttemptAt: { lte: now } },
        ],
      },
      orderBy: [{ eventAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    let done = 0;
    for (const row of rows) {
      const claim = await this.prisma.zoomWebhookEvent.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: 'processing', claimedAt: this.clock.now() },
      });
      if (claim.count !== 1) continue;
      try {
        const result = await this.apply(row.payload as ZoomBody, row.eventAt.getTime());
        await this.prisma.zoomWebhookEvent.update({
          where: { id: row.id },
          data: {
            status: result.sessionId ? 'processed' : 'unmatched',
            sessionId: result.sessionId,
            error: result.note,
            processedAt: this.clock.now(),
          },
        });
        done++;
      } catch (error) {
        const attempts = row.attempts + 1;
        this.logger.error(`zoom event ${row.id} failed (attempt ${attempts})`, error as Error);
        await this.prisma.zoomWebhookEvent.update({
          where: { id: row.id },
          data: {
            status: 'failed',
            attempts,
            // 1, 2, 4, 8 minutes.
            nextAttemptAt: new Date(this.clock.nowMs() + 2 ** (attempts - 1) * MINUTE),
            error: (error as Error).message.slice(0, 500),
            processedAt: this.clock.now(),
          },
        });
      }
    }
    return done;
  }

  /** Daily: processed, unmatched and ignored events older than the retention are deleted. */
  async prune(): Promise<number> {
    const { count } = await this.prisma.zoomWebhookEvent.deleteMany({
      where: {
        status: { in: ['processed', 'unmatched', 'ignored'] },
        receivedAt: { lt: new Date(this.clock.nowMs() - RETENTION_DAYS * 24 * 60 * MINUTE) },
      },
    });
    return count;
  }

  // ---------------------------------------------------------------- matching + applying

  private async apply(
    body: ZoomBody,
    at: number,
  ): Promise<{ sessionId: number | null; note: string | null }> {
    const o = body.payload?.object;
    const meetingId = o?.id !== undefined ? String(o.id) : null;
    const hostId = o?.host_id ?? null;
    const host = await this.prisma.zoomHost.findFirst({
      where: {
        teacherId: { not: null },
        isActive: true,
        OR: [
          ...(meetingId ? [{ pmiMeetingId: meetingId }] : []),
          ...(hostId ? [{ zoomUserId: hostId }] : []),
        ],
      },
    });
    if (!host?.teacherId) return { sessionId: null, note: 'no teacher for this meeting' };

    const candidates = await this.prisma.classSession.findMany({
      where: {
        teacherId: host.teacherId,
        deletedAt: null,
        stage: ACTIVE_STAGES,
        startsAt: { lte: new Date(at + WINDOW_MS) },
        endsAt: { gte: new Date(at - WINDOW_MS) },
      },
    });
    if (!candidates.length) return { sessionId: null, note: 'no class in the window' };
    // Back-to-back classes on one PMI: a start or a join belongs to the class starting nearest;
    // an end or a leave to the class ending nearest.
    const ending = body.event === 'meeting.ended' || body.event === 'meeting.participant_left';
    const chosen = candidates.reduce((best, c) => {
      const d = (x: typeof c) => Math.abs((ending ? x.endsAt : x.startsAt).getTime() - at);
      return d(c) < d(best) ? c : best;
    });

    const p = o?.participant;
    const isTeacher = isHost(p, host, hostId);
    const role = isTeacher ? 'teacher' : 'student';
    const when = new Date(at);
    const chosenId = chosen.id;
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "class_sessions" WHERE id = ${chosenId} FOR UPDATE`;
      const s = await tx.classSession.findUniqueOrThrow({ where: { id: chosenId } });
      const data: Prisma.ClassSessionUpdateInput = {};
      // Back-to-back classes on one PMI: the teacher often stays in the meeting, so the next class
      // gets no join of theirs. Present when its window opened = joined at that moment.
      if (!s.teacherJoinedAt && !(isTeacher && body.event === 'meeting.participant_joined')) {
        const opened = s.startsAt.getTime() - WINDOW_MS;
        if (await this.teacherPresentAt(host, opened)) {
          s.teacherJoinedAt = new Date(opened);
          data.teacherJoinedAt = s.teacherJoinedAt;
        }
      }

      switch (body.event) {
        case 'meeting.participant_joined': {
          const field = isTeacher ? 'teacherJoinedAt' : 'studentJoinedAt';
          const current = s[field];
          if (!current || current.getTime() > at) data[field] = when;
          const teacherAt = isTeacher
            ? Math.min(at, s.teacherJoinedAt?.getTime() ?? at)
            : s.teacherJoinedAt?.getTime();
          const studentAt = isTeacher
            ? s.studentJoinedAt?.getTime()
            : Math.min(at, s.studentJoinedAt?.getTime() ?? at);
          if (teacherAt !== undefined && studentAt !== undefined) {
            const both = Math.max(teacherAt, studentAt);
            if (!s.actualStartedAt || s.actualStartedAt.getTime() > both)
              data.actualStartedAt = new Date(both);
          }
          // A rejoin after someone left: the class goes on.
          if (s.actualEndedAt && s.actualEndedAt.getTime() <= at) data.actualEndedAt = null;
          break;
        }
        case 'meeting.participant_left':
          if (s.actualStartedAt && at >= s.actualStartedAt.getTime()) {
            if (!s.actualEndedAt || s.actualEndedAt.getTime() < at) data.actualEndedAt = when;
          }
          break;
        case 'meeting.ended':
          if (s.actualStartedAt && !s.actualEndedAt) data.actualEndedAt = when;
          break;
        default:
          break;
      }
      const type =
        body.event === 'meeting.participant_joined'
          ? 'participant_joined'
          : body.event === 'meeting.participant_left'
            ? 'participant_left'
            : body.event === 'meeting.started'
              ? 'zoom_meeting_started'
              : 'zoom_meeting_ended';
      if (Object.keys(data).length) {
        await tx.classSession.update({
          where: { id: s.id },
          data: { ...data, updatedAt: this.clock.now() },
        });
      }
      // The timeline shows the role only, never a name (B118).
      await recordEvent(tx, this.clock, s.id, type, {
        payload: { at: when.toISOString(), ...(p ? { role } : {}) },
      });
      return { sessionId: s.id, note: null };
    });
  }

  /** Replays the teacher's own joins and leaves on their meeting up to `at`. */
  private async teacherPresentAt(
    host: { zoomUserId: string; email: string; pmiMeetingId: string | null },
    at: number,
  ): Promise<boolean> {
    const events = await this.prisma.zoomWebhookEvent.findMany({
      where: {
        event: { in: ['meeting.participant_joined', 'meeting.participant_left', 'meeting.ended'] },
        eventAt: { lte: new Date(at), gte: new Date(at - 12 * 60 * MINUTE) },
        OR: [
          ...(host.pmiMeetingId ? [{ meetingId: host.pmiMeetingId }] : []),
          { hostId: host.zoomUserId },
        ],
      },
      orderBy: [{ eventAt: 'asc' }, { id: 'asc' }],
    });
    let present = false;
    for (const e of events) {
      const body = e.payload as ZoomBody;
      if (e.event === 'meeting.ended') present = false;
      else if (isHost(body.payload?.object?.participant, host, e.hostId)) {
        present = e.event === 'meeting.participant_joined';
      }
    }
    return present;
  }

  // ---------------------------------------------------------------- reconciliation

  /** After meeting.ended: pull the participant report and fill joins/leaves the webhook missed. */
  async reconcile(): Promise<number> {
    if (!this.config.enabled) return 0;
    const ended = await this.prisma.zoomWebhookEvent.findMany({
      where: {
        event: 'meeting.ended',
        reconciledAt: null,
        meetingUuid: { not: null },
        status: { in: ['processed', 'unmatched'] },
        // Zoom's report needs a moment after the end.
        receivedAt: { lt: new Date(this.clock.nowMs() - 2 * MINUTE) },
      },
      take: 20,
    });
    let done = 0;
    for (const row of ended) {
      try {
        const participants = await this.api.pastParticipants(row.meetingUuid!);
        for (const p of participants) {
          const participant = {
            id: p.userId ?? undefined,
            user_id: p.participantUuid ?? undefined,
            email: p.email ?? undefined,
            join_time: p.joinTime,
            leave_time: p.leaveTime ?? undefined,
          };
          const object = {
            id: row.meetingId ?? undefined,
            uuid: row.meetingUuid!,
            host_id: row.hostId ?? undefined,
          };
          await this.store(
            {
              event: 'meeting.participant_joined',
              payload: { object: { ...object, participant } },
            },
            'report',
          );
          if (p.leaveTime) {
            await this.store(
              {
                event: 'meeting.participant_left',
                payload: { object: { ...object, participant } },
              },
              'report',
            );
          }
        }
        await this.processPending();
        done++;
      } catch (error) {
        this.logger.warn(`zoom report for event ${row.id}: ${(error as Error).message}`);
      }
      await this.prisma.zoomWebhookEvent.update({
        where: { id: row.id },
        data: { reconciledAt: this.clock.now() },
      });
    }
    return done;
  }

  // ---------------------------------------------------------------- review flags

  /**
   * Classes of tracked teachers that ended in the last 6 hours with a no-show or too short:
   * flagged for review once (`needs_review` + the reason), so staff follow up after the board.
   */
  async flagFinished(): Promise<number> {
    if (!this.config.enabled) return 0;
    const st = await this.settings.all();
    const now = this.clock.nowMs();
    const tracked = await this.prisma.zoomHost.findMany({
      where: { teacherId: { not: null }, pmiMeetingId: { not: null }, isActive: true },
      select: { teacherId: true },
    });
    const rows = await this.prisma.classSession.findMany({
      where: {
        teacherId: { in: tracked.map((t) => t.teacherId!) },
        deletedAt: null,
        needsReview: false,
        stage: { notIn: ['cancelled', 'moved_out', 'leave'] },
        endsAt: { gt: new Date(now - 6 * 60 * MINUTE), lt: new Date(now - WINDOW_MS) },
      },
    });
    let flagged = 0;
    for (const s of rows) {
      const reason = zoomFlags(s, now, st).find((c) => c !== 'late');
      if (!reason) continue;
      await this.prisma.classSession.update({
        where: { id: s.id },
        data: { needsReview: true, reviewReason: reason, updatedAt: this.clock.now() },
      });
      flagged++;
    }
    return flagged;
  }
}

/**
 * The Zoom-based flags of a class at `now` (B132 thresholds): late (teacher not in N minutes
 * after the start, while the class runs), teacher no-show, student no-show, too short.
 */
export function zoomFlags(
  s: {
    stage: string;
    startsAt: Date;
    endsAt: Date;
    durationMinutes: number;
    teacherJoinedAt: Date | null;
    studentJoinedAt: Date | null;
    actualStartedAt: Date | null;
    actualEndedAt: Date | null;
  },
  now: number,
  st: {
    'sessions.late_teacher_min': number;
    'sessions.teacher_no_show_min': number;
    'sessions.student_no_show_min': number;
    'sessions.short_class_pct': number;
  },
): Array<'late' | 'teacher_no_show' | 'student_no_show' | 'short_class'> {
  if (['cancelled', 'moved_out', 'leave', 'declined'].includes(s.stage)) return [];
  const start = s.startsAt.getTime();
  const out: Array<'late' | 'teacher_no_show' | 'student_no_show' | 'short_class'> = [];
  const teacherIn =
    s.teacherJoinedAt !== null &&
    s.teacherJoinedAt.getTime() <= start + st['sessions.teacher_no_show_min'] * MINUTE;
  if (
    !s.teacherJoinedAt &&
    now > start + st['sessions.late_teacher_min'] * MINUTE &&
    now <= s.endsAt.getTime()
  ) {
    out.push('late');
  }
  if (!teacherIn && now > start + st['sessions.teacher_no_show_min'] * MINUTE)
    out.push('teacher_no_show');
  if (
    s.teacherJoinedAt &&
    s.stage !== 'absent' &&
    (!s.studentJoinedAt ||
      s.studentJoinedAt.getTime() > start + st['sessions.student_no_show_min'] * MINUTE) &&
    now > start + st['sessions.student_no_show_min'] * MINUTE
  ) {
    out.push('student_no_show');
  }
  if (s.actualStartedAt && s.actualEndedAt) {
    const minutes = (s.actualEndedAt.getTime() - s.actualStartedAt.getTime()) / MINUTE;
    if (minutes < (s.durationMinutes * st['sessions.short_class_pct']) / 100)
      out.push('short_class');
  }
  return out;
}
