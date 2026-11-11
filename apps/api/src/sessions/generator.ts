import { Injectable, Logger } from '@nestjs/common';
import type { SessionStage } from '@qarabic/shared';
import { Clock } from '../common/clock.js';
import type { Enrollment, Prisma, ScheduleSlot } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { holidayOn } from '../schedule/conflicts.js';
import { LIVE_ENROLLMENT } from '../schedule/scope.js';
import {
  addDays,
  DAY,
  fromDbDate,
  isoWeekday,
  isoZ,
  localDate,
  maxDate,
  minDate,
  toDbDate,
  toUtc,
} from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { teacherName } from './presenter.js';

export interface GenerateOptions {
  /** First / last local date (each slot's zone). Explicit dates may backfill the past. */
  from?: string;
  to?: string;
  enrollmentId?: number;
  teacherId?: number;
  dryRun?: boolean;
}

export interface GeneratePreview {
  startsAt: string;
  student: { id: number; name: string | null };
  teacher: { id: number; name: string | null };
  course: { id: number; name: string | null };
  stage: string;
  stageReason: string | null;
}

export interface GenerateResult {
  created: number[];
  toCreate: GeneratePreview[];
  skipped: number;
  cancelledByRule: number;
}

export const LAST_SUCCESS_KEY = 'sessions.generator.last_success_at';
export const STALE_AFTER_HOURS = 2;
/** `pg_advisory_xact_lock` key of a generator run (one run at a time across processes). */
const LOCK_KEY = 42_002;

const slotInclude = {
  enrollment: {
    include: {
      student: { select: { name: true } },
      course: { select: { nameEn: true } },
    },
  },
  teacher: { select: { firstName: true, lastName: true } },
} satisfies Prisma.ScheduleSlotInclude;
type SlotRow = Prisma.ScheduleSlotGetPayload<{ include: typeof slotInclude }>;

/**
 * Idempotent class generator (D40, docs/14 §4.2), port of Laravel `SessionGenerator`. Never
 * deletes or edits classes; the unique key (schedule_slot_id, occurrence_date) makes repeated or
 * racing runs no-ops. Holidays and paused enrollments produce `cancelled` rows on purpose (board
 * counters, pay). Each slot is expanded in its own zone, so DST never moves a class.
 */
@Injectable()
export class SessionGenerator {
  private readonly logger = new Logger(SessionGenerator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  async run(options: GenerateOptions = {}): Promise<GenerateResult> {
    const st = await this.settings.all();
    const dry = !!options.dryRun;
    const explicit = options.from !== undefined;
    const now = this.clock.nowMs();
    const horizon = st['sessions.horizon_days'];
    const academy = st['academy.timezone'];
    const result: GenerateResult = { created: [], toCreate: [], skipped: 0, cancelledByRule: 0 };
    const holidays = new Map<string, boolean>();
    const isHoliday = async (instant: number) => {
      const day = localDate(instant, academy);
      if (!holidays.has(day))
        holidays.set(day, (await holidayOn(this.prisma, instant, academy)) !== null);
      return holidays.get(day)!;
    };

    let cursor = 0;
    for (;;) {
      const chunk = await this.prisma.scheduleSlot.findMany({
        where: {
          id: { gt: cursor },
          enrollment: LIVE_ENROLLMENT,
          ...(options.enrollmentId ? { enrollmentId: options.enrollmentId } : {}),
          ...(options.teacherId ? { teacherId: options.teacherId } : {}),
        },
        include: slotInclude,
        orderBy: { id: 'asc' },
        take: 500,
      });
      if (!chunk.length) break;
      cursor = chunk[chunk.length - 1]!.id;

      const existing = await this.existingKeys(
        chunk.map((s) => s.id),
        now,
      );
      const rows: Prisma.ClassSessionCreateManyInput[] = [];
      const previews: GeneratePreview[] = [];
      for (const slot of chunk) {
        const today = localDate(now, slot.timezone);
        const from = options.from ?? today;
        const to = options.to ?? addDays(today, horizon);
        for (const date of this.dates(slot, slot.enrollment, from, to)) {
          const startsAt = toUtc(date, slot.localStartTime, slot.timezone);
          if (!explicit && startsAt < now - 3_600_000) continue; // no silent backfill
          if (existing.has(`${slot.id}|${date}`)) {
            result.skipped += 1;
            continue;
          }
          const [stage, reason] = await this.desiredState(slot.enrollment, startsAt, isHoliday);
          if (stage === 'cancelled') result.cancelledByRule += 1;
          rows.push(this.row(slot, date, startsAt, stage, reason, now));
          previews.push(preview(slot, startsAt, stage, reason));
        }
      }

      if (dry) {
        result.toCreate.push(...previews);
        continue;
      }
      result.created.push(...(await this.insert(rows)));
    }

    if (!dry && !options.enrollmentId && !options.teacherId) await this.recordSuccess(result);
    return result;
  }

  /**
   * Desired stage of an occurrence (§4.2): paused enrollment → cancelled/<paused reason>,
   * academy-local holiday → cancelled/holiday, else scheduled.
   */
  async desiredState(
    enrollment: Pick<Enrollment, 'status' | 'pausedReason'>,
    startsAt: number,
    isHoliday: (instant: number) => Promise<boolean>,
  ): Promise<[SessionStage, string | null]> {
    if (enrollment.status === 'paused') return ['cancelled', enrollment.pausedReason || 'admin'];
    if (await isHoliday(startsAt)) return ['cancelled', 'holiday'];
    return ['scheduled', null];
  }

  /** Local dates in [from, to] (slot zone) this slot should produce. */
  dates(
    slot: Pick<ScheduleSlot, 'weekday' | 'validFrom' | 'validTo'>,
    enrollment: Pick<Enrollment, 'startsOn' | 'endsOn'>,
    from: string,
    to: string,
  ): string[] {
    const lower = maxDate(from, fromDbDate(slot.validFrom), fromDbDate(enrollment.startsOn));
    const upper = minDate(
      to,
      slot.validTo ? fromDbDate(slot.validTo) : null,
      enrollment.endsOn ? fromDbDate(enrollment.endsOn) : null,
    )!;
    if (lower > upper) return [];
    const out: string[] = [];
    const offset = (slot.weekday - isoWeekday(lower) + 7) % 7;
    for (let d = addDays(lower, offset); d <= upper; d = addDays(d, 7)) out.push(d);
    return out;
  }

  /** `{ lastSuccessAt, stale }` for the board and health checks. */
  async health(): Promise<{ lastSuccessAt: string | null; stale: boolean }> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: LAST_SUCCESS_KEY } });
    const at = (row?.value as { at?: string } | null)?.at ?? null;
    return {
      lastSuccessAt: at,
      stale:
        at === null || new Date(at).getTime() < this.clock.nowMs() - STALE_AFTER_HOURS * 3_600_000,
    };
  }

  /**
   * Runs `fn` while holding the generator lock (a transaction-scoped advisory lock kept open for
   * the run). Returns null when another run holds it after `waitMs`.
   */
  async withLock<T>(fn: () => Promise<T>, waitMs = 0): Promise<T | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const deadline = Date.now() + waitMs;
        for (;;) {
          const [row] = await tx.$queryRaw<Array<{ locked: boolean }>>`
            SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked`;
          if (row?.locked) return fn();
          if (Date.now() >= deadline) return null;
          await new Promise((r) => setTimeout(r, 250));
        }
      },
      { timeout: 10 * 60_000, maxWait: 10_000 },
    );
  }

  // ------------------------------------------------------------------ internals

  /** "slot|date" keys that already exist, removed (soft-deleted) rows included. */
  private async existingKeys(slotIds: number[], now: number): Promise<Set<string>> {
    const rows = await this.prisma.classSession.findMany({
      where: {
        scheduleSlotId: { in: slotIds },
        occurrenceDate: { gte: toDbDate(localDate(now - 400 * DAY, 'UTC')) },
      },
      select: { scheduleSlotId: true, occurrenceDate: true },
    });
    return new Set(rows.map((r) => `${r.scheduleSlotId}|${fromDbDate(r.occurrenceDate!)}`));
  }

  private row(
    slot: SlotRow,
    date: string,
    startsAt: number,
    stage: SessionStage,
    reason: string | null,
    now: number,
  ): Prisma.ClassSessionCreateManyInput {
    const e = slot.enrollment;
    const external = e.meetingMode === 'external';
    const terminal = stage === 'cancelled';
    return {
      enrollmentId: e.id,
      scheduleSlotId: slot.id,
      occurrenceDate: toDbDate(date),
      teacherId: slot.teacherId,
      studentId: e.studentId,
      courseId: e.courseId,
      startsAt: new Date(startsAt),
      endsAt: new Date(startsAt + slot.durationMinutes * 60_000),
      durationMinutes: slot.durationMinutes,
      kind: e.kind,
      stage,
      stageReason: reason,
      source: 'generated',
      zoomStatus: external ? 'external' : 'none',
      zoomJoinUrl: external ? e.externalMeetingUrl : null,
      markedAt: terminal ? new Date(now) : null,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
  }

  /** Insert-or-ignore in batches, then a `generated` event for each new row (same transaction). */
  private async insert(rows: Prisma.ClassSessionCreateManyInput[]): Promise<number[]> {
    const created: number[] = [];
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200);
      const ids = await this.prisma.$transaction(async (tx) => {
        const inserted = await tx.classSession.createManyAndReturn({
          data: batch,
          skipDuplicates: true,
          select: { id: true, stage: true },
        });
        if (inserted.length) {
          await tx.sessionEvent.createMany({
            data: inserted.map((r) => ({
              sessionId: r.id,
              type: 'generated',
              toStage: r.stage,
              occurredAt: this.clock.now(),
            })),
          });
        }
        return inserted.map((r) => r.id);
      });
      created.push(...ids);
    }
    return created;
  }

  private async recordSuccess(result: GenerateResult): Promise<void> {
    const value = {
      at: isoZ(this.clock.nowMs()),
      created: result.created.length,
      skipped: result.skipped,
      cancelledByRule: result.cancelledByRule,
    };
    await this.prisma.appSetting.upsert({
      where: { key: LAST_SUCCESS_KEY },
      create: { key: LAST_SUCCESS_KEY, value },
      update: { value },
    });
    this.logger.log(
      `Classes generated: ${value.created} new, ${value.skipped} existing, ${value.cancelledByRule} cancelled by rule.`,
    );
  }
}

function preview(
  slot: SlotRow,
  startsAt: number,
  stage: string,
  stageReason: string | null,
): GeneratePreview {
  return {
    startsAt: isoZ(startsAt)!,
    student: { id: slot.enrollment.studentId, name: slot.enrollment.student.name },
    teacher: { id: slot.teacherId, name: teacherName(slot.teacher) },
    course: { id: slot.enrollment.courseId, name: slot.enrollment.course.nameEn },
    stage,
    stageReason,
  };
}
