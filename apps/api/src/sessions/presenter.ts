import { Injectable } from '@nestjs/common';
import type { SessionDto } from '@qarabic/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import type { Prisma, TeacherBlock } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { blockPattern, zoneOr } from '../schedule/conflicts.js';
import {
  Interval,
  isDstAdjusted,
  isoZ,
  MINUTE,
  OffsetProbe,
  fromDbDate,
  HOUR,
} from '../schedule/time.js';
import { SettingsService, type SettingsMap } from '../settings/settings.service.js';
import {
  Actor,
  type GuardContext,
  type LastStageEvent,
  reportEditableUntil,
  SessionStateMachine,
} from './state-machine.js';

/** Relations a class payload needs (Laravel `SessionResource::relations()`). */
export const sessionInclude = {
  student: {
    select: { id: true, name: true, familyId: true, family: { select: { timezone: true } } },
  },
  teacher: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      timezone: true,
      altPhone: true,
      user: { select: { phone: true } },
    },
  },
  course: { select: { id: true, nameAr: true, nameEn: true } },
  slot: { select: { localStartTime: true, timezone: true } },
  requests: {
    where: { status: 'pending' },
    select: { id: true, type: true },
    orderBy: { id: 'asc' },
  },
  report: { select: { id: true, submittedAt: true } },
} satisfies Prisma.ClassSessionInclude;

export type SessionRow = Prisma.ClassSessionGetPayload<{ include: typeof sessionInclude }>;

const RUNNING = ['activated', 'in_progress'] as const;
const UNDOABLE = ['absent', 'declined', 'leave', 'taken'];

export const teacherName = (t: { firstName: string; lastName: string | null }) =>
  [t.firstName, t.lastName].filter(Boolean).join(' ');

/**
 * Attention codes of a class (docs/14 §6.2, §8.3), computed for "now": late, late_activation,
 * report_missing, needs_entry, teacher_unavailable, zoom_failed, needs_review, pending_request,
 * dst_adjusted. Port of Laravel `Attention`.
 */
export function attentionFor(
  s: SessionRow,
  now: number,
  st: SettingsMap,
  blocks: TeacherBlock[],
): string[] {
  const codes: string[] = [];
  const starts = s.startsAt.getTime();
  const ends = s.endsAt.getTime();
  const late = st['sessions.late_teacher_min'] * MINUTE;
  if (s.stage === 'scheduled' && now > starts + late && now <= ends) codes.push('late');
  if (s.activatedAt && s.activatedAt.getTime() > starts + late) codes.push('late_activation');
  if (
    (s.stage === 'ended' || s.stage === 'taken') &&
    !s.report &&
    now > (s.endedAt ?? s.endsAt).getTime() + st['sessions.report_due_hours'] * HOUR
  ) {
    codes.push('report_missing');
  }
  if (
    (s.stage === 'scheduled' || s.stage === 'activated' || s.stage === 'in_progress') &&
    now > ends + st['sessions.activation_window_after_min'] * MINUTE
  ) {
    codes.push('needs_entry');
  }
  if (
    s.stage === 'scheduled' &&
    now < ends &&
    teacherUnavailable(s, blocks, st['academy.timezone'])
  ) {
    codes.push('teacher_unavailable');
  }
  if (s.zoomStatus === 'failed') codes.push('zoom_failed');
  if (s.needsReview) codes.push('needs_review');
  if (s.requests.length > 0) codes.push('pending_request');
  if (
    s.scheduleSlotId &&
    s.slot &&
    s.occurrenceDate &&
    isDstAdjusted(fromDbDate(s.occurrenceDate), s.slot.localStartTime, s.slot.timezone)
  ) {
    codes.push('dst_adjusted');
  }
  return codes;
}

function teacherUnavailable(s: SessionRow, blocks: TeacherBlock[], academy: string): boolean {
  const interval = new Interval(s.startsAt.getTime(), s.endsAt.getTime());
  return blocks.some((b) =>
    b.kind === 'one_off'
      ? !!b.startsAt &&
        !!b.endsAt &&
        interval.overlaps(new Interval(b.startsAt.getTime(), b.endsAt.getTime()))
      : OffsetProbe.overlapsInterval(blockPattern(b, academy), interval) !== null,
  );
}

/**
 * Builds class payloads (docs/14 §8.1, Laravel `SessionResource`) for a viewer, with the batch
 * reads the guards need (running classes, last marks, teacher blocks) done once per list.
 * Never exposes a meeting URL.
 */
@Injectable()
export class SessionPresenter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly machine: SessionStateMachine,
  ) {}

  async one(row: SessionRow, viewer: AuthUser | null): Promise<SessionDto> {
    return (await this.many([row], viewer))[0]!;
  }

  async many(rows: SessionRow[], viewer: AuthUser | null): Promise<SessionDto[]> {
    if (!rows.length) return [];
    const st = await this.settings.all();
    const now = this.clock.nowMs();
    const actor = viewer ? await Actor.of(this.prisma, viewer) : null;
    const teacherIds = [...new Set(rows.map((r) => r.teacherId))];

    const [running, blocks, marks] = await Promise.all([
      this.prisma.classSession.findMany({
        where: { teacherId: { in: teacherIds }, deletedAt: null, stage: { in: [...RUNNING] } },
        select: { id: true, teacherId: true },
      }),
      this.prisma.teacherBlock.findMany({ where: { teacherId: { in: teacherIds } } }),
      this.prisma.sessionEvent.findMany({
        where: {
          sessionId: { in: rows.filter((r) => UNDOABLE.includes(r.stage)).map((r) => r.id) },
          toStage: { not: null },
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        select: {
          sessionId: true,
          fromStage: true,
          toStage: true,
          actorUserId: true,
          occurredAt: true,
        },
      }),
    ]);
    const lastMark = new Map<number, LastStageEvent>();
    for (const m of marks) if (!lastMark.has(m.sessionId)) lastMark.set(m.sessionId, m);

    const out: SessionDto[] = [];
    for (const s of rows) {
      const ctx: GuardContext = {
        now,
        settings: st,
        teacherRunsAnother: () =>
          Promise.resolve(running.some((r) => r.teacherId === s.teacherId && r.id !== s.id)),
        lastStageEvent: () => Promise.resolve(lastMark.get(s.id) ?? null),
      };
      const deleted = s.deletedAt !== null;
      const live = actor && !deleted;
      out.push(
        this.toDto(s, viewer, st, now, {
          attention: deleted
            ? ['deleted']
            : attentionFor(
                s,
                now,
                st,
                blocks.filter((b) => b.teacherId === s.teacherId),
              ),
          allowedActions: live ? await this.machine.allowedActions(s, actor, ctx) : [],
          upcomingActions: live ? this.machine.upcomingActions(s, actor, ctx) : [],
        }),
      );
    }
    return out;
  }

  private toDto(
    s: SessionRow,
    viewer: AuthUser | null,
    st: SettingsMap,
    now: number,
    computed: Pick<SessionDto, 'attention' | 'allowedActions' | 'upcomingActions'>,
  ): SessionDto {
    const academy = st['academy.timezone'];
    const manages = viewer === null || viewer.permissions.has('sessions.manage');
    const starts = s.startsAt.getTime();
    const ends = s.endsAt.getTime();
    const joinAvailable =
      (s.zoomStatus === 'ready' || s.zoomStatus === 'external') &&
      ['scheduled', 'activated', 'in_progress'].includes(s.stage) &&
      now >= starts - 60 * MINUTE &&
      now <= ends;
    return {
      id: s.id,
      kind: s.kind,
      stage: s.deletedAt ? 'cancelled' : s.stage,
      stageReason: s.stageReason,
      startsAt: isoZ(s.startsAt)!,
      endsAt: isoZ(s.endsAt)!,
      durationMinutes: s.durationMinutes,
      occurrenceDate: s.occurrenceDate ? fromDbDate(s.occurrenceDate) : null,
      source: s.source,
      isDetached: s.isDetached,
      student: {
        id: s.student.id,
        name: s.student.name,
        familyId: s.student.familyId,
        timezone: zoneOr(s.student.family.timezone, academy),
      },
      teacher: {
        id: s.teacher.id,
        name: teacherName(s.teacher),
        timezone: zoneOr(s.teacher.timezone, academy),
        ...(viewer?.permissions.has('sessions.manage')
          ? { phone: s.teacher.user.phone ?? s.teacher.altPhone ?? null }
          : {}),
      },
      course: s.course ?? { id: 0, nameAr: '—', nameEn: '—' },
      enrollmentId: s.enrollmentId,
      scheduleSlotId: s.scheduleSlotId,
      originSessionId: s.originSessionId,
      times: {
        activatedAt: isoZ(s.activatedAt),
        startedAt: isoZ(s.startedAt),
        endedAt: isoZ(s.endedAt),
        markedAt: isoZ(s.markedAt),
      },
      latenessMinutes:
        s.activatedAt && s.activatedAt.getTime() > starts
          ? Math.floor((s.activatedAt.getTime() - starts) / MINUTE)
          : 0,
      zoom: { status: s.zoomStatus, joinAvailable },
      // P0-4: join evidence and the review flag are for staff who manage classes.
      evidence: manages
        ? {
            actualStartedAt: isoZ(s.actualStartedAt),
            teacherJoinedAt: isoZ(s.teacherJoinedAt),
            studentJoinedAt: isoZ(s.studentJoinedAt),
          }
        : { actualStartedAt: null, teacherJoinedAt: null, studentJoinedAt: null },
      report: { submitted: s.report !== null, editableUntil: isoZ(reportEditableUntil(s, st)) },
      ...(viewer?.permissions.has('payroll.view') || viewer?.permissions.has('sessions.manage')
        ? {
            pay: {
              hours: s.payHours?.toFixed(2) ?? null,
              ruleKey: s.payRuleKey,
              billable: s.billable,
            },
          }
        : {}),
      attention: computed.attention,
      pendingRequests: s.requests.map((r) => ({ id: r.id, type: r.type })),
      allowedActions: computed.allowedActions,
      upcomingActions: computed.upcomingActions,
      needsReview: manages ? s.needsReview : false,
      reviewReason: manages ? s.reviewReason : null,
      lockVersion: s.lockVersion,
      updatedAt: isoZ(s.updatedAt)!,
    };
  }
}
