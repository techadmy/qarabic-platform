import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  BOARD_COUNTERS,
  type BoardDto,
  type Paginated,
  SESSION_STAGES,
  type SessionDetailDto,
  type SessionDto,
  type sessionListQuerySchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { pageArgs, pageMeta, statusCounts } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import { isParentViewer, isTeacherViewer } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isValidZone } from '../schedule/time.js';
import { sessionScopeWhere, viewerScope } from '../schedule/scope.js';
import { addDays, isoZ, localDate, startOfLocalDay } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { SessionGenerator } from './generator.js';
import { LessonReportsService } from './lesson-reports.js';
import { SessionPresenter, sessionInclude, type SessionRow } from './presenter.js';

type ListQuery = z.output<typeof sessionListQuerySchema>;

/**
 * Class reads: the list, one class with its timeline, and the Today board (docs/14 §6.2, §8.3):
 * the viewer's day, the old counters in the old order and a `since` cursor for 15-second polling.
 * Rows are scoped to the viewer (a teacher: own classes; a parent: own children).
 */
/** The class events a parent or teacher sees (no notes, Zoom internals or undo bookkeeping). */
const PORTAL_EVENT_TYPES = new Set([
  'generated',
  'created',
  'activated',
  'started',
  'ended',
  'marked',
  'cancelled',
  'moved_out',
  'reverted',
  'report_submitted',
  'time_changed',
  'teacher_changed',
]);
/** Payload keys a parent or teacher may see: the step and its fixed code, never free text. */
const PORTAL_PAYLOAD_KEYS = ['action', 'stageReason', 'undo', 'from', 'to'];
function portalPayload(raw: Record<string, unknown>): Record<string, unknown> | null {
  const out = Object.fromEntries(
    Object.entries(raw).filter(([k]) => PORTAL_PAYLOAD_KEYS.includes(k)),
  );
  return Object.keys(out).length ? out : null;
}

@Injectable()
export class SessionReads {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly presenter: SessionPresenter,
    private readonly generator: SessionGenerator,
    private readonly reports: LessonReportsService,
  ) {}

  async find(id: number, viewer: AuthUser): Promise<SessionRow> {
    const scope = await viewerScope(this.prisma, viewer);
    const row = await this.prisma.classSession.findFirst({
      where: { AND: [{ id, deletedAt: null }, sessionScopeWhere(scope)] },
      include: sessionInclude,
    });
    if (!row) throw notFound();
    return row;
  }

  async dto(id: number, viewer: AuthUser): Promise<SessionDto> {
    const row = await this.prisma.classSession.findUniqueOrThrow({
      where: { id },
      include: sessionInclude,
    });
    return this.presenter.one(row, viewer);
  }

  async list(q: ListQuery, viewer: AuthUser): Promise<Paginated<SessionDto>> {
    const scope = await viewerScope(this.prisma, viewer);
    const and: Prisma.ClassSessionWhereInput[] = [sessionScopeWhere(scope), { deletedAt: null }];
    if (q.date) {
      const tz = q.tz ?? (await this.viewerZone(viewer));
      and.push({
        startsAt: {
          gte: new Date(startOfLocalDay(q.date, tz)),
          lt: new Date(startOfLocalDay(addDays(q.date, 1), tz)),
        },
      });
    }
    if (q.from) and.push({ startsAt: { gte: new Date(q.from) } });
    if (q.to) and.push({ startsAt: { lt: new Date(q.to) } });
    if (q.teacherId) and.push({ teacherId: q.teacherId });
    if (q.studentId) and.push({ studentId: q.studentId });
    if (q.enrollmentId) and.push({ enrollmentId: q.enrollmentId });
    if (q.kind?.length) and.push({ kind: { in: q.kind } });
    if (q.attention === 'needs_review') and.push({ needsReview: true });
    if (q.attention === 'zoom_failed') and.push({ zoomStatus: 'failed' });
    if (q.attention === 'pending_request') and.push({ requests: { some: { status: 'pending' } } });
    const where: Prisma.ClassSessionWhereInput = { AND: and };
    const listWhere = q.stage?.length ? { AND: [...and, { stage: { in: q.stage } }] } : where;

    const [rows, total, groups] = await Promise.all([
      this.prisma.classSession.findMany({
        where: listWhere,
        include: sessionInclude,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        ...pageArgs(q),
      }),
      this.prisma.classSession.count({ where: listWhere }),
      this.prisma.classSession.groupBy({ by: ['stage'], where, _count: { _all: true } }),
    ]);
    return {
      data: await this.presenter.many(rows, viewer),
      meta: pageMeta(
        q,
        total,
        statusCounts(
          SESSION_STAGES,
          groups.map((g) => ({ status: g.stage, _count: g._count })),
        ),
      ),
    };
  }

  /** `GET /sessions/:id`: the class + its timeline + its lesson report + its requests. */
  async detail(id: number, viewer: AuthUser): Promise<SessionDetailDto> {
    const row = await this.find(id, viewer);
    const [base, events, requests, lessonReport] = await Promise.all([
      this.presenter.one(row, viewer),
      this.prisma.sessionEvent.findMany({
        where: { sessionId: id },
        include: { actor: { select: { id: true, name: true } } },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.sessionRequest.findMany({
        where: { sessionId: id },
        include: { requestedBy: { select: { id: true, name: true } } },
        orderBy: { id: 'asc' },
      }),
      this.reports.forSession(row, viewer),
    ]);
    // P0-4 (docs/39 ISO-1, B118): parents and teachers see the class's own story — an allow-list
    // of events with no staff notes, reasons or overrides, and staff by role only, never by name.
    const portal = isParentViewer(viewer) || isTeacherViewer(viewer);
    const mine = (userId: number | null) => userId !== null && userId === viewer.id;
    return {
      ...base,
      events: events
        .filter((e) => !portal || PORTAL_EVENT_TYPES.has(e.type))
        .map((e) => {
          const raw = (e.payload as Record<string, unknown> | null) ?? null;
          const own = mine(e.actorUserId);
          return {
            id: e.id,
            type: e.type,
            fromStage: e.fromStage,
            toStage: e.toStage,
            actor: e.actorUserId
              ? portal && !own
                ? { id: null, name: null, role: e.actorRole }
                : { id: e.actorUserId, name: e.actor?.name ?? '', role: e.actorRole }
              : null,
            payload: portal && raw ? portalPayload(raw) : raw,
            occurredAt: isoZ(e.occurredAt)!,
          };
        }),
      lessonReport,
      requests: requests.map((r) => {
        const own = mine(r.requestedById);
        const hide = portal && !own;
        return {
          id: r.id,
          type: r.type,
          status: r.status,
          reason: hide ? '' : r.reason,
          requestedBy: hide
            ? { id: null, name: null, role: r.requesterRole }
            : { id: r.requestedById, name: r.requestedBy.name, role: r.requesterRole },
          proposedStartsAt: isoZ(r.proposedStartsAt),
          decidedAt: isoZ(r.decidedAt),
          decisionNote: hide ? null : r.decisionNote,
          resultSessionId: r.resultSessionId,
          createdAt: isoZ(r.createdAt)!,
        };
      }),
    };
  }

  /**
   * The board body without `serverTime`, and its weak ETag (computed before `serverTime` is added,
   * so an unchanged board answers 304).
   */
  async board(
    q: { date?: string; tz?: string; since?: string },
    viewer: AuthUser,
  ): Promise<{ body: Omit<BoardDto, 'serverTime'>; etag: string }> {
    const zone = q.tz ?? (await this.viewerZone(viewer));
    const date = q.date ?? localDate(this.clock.nowMs(), zone);
    const since = parseCursor(q.since);
    const scope = await viewerScope(this.prisma, viewer);
    const day: Prisma.ClassSessionWhereInput = {
      AND: [
        sessionScopeWhere(scope),
        {
          startsAt: {
            gte: new Date(startOfLocalDay(date, zone)),
            lt: new Date(startOfLocalDay(addDays(date, 1), zone)),
          },
        },
      ],
    };
    const orderBy = [{ startsAt: 'asc' as const }, { id: 'asc' as const }];
    const all = await this.prisma.classSession.findMany({
      where: { AND: [day, { deletedAt: null }] },
      include: sessionInclude,
      orderBy,
    });
    let rows = all;
    if (since !== null) {
      // changed rows (removed ones too) + rows around "now", whose time-based flags move
      const now = this.clock.nowMs();
      rows = await this.prisma.classSession.findMany({
        where: {
          AND: [
            day,
            {
              OR: [
                { updatedAt: { gt: new Date(since) } },
                {
                  startsAt: {
                    gte: new Date(now - 2 * 3_600_000),
                    lte: new Date(now + 15 * 60_000),
                  },
                },
              ],
            },
          ],
        },
        include: sessionInclude,
        orderBy,
      });
    }
    const presentedAll = await this.presenter.many(all, viewer);
    const sessions = since === null ? presentedAll : await this.presenter.many(rows, viewer);
    const body = {
      counters: counters(presentedAll),
      sessions,
      cursor: this.cursor(rows, q.since ?? null),
      generator: await this.generator.health(),
    };
    const etag = `W/"${createHash('md5').update(JSON.stringify(body)).digest('hex')}"`;
    return { body, etag };
  }

  private async viewerZone(viewer: AuthUser): Promise<string> {
    return isValidZone(viewer.timezone)
      ? viewer.timezone
      : (await this.settings.all())['academy.timezone'];
  }

  /**
   * Cursor = the newest `updatedAt` seen (seconds), never the current second (a row written later
   * in that second would be missed by the strict `>` of the next poll). Clients upsert by id.
   */
  private cursor(rows: Array<{ updatedAt: Date }>, previous: string | null): string | null {
    const nowSec = Math.floor(this.clock.nowMs() / 1000);
    const max = rows.length
      ? Math.max(...rows.map((r) => Math.floor(r.updatedAt.getTime() / 1000)))
      : null;
    const capped = max !== null ? Math.min(max, nowSec - 1) : null;
    const prev = previous ? parseCursor(previous) : null;
    const best = Math.max(capped ?? 0, prev !== null ? prev / 1000 : 0);
    return best > 0 ? Buffer.from(String(best)).toString('base64') : previous;
  }
}

/** Milliseconds of a cursor, or null. */
function parseCursor(cursor: string | undefined | null): number | null {
  if (!cursor) return null;
  const raw = Buffer.from(cursor, 'base64').toString();
  return /^\d{1,12}$/.test(raw) ? Number(raw) * 1000 : null;
}

/** The old dashboard's counters (K1), from the full day's rows. */
export function counters(sessions: SessionDto[]): BoardDto['counters'] {
  const c = Object.fromEntries(BOARD_COUNTERS.map((k) => [k, 0])) as BoardDto['counters'];
  const inc = (k: keyof BoardDto['counters']) => (c[k] += 1);
  for (const s of sessions) {
    const moved = s.stage === 'moved_out';
    if (!moved) inc('total');
    const byStage: Partial<Record<string, keyof BoardDto['counters']>> = {
      taken: 'taken',
      scheduled: 'remaining',
      activated: 'running',
      in_progress: 'running',
      absent: 'absent',
      leave: 'leave',
      declined: 'declined',
      ended: 'ended',
    };
    const key = byStage[s.stage];
    if (key) inc(key);
    if (
      s.stage === 'cancelled' &&
      (s.stageReason === 'family_suspended' || s.stageReason === 'family_on_leave')
    ) {
      inc('suspended');
    }
    if (s.stage === 'cancelled' && s.stageReason === 'holiday') inc('holiday');
    if (!moved) {
      if (s.kind === 'trial') inc('trial');
      if (s.kind === 'advance') inc('advance');
      if (s.kind === 'rescheduled') inc('rescheduled');
      if (s.kind === 'extra') inc('extra');
    }
    for (const code of [
      'late',
      'needs_entry',
      'teacher_unavailable',
      'zoom_failed',
      'needs_review',
    ] as const) {
      if (s.attention.includes(code)) inc(code);
    }
    c.pending_requests += s.pendingRequests.length;
  }
  return c;
}
