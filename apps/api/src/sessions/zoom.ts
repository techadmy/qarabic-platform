import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { Crypto } from '../common/crypto.js';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { recordEvent } from './events.js';

/**
 * Zoom meetings API (docs/14 §7.1) behind a driver interface. Drivers: `none` (production until
 * Zoom is bought, B7: classes use the enrollment's fixed link) and `fake` (local, CI, staging:
 * deterministic, in memory). The real server-to-server driver is not built yet: it needs the
 * academy's Zoom account and credentials.
 */
export interface ZoomClient {
  /** False for the `none` driver. */
  enabled(): boolean;
  createMeeting(
    hostUserId: string,
    meeting: { topic: string; startTime: string; duration: number },
  ): Promise<{ id: string; joinUrl: string }>;
  updateMeeting(
    meetingId: string,
    meeting: { topic: string; startTime: string; duration: number },
  ): Promise<void>;
  deleteMeeting(meetingId: string): Promise<void>;
  /** A fresh host start URL. Never stored or logged (it embeds a host token). */
  startUrl(meetingId: string): Promise<string>;
}

export class ZoomError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

export class NoneZoomClient implements ZoomClient {
  enabled(): boolean {
    return false;
  }
  createMeeting(): Promise<{ id: string; joinUrl: string }> {
    return Promise.reject(new ZoomError('zoom_disabled', 400));
  }
  updateMeeting(): Promise<void> {
    return Promise.resolve();
  }
  deleteMeeting(): Promise<void> {
    return Promise.resolve();
  }
  startUrl(): Promise<string> {
    return Promise.reject(new ZoomError('zoom_disabled', 400));
  }
}

/** Deterministic driver: `calls` lists what was asked so tests can assert the contract. */
export class FakeZoomClient implements ZoomClient {
  calls: Array<[string, Record<string, unknown>]> = [];
  failNext: 'rate_limited' | 'server' | null = null;
  private seq = 0;

  enabled(): boolean {
    return true;
  }

  createMeeting(
    hostUserId: string,
    meeting: { topic: string; startTime: string; duration: number },
  ): Promise<{ id: string; joinUrl: string }> {
    this.maybeFail();
    this.seq += 1;
    const id = String(80_000_000_000 + this.seq);
    this.calls.push(['create', { host: hostUserId, ...meeting }]);
    return Promise.resolve({ id, joinUrl: `https://zoom.example.test/j/${id}?pwd=fake` });
  }

  updateMeeting(
    meetingId: string,
    meeting: { topic: string; startTime: string; duration: number },
  ): Promise<void> {
    this.maybeFail();
    this.calls.push(['update', { id: meetingId, ...meeting }]);
    return Promise.resolve();
  }

  deleteMeeting(meetingId: string): Promise<void> {
    this.calls.push(['delete', { id: meetingId }]);
    return Promise.resolve();
  }

  startUrl(meetingId: string): Promise<string> {
    this.maybeFail();
    this.calls.push(['start_url', { id: meetingId }]);
    return Promise.resolve(
      `https://zoom.example.test/s/${meetingId}?zak=fake-host-token-${randomBytes(4).toString('hex')}`,
    );
  }

  private maybeFail(): void {
    if (this.failNext) {
      const status = this.failNext === 'rate_limited' ? 429 : 500;
      this.failNext = null;
      throw new ZoomError('fake failure', status);
    }
  }
}

/** The configured driver (`ZOOM_DRIVER`); tests swap it with `use()`. */
@Injectable()
export class ZoomDriver {
  private current: ZoomClient;

  constructor(@Inject(ENV) env: Env) {
    this.current = env.ZOOM_DRIVER === 'fake' ? new FakeZoomClient() : new NoneZoomClient();
  }

  get client(): ZoomClient {
    return this.current;
  }

  use(client: ZoomClient): void {
    this.current = client;
  }
}

const HOST_GAP_MIN = 5;

/**
 * One meeting per class on a host pool (docs/14 §7.2): the teacher's dedicated host when set,
 * else the first pool host with no meeting overlapping [start − 5 min, end + 5 min], chosen
 * under a row lock on `zoom_hosts`. Port of Laravel `ZoomMeetings`; the queue jobs run inline.
 */
@Injectable()
export class ZoomMeetings {
  private readonly logger = new Logger(ZoomMeetings.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly driver: ZoomDriver,
    private readonly clock: Clock,
    private readonly crypto: Crypto,
  ) {}

  get enabled(): boolean {
    return this.driver.client.enabled();
  }

  /** Every 10 min: meetings for classes starting within `zoom.create_lead_hours`. */
  async ensureUpcoming(leadHours: number): Promise<number> {
    if (!this.enabled) return 0;
    const now = this.clock.nowMs();
    const rows = await this.prisma.classSession.findMany({
      where: {
        zoomStatus: 'none',
        stage: 'scheduled',
        deletedAt: null,
        startsAt: { gt: new Date(now), lte: new Date(now + leadHours * 3_600_000) },
        OR: [{ enrollmentId: null }, { enrollment: { meetingMode: 'zoom' } }],
      },
      select: { id: true },
      orderBy: { startsAt: 'asc' },
    });
    for (const { id } of rows) {
      const claimed = await this.prisma.classSession.updateMany({
        where: { id, zoomStatus: 'none' },
        data: { zoomStatus: 'pending', updatedAt: this.clock.now() },
      });
      if (claimed.count) await this.create(id);
    }
    return rows.length;
  }

  async create(sessionId: number): Promise<void> {
    const session = await this.prisma.classSession.findUnique({
      where: { id: sessionId },
      include: { student: { select: { name: true } }, course: { select: { nameEn: true } } },
    });
    if (!session || session.zoomStatus !== 'pending') return;

    const host = await this.prisma.$transaction(async (tx) => {
      const dedicated = await tx.$queryRaw<Array<{ id: number; zoom_user_id: string }>>`
        SELECT id, zoom_user_id FROM "zoom_hosts"
        WHERE teacher_id = ${session.teacherId} AND is_active ORDER BY id LIMIT 1 FOR UPDATE`;
      let chosen = dedicated[0] ?? null;
      if (!chosen) {
        const pool = await tx.$queryRaw<Array<{ id: number; zoom_user_id: string }>>`
          SELECT id, zoom_user_id FROM "zoom_hosts"
          WHERE teacher_id IS NULL AND is_active ORDER BY id FOR UPDATE`;
        for (const h of pool) {
          if (!(await this.hostBusy(tx, h.id, session))) {
            chosen = h;
            break;
          }
        }
      }
      if (!chosen) {
        await this.fail(tx, session.id, 'no_free_host');
        return null;
      }
      // Reserve the host before calling Zoom so parallel runs see it as taken.
      await tx.classSession.update({
        where: { id: session.id },
        data: { zoomHostId: chosen.id, updatedAt: this.clock.now() },
      });
      return chosen;
    });
    if (!host) return;

    try {
      const meeting = await this.driver.client.createMeeting(host.zoom_user_id, payload(session));
      await this.prisma.$transaction(async (tx) => {
        await tx.classSession.update({
          where: { id: session.id },
          data: {
            zoomStatus: 'ready',
            zoomMeetingId: meeting.id,
            zoomJoinUrl: this.crypto.encrypt(meeting.joinUrl),
            zoomError: null,
            updatedAt: this.clock.now(),
          },
        });
        await recordEvent(tx, this.clock, session.id, 'zoom_created', {
          payload: { meetingId: meeting.id, hostId: host.id },
        });
      });
    } catch (error) {
      const message = error instanceof ZoomError ? error.message : 'zoom_error';
      this.logger.warn(`Zoom meeting for class ${session.id} failed: ${message}`);
      await this.prisma.$transaction((tx) => this.fail(tx, session.id, message));
    }
  }

  /** Time / teacher change: update the meeting, or move it to a free host. */
  async update(sessionId: number): Promise<void> {
    const session = await this.prisma.classSession.findUnique({
      where: { id: sessionId },
      include: { student: { select: { name: true } }, course: { select: { nameEn: true } } },
    });
    if (!session?.zoomMeetingId) return;
    const teacherHost = await this.prisma.zoomHost.findFirst({
      where: { teacherId: session.teacherId, isActive: true },
    });
    const mustMove =
      (teacherHost && session.zoomHostId !== teacherHost.id) ||
      (session.zoomHostId !== null &&
        (await this.hostBusy(this.prisma, session.zoomHostId, session)));
    try {
      if (mustMove) {
        await this.driver.client.deleteMeeting(session.zoomMeetingId);
        await this.prisma.classSession.update({
          where: { id: session.id },
          data: {
            zoomStatus: 'pending',
            zoomMeetingId: null,
            zoomJoinUrl: null,
            zoomHostId: null,
            updatedAt: this.clock.now(),
          },
        });
        await this.create(session.id);
        return;
      }
      await this.driver.client.updateMeeting(session.zoomMeetingId, payload(session));
      await recordEvent(this.prisma, this.clock, session.id, 'zoom_updated', {
        payload: { meetingId: session.zoomMeetingId },
      });
    } catch (error) {
      this.logger.warn(`Zoom update for class ${session.id} failed: ${String(error)}`);
    }
  }

  /** Cancelled / moved / removed class: delete the meeting (it would block a host). */
  async delete(sessionId: number): Promise<void> {
    const session = await this.prisma.classSession.findUnique({ where: { id: sessionId } });
    if (!session?.zoomMeetingId) return;
    try {
      await this.driver.client.deleteMeeting(session.zoomMeetingId);
      await this.prisma.classSession.update({
        where: { id: session.id },
        data: { zoomStatus: 'deleted', zoomJoinUrl: null },
      });
    } catch (error) {
      this.logger.warn(`Zoom delete for class ${session.id} failed: ${String(error)}`);
    }
  }

  private async hostBusy(
    db: Pick<PrismaService, 'classSession'>,
    hostId: number,
    session: { id: number; startsAt: Date; endsAt: Date },
  ): Promise<boolean> {
    const gap = HOST_GAP_MIN * 60_000;
    const row = await db.classSession.findFirst({
      where: {
        zoomHostId: hostId,
        id: { not: session.id },
        zoomStatus: { in: ['pending', 'ready'] },
        stage: { notIn: ['cancelled', 'moved_out', 'leave'] },
        deletedAt: null,
        startsAt: { lt: new Date(session.endsAt.getTime() + gap) },
        endsAt: { gt: new Date(session.startsAt.getTime() - gap) },
      },
      select: { id: true },
    });
    return row !== null;
  }

  private async fail(
    tx: Pick<PrismaService, 'classSession' | 'sessionEvent'>,
    sessionId: number,
    error: string,
  ): Promise<void> {
    await tx.classSession.update({
      where: { id: sessionId },
      data: {
        zoomStatus: 'failed',
        zoomError: error.slice(0, 255),
        zoomHostId: null,
        updatedAt: this.clock.now(),
      },
    });
    await recordEvent(tx, this.clock, sessionId, 'zoom_failed', { payload: { error } });
  }
}

/** Topic: course + the student's first name only (no surnames, no emails). */
function payload(s: {
  startsAt: Date;
  durationMinutes: number;
  student: { name: string } | null;
  course: { nameEn: string } | null;
}) {
  const first = (s.student?.name ?? '').trim().split(/\s+/)[0] ?? '';
  return {
    topic: [s.course?.nameEn ?? 'Class', first].filter(Boolean).join(' — '),
    startTime: s.startsAt.toISOString().replace('.000Z', 'Z'),
    duration: s.durationMinutes,
  };
}
