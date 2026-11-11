import { HttpStatus, Injectable } from '@nestjs/common';
import {
  CONFLICT_LABELS,
  type ConflictCode,
  type ConflictDto,
  type ConflictResultDto,
  OCCUPYING_STAGES,
} from '@qarabic/shared';
import { Clock } from '../common/clock.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SettingsMap } from '../settings/settings.service.js';
import { fail } from '../sessions/errors.js';
import { LIVE_ENROLLMENT } from './scope.js';
import {
  addDays,
  DAY,
  fromDbDate,
  Interval,
  isValidZone,
  isoWeekday,
  localDate,
  maxDate,
  OffsetProbe,
  startOfLocalDay,
  toUtc,
  WeeklyPattern,
} from './time.js';

type With = ConflictDto['with'];

/** One hard conflict or soft warning (docs/14 §5, §8.1). */
export interface Conflict {
  code: ConflictCode;
  severity: 'hard' | 'soft';
  with: With;
  firstDate: string | null;
  params?: Record<string, unknown>;
}

const hard = (code: ConflictCode, w: With = null, firstDate: string | null = null): Conflict => ({
  code,
  severity: 'hard',
  with: w,
  firstDate,
});
const soft = (code: ConflictCode, w: With = null, firstDate: string | null = null): Conflict => ({
  code,
  severity: 'soft',
  with: w,
  firstDate,
});

function toDto(c: Conflict): ConflictDto {
  const parts = [CONFLICT_LABELS[c.code].en, c.with?.label, c.firstDate].filter(Boolean);
  return {
    code: c.code,
    severity: c.severity,
    message: parts.join(' — '),
    with: c.with,
    firstDate: c.firstDate,
    ...(c.params ? { params: c.params } : {}),
  };
}

export class ConflictResult {
  conflicts: Conflict[] = [];
  warnings: Conflict[] = [];

  add(c: Conflict): void {
    const list = c.severity === 'hard' ? this.conflicts : this.warnings;
    const same = list.some(
      (e) => e.code === c.code && JSON.stringify(e.with) === JSON.stringify(c.with),
    );
    if (!same) list.push(c);
  }

  merge(other: ConflictResult): this {
    for (const c of [...other.conflicts, ...other.warnings]) this.add(c);
    return this;
  }

  hasHard(): boolean {
    return this.conflicts.length > 0;
  }

  /**
   * 409 `schedule_conflict` on any hard conflict, then 422 `warnings_not_acknowledged` while a
   * soft warning was not acknowledged (docs/14 §5.2). The lists travel in `data`.
   */
  assertPasses(acknowledged: readonly string[] = []): void {
    if (this.hasHard()) {
      throw fail(HttpStatus.CONFLICT, 'schedule_conflict', { data: this.toDto() });
    }
    const open = this.warnings.filter((w) => !acknowledged.includes(w.code));
    if (open.length) {
      throw fail(HttpStatus.UNPROCESSABLE_ENTITY, 'warnings_not_acknowledged', {
        data: { warnings: open.map(toDto) },
      });
    }
  }

  toDto(): ConflictResultDto {
    return { conflicts: this.conflicts.map(toDto), warnings: this.warnings.map(toDto) };
  }
}

/** A single class to be created or moved. */
export interface SessionCandidate {
  teacherId: number;
  studentId: number;
  startsAt: number;
  durationMinutes: number;
  enrollmentId?: number | null;
  excludeSessionId?: number | null;
}

/** A weekly slot to be added, or a new version of one. */
export interface SlotCandidate {
  teacherId: number;
  studentId: number;
  weekday: number;
  localStartTime: string;
  durationMinutes: number;
  timezone: string;
  validFrom: string;
  validTo?: string | null;
  enrollmentId?: number | null;
  excludeSlotIds?: number[];
}

export const slotPattern = (c: SlotCandidate) =>
  new WeeklyPattern(
    c.weekday,
    c.localStartTime,
    c.durationMinutes,
    c.timezone,
    c.validFrom,
    c.validTo ?? null,
  );

const slotInclude = {
  enrollment: {
    select: {
      studentId: true,
      student: { select: { name: true } },
      course: { select: { nameAr: true } },
    },
  },
} satisfies Prisma.ScheduleSlotInclude;
type SlotRow = Prisma.ScheduleSlotGetPayload<{ include: typeof slotInclude }>;

type SlotLike = {
  weekday: number;
  localStartTime: string;
  durationMinutes: number;
  timezone: string;
  validFrom: Date;
  validTo: Date | null;
};

export function patternOf(slot: SlotLike): WeeklyPattern {
  return new WeeklyPattern(
    slot.weekday,
    slot.localStartTime,
    slot.durationMinutes,
    slot.timezone,
    fromDbDate(slot.validFrom),
    slot.validTo ? fromDbDate(slot.validTo) : null,
  );
}

type BlockLike = {
  weekday: number | null;
  localStartTime: string | null;
  durationMinutes: number | null;
  timezone: string | null;
  validFrom: Date | null;
  validTo: Date | null;
};

export function blockPattern(block: BlockLike, academyZone: string): WeeklyPattern {
  return new WeeklyPattern(
    block.weekday ?? 1,
    block.localStartTime ?? '00:00',
    block.durationMinutes ?? 0,
    block.timezone && isValidZone(block.timezone) ? block.timezone : academyZone,
    block.validFrom ? fromDbDate(block.validFrom) : null,
    block.validTo ? fromDbDate(block.validTo) : null,
  );
}

export const zoneOr = (zone: string | null | undefined, fallback: string) =>
  zone && isValidZone(zone) ? zone : fallback;

type WorkHourLike = {
  weekday: number;
  localStartTime: string;
  localEndTime: string;
  timezone: string;
};

/** True when the teacher has no work hours (not set) or the interval fits one window. */
export function insideWorkHours(
  rows: WorkHourLike[],
  interval: Interval,
  teacherZone: string,
  academyZone: string,
): boolean {
  if (!rows.length) return true;
  const day = localDate(interval.start, teacherZone);
  for (const d0 of [addDays(day, -1), day]) {
    for (const row of rows.filter((r) => r.weekday === isoWeekday(d0))) {
      const zone = zoneOr(row.timezone, academyZone);
      for (const d of new Set([localDate(interval.start, zone), d0])) {
        if (isoWeekday(d) !== row.weekday) continue;
        const start = toUtc(d, row.localStartTime, zone);
        let end = toUtc(d, row.localEndTime, zone);
        if (end <= start) end += DAY; // window across midnight
        if (new Interval(start, end).contains(interval)) return true;
      }
    }
  }
  return false;
}

const occupying = { in: [...OCCUPYING_STAGES] } as Prisma.EnumSessionStageFilter;

/**
 * Hard and soft scheduling rules (D44, docs/14 §5). Port of the Laravel `ConflictChecker`.
 *
 * Hard (409, no override): teacher / student overlap with classes and weekly slots, recurring
 * overlap across DST (offset probing), teacher blocks, inactive teacher / enrollment.
 * Soft (acknowledged by code): outside_work_hours, holiday, sibling_overlap, dst_shift,
 * teacher_daily_load, past_time. (`package_mismatch` waits for packages, N6.)
 *
 * Writers call `locked()` so the check and the insert run under row locks on the teacher and the
 * student (docs/14 §5.4).
 */
@Injectable()
export class ConflictChecker {
  static readonly MAX_DAILY_MINUTES = 480;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Runs `write` in a transaction that first locks the teacher and student rows (sorted ids). */
  locked<T>(teacherIds: number[], studentIds: number[], write: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        const teachers = [...new Set(teacherIds.filter((n) => n > 0))].sort((a, b) => a - b);
        const students = [...new Set(studentIds.filter((n) => n > 0))].sort((a, b) => a - b);
        if (teachers.length) {
          await tx.$queryRaw`SELECT id FROM "teachers" WHERE id = ANY(${teachers}) ORDER BY id FOR UPDATE`;
        }
        if (students.length) {
          await tx.$queryRaw`SELECT id FROM "students" WHERE id = ANY(${students}) ORDER BY id FOR UPDATE`;
        }
        return write(tx);
      },
      { timeout: 30_000 },
    );
  }

  // ---------------------------------------------------------------- single classes

  async checkSession(
    db: Tx | PrismaService,
    c: SessionCandidate,
    s: SettingsMap,
  ): Promise<ConflictResult> {
    const result = new ConflictResult();
    const interval = Interval.of(c.startsAt, c.durationMinutes);
    const buffer = s['sessions.teacher_buffer_min'];
    const academy = s['academy.timezone'];
    const teacher = await db.teacher.findUnique({
      where: { id: c.teacherId },
      include: { workHours: true },
    });
    const student = await db.student.findUnique({ where: { id: c.studentId } });

    if (!teacher || teacher.status !== 'active' || teacher.archivedAt) {
      result.add(hard('teacher_inactive', { type: 'teacher', id: c.teacherId }));
    }
    if (c.enrollmentId) {
      const enrollment = await db.enrollment.findUnique({ where: { id: c.enrollmentId } });
      if (!enrollment || enrollment.status !== 'active') {
        result.add(hard('enrollment_inactive', { type: 'enrollment', id: c.enrollmentId }));
      }
    }

    // classes of the teacher / the student
    const around = {
      startsAt: { lt: new Date(interval.end + (buffer + 1) * 60_000) },
      endsAt: { gt: new Date(interval.start - (buffer + 1) * 60_000) },
    };
    const classes = await db.classSession.findMany({
      where: {
        stage: occupying,
        deletedAt: null,
        OR: [{ teacherId: c.teacherId }, { studentId: c.studentId }],
        ...(c.excludeSessionId ? { id: { not: c.excludeSessionId } } : {}),
        ...around,
      },
      include: { student: { select: { name: true } }, course: { select: { nameAr: true } } },
    });
    for (const row of classes) {
      const other = new Interval(row.startsAt.getTime(), row.endsAt.getTime());
      if (row.teacherId === c.teacherId && interval.overlaps(other, buffer)) {
        result.add(hard('teacher_overlap', sessionRef(row)));
      }
      if (row.studentId === c.studentId && interval.overlaps(other)) {
        result.add(hard('student_overlap', sessionRef(row)));
      }
    }

    // weekly slots whose occurrence on that day is not generated yet
    const from = localDate(interval.start - 2 * DAY, 'UTC');
    const to = localDate(interval.end + 2 * DAY, 'UTC');
    for (const slot of await this.slotsOf(db, c.teacherId, c.studentId, from, to)) {
      const sameTeacher = slot.teacherId === c.teacherId;
      const date = OffsetProbe.overlapsInterval(
        patternOf(slot),
        interval,
        sameTeacher ? buffer : 0,
      );
      if (date === null || (await this.generated(db, slot.id, date, c.excludeSessionId))) continue;
      if (sameTeacher) result.add(hard('teacher_overlap', slotRef(slot), date));
      if (slot.enrollment.studentId === c.studentId) {
        result.add(hard('student_overlap', slotRef(slot), date));
      }
    }

    // blocks
    for (const block of await this.blocksOf(db, c.teacherId)) {
      const date =
        block.kind === 'recurring'
          ? OffsetProbe.overlapsInterval(blockPattern(block, academy), interval)
          : block.startsAt &&
              block.endsAt &&
              interval.overlaps(new Interval(block.startsAt.getTime(), block.endsAt.getTime()))
            ? localDate(block.startsAt.getTime(), 'UTC')
            : null;
      if (date !== null) result.add(hard('teacher_blocked', blockRef(block), date));
    }

    // soft
    if (interval.start < this.clock.nowMs()) result.add(soft('past_time'));
    const holiday = await holidayOn(db, interval.start, academy);
    if (holiday) {
      result.add(soft('holiday', { type: 'holiday', id: holiday.id, label: holiday.name }));
    }
    const teacherZone = zoneOr(teacher?.timezone, academy);
    if (!insideWorkHours(teacher?.workHours ?? [], interval, teacherZone, academy)) {
      result.add(soft('outside_work_hours'));
    }
    if (student) {
      const siblings = await db.classSession.findMany({
        where: {
          stage: occupying,
          deletedAt: null,
          student: { familyId: student.familyId, id: { not: student.id } },
          ...around,
        },
        include: { student: { select: { name: true } }, course: { select: { nameAr: true } } },
      });
      for (const row of siblings) {
        if (interval.overlaps(new Interval(row.startsAt.getTime(), row.endsAt.getTime()))) {
          result.add(soft('sibling_overlap', sessionRef(row)));
        }
      }
    }
    const day = localDate(c.startsAt, teacherZone);
    const load = await db.classSession.aggregate({
      _sum: { durationMinutes: true },
      where: {
        stage: occupying,
        deletedAt: null,
        teacherId: c.teacherId,
        ...(c.excludeSessionId ? { id: { not: c.excludeSessionId } } : {}),
        startsAt: {
          gte: new Date(startOfLocalDay(day, teacherZone)),
          lt: new Date(startOfLocalDay(addDays(day, 1), teacherZone)),
        },
      },
    });
    if ((load._sum.durationMinutes ?? 0) + c.durationMinutes > ConflictChecker.MAX_DAILY_MINUTES) {
      result.add(soft('teacher_daily_load'));
    }
    return result;
  }

  // ---------------------------------------------------------------- weekly slots

  async checkSlot(
    db: Tx | PrismaService,
    c: SlotCandidate,
    s: SettingsMap,
  ): Promise<ConflictResult> {
    const result = new ConflictResult();
    const pattern = slotPattern(c);
    const academy = s['academy.timezone'];
    const notBefore = maxDate(c.validFrom, localDate(this.clock.nowMs(), c.timezone));
    const buffer = s['sessions.teacher_buffer_min'];
    const teacher = await db.teacher.findUnique({
      where: { id: c.teacherId },
      include: { workHours: true },
    });
    const student = await db.student.findUnique({ where: { id: c.studentId } });

    if (!teacher || teacher.status !== 'active' || teacher.archivedAt) {
      result.add(hard('teacher_inactive', { type: 'teacher', id: c.teacherId }));
    }
    if (c.validTo && c.validTo < notBefore) return result;

    for (const slot of await this.slotsOf(
      db,
      c.teacherId,
      c.studentId,
      notBefore,
      c.validTo ?? null,
      c.excludeSlotIds,
    )) {
      const sameTeacher = slot.teacherId === c.teacherId;
      const date = OffsetProbe.firstOverlap(
        pattern,
        patternOf(slot),
        sameTeacher ? buffer : 0,
        notBefore,
      );
      if (date === null) continue;
      if (sameTeacher) result.add(hard('teacher_overlap', slotRef(slot), date));
      if (slot.enrollment.studentId === c.studentId) {
        result.add(hard('student_overlap', slotRef(slot), date));
      }
    }

    // one-off (not generated) future classes of the teacher or the student
    const oneOffs = await db.classSession.findMany({
      where: {
        stage: occupying,
        deletedAt: null,
        scheduleSlotId: null,
        startsAt: { gte: this.clock.now() },
        OR: [{ teacherId: c.teacherId }, { studentId: c.studentId }],
      },
      include: { student: { select: { name: true } }, course: { select: { nameAr: true } } },
    });
    for (const row of oneOffs) {
      const sameTeacher = row.teacherId === c.teacherId;
      const date = OffsetProbe.overlapsInterval(
        pattern,
        new Interval(row.startsAt.getTime(), row.endsAt.getTime()),
        sameTeacher ? buffer : 0,
      );
      if (date === null || date < notBefore) continue;
      result.add(hard(sameTeacher ? 'teacher_overlap' : 'student_overlap', sessionRef(row), date));
    }

    for (const block of await this.blocksOf(db, c.teacherId)) {
      const date =
        block.kind === 'recurring'
          ? OffsetProbe.firstOverlap(pattern, blockPattern(block, academy), 0, notBefore)
          : block.startsAt && block.endsAt
            ? OffsetProbe.overlapsInterval(
                pattern,
                new Interval(block.startsAt.getTime(), block.endsAt.getTime()),
              )
            : null;
      if (date !== null && date >= notBefore) {
        result.add(hard('teacher_blocked', blockRef(block), date));
      }
    }

    // soft
    const teacherZone = zoneOr(teacher?.timezone, academy);
    outer: for (const [wFrom, wTo] of OffsetProbe.windows(
      [c.timezone, teacherZone],
      notBefore,
      c.validTo ?? null,
    )) {
      for (const [date, occ] of pattern.occurrencesBetween(wFrom, wTo)) {
        if (
          date >= notBefore &&
          !insideWorkHours(teacher?.workHours ?? [], occ, teacherZone, academy)
        ) {
          result.add(soft('outside_work_hours', null, date));
          break outer;
        }
      }
    }
    if (OffsetProbe.localTimesIn(pattern, teacherZone, notBefore).length > 1) {
      result.add(soft('dst_shift'));
    }
    if (student) {
      const siblingSlots = await db.scheduleSlot.findMany({
        where: {
          enrollment: {
            ...LIVE_ENROLLMENT,
            student: { familyId: student.familyId, id: { not: student.id } },
          },
          ...validBetween(notBefore, c.validTo ?? null),
        },
        include: slotInclude,
      });
      for (const slot of siblingSlots) {
        const date = OffsetProbe.firstOverlap(pattern, patternOf(slot), 0, notBefore);
        if (date) result.add(soft('sibling_overlap', slotRef(slot), date));
      }
    }
    return result;
  }

  // ---------------------------------------------------------------- helpers

  /** Live slots of the teacher or the student valid on some day of [from, to]. */
  private slotsOf(
    db: Tx | PrismaService,
    teacherId: number,
    studentId: number,
    from: string,
    to: string | null,
    exclude: number[] = [],
  ): Promise<SlotRow[]> {
    return db.scheduleSlot.findMany({
      where: {
        enrollment: LIVE_ENROLLMENT,
        OR: [{ teacherId }, { enrollment: { studentId } }],
        ...(exclude.length ? { id: { notIn: exclude } } : {}),
        ...validBetween(from, to),
      },
      include: slotInclude,
    });
  }

  private blocksOf(db: Tx | PrismaService, teacherId: number) {
    return db.teacherBlock.findMany({
      where: {
        teacherId,
        OR: [{ kind: 'recurring' }, { endsAt: { gt: new Date(this.clock.nowMs() - DAY) } }],
      },
    });
  }

  private async generated(
    db: Tx | PrismaService,
    slotId: number,
    date: string,
    excludeSessionId?: number | null,
  ): Promise<boolean> {
    const row = await db.classSession.findFirst({
      where: {
        scheduleSlotId: slotId,
        occurrenceDate: new Date(`${date}T00:00:00Z`),
        deletedAt: null,
        ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
      },
      select: { id: true },
    });
    return row !== null;
  }
}

/** Slots valid on some day of [from, to] (local dates). */
export function validBetween(from: string, to: string | null): Prisma.ScheduleSlotWhereInput {
  return {
    validFrom: { lte: new Date(`${to ?? '9999-12-31'}T00:00:00Z`) },
    OR: [{ validTo: null }, { validTo: { gte: new Date(`${from}T00:00:00Z`) } }],
  };
}

/** The holiday covering the academy-local date of an instant, if any. */
export async function holidayOn(db: Tx | PrismaService, instant: number, academyZone: string) {
  const day = new Date(`${localDate(instant, academyZone)}T00:00:00Z`);
  return db.holiday.findFirst({
    where: {
      date: { lte: day },
      OR: [{ endsOn: null, date: day }, { endsOn: { gte: day } }],
    },
  });
}

function sessionRef(row: {
  id: number;
  startsAt: Date;
  student: { name: string } | null;
  course: { nameAr: string } | null;
}): With {
  return {
    type: 'session',
    id: row.id,
    startsAt: row.startsAt.toISOString().replace('.000Z', 'Z'),
    label: [row.student?.name, row.course?.nameAr].filter(Boolean).join(' — '),
  };
}

function slotRef(slot: SlotRow): With {
  return {
    type: 'slot',
    id: slot.id,
    startsAt: null,
    label: [slot.enrollment.student.name, slot.enrollment.course.nameAr]
      .filter(Boolean)
      .join(' — '),
  };
}

function blockRef(block: { id: number; startsAt: Date | null; reason: string }): With {
  return {
    type: 'block',
    id: block.id,
    startsAt: block.startsAt ? block.startsAt.toISOString().replace('.000Z', 'Z') : null,
    label: block.reason,
  };
}
