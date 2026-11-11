import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { holidayOn } from '../schedule/conflicts.js';
import { addDays, fromDbDate, localDate, toUtc } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { recordEvent } from './events.js';
import { SessionGenerator } from './generator.js';
import { ZoomMeetings } from './zoom.js';

/** What changed (Laravel `ScheduleChanged` event scope). Dates are academy-local. */
export interface ResyncScope {
  enrollmentId?: number;
  teacherId?: number;
  from?: string;
  to?: string;
}

/** Events a person never writes: a class with only these is still "untouched". */
const SYSTEM_EVENTS = [
  'generated',
  'cancelled',
  'reverted',
  'teacher_changed',
  'zoom_created',
  'zoom_updated',
  'zoom_failed',
  'zoom_meeting_started',
  'zoom_meeting_ended',
  'participant_joined',
  'participant_left',
];
const SYSTEM_CANCEL = [
  'holiday',
  'family_suspended',
  'family_on_leave',
  'enrollment_ended',
  'schedule_changed',
];

/**
 * Re-syncs future generated classes after a schedule change (docs/14 §4.4), then fills gaps.
 * Port of the Laravel `ResyncFutureSessions` job, run in-process right after the change commits
 * (no queue needed at N2 volumes; the hourly generator heals any gap). Only untouched rows change:
 * source=generated, not detached, scheduled or cancelled for a system reason, more than 30 minutes
 * ahead, and no event other than system ones.
 */
@Injectable()
export class ResyncService {
  private readonly logger = new Logger(ResyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly generator: SessionGenerator,
    private readonly zoom: ZoomMeetings,
  ) {}

  /** Never throws: the change itself is saved; a failed re-sync is logged and healed hourly. */
  async run(scope: ResyncScope): Promise<void> {
    try {
      await this.resync(scope);
    } catch (error) {
      this.logger.error(`Re-sync failed for ${JSON.stringify(scope)}`, error as Error);
    }
  }

  private async resync(scope: ResyncScope): Promise<void> {
    const st = await this.settings.all();
    const academy = st['academy.timezone'];
    let from = this.clock.nowMs() + 30 * 60_000;
    if (scope.from) from = Math.max(from, toUtc(scope.from, '00:00', academy));

    const candidates = await this.prisma.classSession.findMany({
      where: {
        source: 'generated',
        isDetached: false,
        deletedAt: null,
        startsAt: {
          gt: new Date(from),
          ...(scope.to ? { lt: new Date(toUtc(addDays(scope.to, 1), '00:00', academy)) } : {}),
        },
        ...(scope.enrollmentId ? { enrollmentId: scope.enrollmentId } : {}),
        ...(scope.teacherId
          ? { OR: [{ teacherId: scope.teacherId }, { slot: { teacherId: scope.teacherId } }] }
          : {}),
        AND: [
          {
            OR: [
              { stage: 'scheduled' },
              { stage: 'cancelled', stageReason: { in: SYSTEM_CANCEL } },
            ],
          },
          {
            events: {
              none: { OR: [{ actorUserId: { not: null } }, { type: { notIn: SYSTEM_EVENTS } }] },
            },
          },
        ],
      },
      include: { slot: true, enrollment: true },
    });

    const holidays = new Map<string, boolean>();
    const isHoliday = async (instant: number) => {
      const day = localDate(instant, academy);
      if (!holidays.has(day))
        holidays.set(day, (await holidayOn(this.prisma, instant, academy)) !== null);
      return holidays.get(day)!;
    };

    for (const s of candidates) {
      const date = s.occurrenceDate ? fromDbDate(s.occurrenceDate) : null;
      const wanted =
        !!s.slot &&
        !!s.enrollment &&
        !!date &&
        s.enrollment.status !== 'ended' &&
        this.generator.dates(s.slot, s.enrollment, date, date).includes(date);
      const now = this.clock.now();

      if (!wanted) {
        await this.prisma.$transaction(async (tx) => {
          await recordEvent(tx, this.clock, s.id, 'cancelled', {
            from: s.stage,
            payload: { resync: true, deleted: true },
          });
          await tx.classSession.update({
            where: { id: s.id },
            data: { deletedAt: now, updatedAt: now, lockVersion: { increment: 1 } },
          });
        });
        await this.zoom.delete(s.id);
        continue;
      }

      const [stage, reason] = await this.generator.desiredState(
        s.enrollment!,
        s.startsAt.getTime(),
        isHoliday,
      );
      const teacherChanged = s.teacherId !== s.slot!.teacherId;
      const stageChanged = stage !== s.stage || reason !== s.stageReason;
      if (!teacherChanged && !stageChanged) continue;

      await this.prisma.$transaction(async (tx) => {
        if (teacherChanged) {
          await recordEvent(tx, this.clock, s.id, 'teacher_changed', {
            payload: { old: s.teacherId, new: s.slot!.teacherId, resync: true },
          });
        }
        if (stageChanged) {
          await recordEvent(
            tx,
            this.clock,
            s.id,
            stage === 'cancelled' ? 'cancelled' : 'reverted',
            {
              from: s.stage,
              to: stage,
              payload: { resync: true, stageReason: reason },
            },
          );
        }
        await tx.classSession.update({
          where: { id: s.id },
          data: {
            teacherId: s.slot!.teacherId,
            stage,
            stageReason: reason,
            markedAt: stage === 'cancelled' ? now : null,
            markedById: null,
            lockVersion: { increment: 1 },
            updatedAt: now,
          },
        });
      });
      if (teacherChanged) await this.zoom.update(s.id);
    }

    await this.generator.run({
      ...(scope.enrollmentId ? { enrollmentId: scope.enrollmentId } : {}),
      ...(scope.teacherId ? { teacherId: scope.teacherId } : {}),
    });
  }
}
