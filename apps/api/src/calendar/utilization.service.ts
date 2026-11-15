import { Injectable } from '@nestjs/common';
import type {
  FreeCapacityDto,
  freeCapacityQuerySchema,
  TeacherUtilizationDto,
  UtilizationReportDto,
  utilizationQuerySchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertStaffOrTeacher, forbidden, viewerScope } from '../schedule/scope.js';
import {
  addDays,
  addMonths,
  dateMs,
  DAY,
  fromDbDate,
  isoWeekday,
  localDate,
  toUtc,
} from '../schedule/time.js';
import { teacherName } from '../sessions/presenter.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  expandRecurring,
  expandWorkHours,
  holidaySpan,
  hoursOf,
  merge,
  type Span,
  subtract,
} from './expand.js';

type UtilQuery = z.output<typeof utilizationQuerySchema>;
type FreeQuery = z.output<typeof freeCapacityQuerySchema>;

const HOUR = 3_600_000;
const LONGEST_CLASS_MS = 24 * HOUR;
const MAX_TEACHERS = 300;

const teacherSelect = {
  id: true,
  firstName: true,
  lastName: true,
  timezone: true,
  workHours: {
    select: { weekday: true, localStartTime: true, localEndTime: true, timezone: true },
  },
  blocks: true,
} satisfies Prisma.TeacherSelect;
type TeacherRow = Prisma.TeacherGetPayload<{ select: typeof teacherSelect }>;

interface Numbers {
  availableHours: number;
  bookedHours: number;
  freeHours: number;
  outsideHours: number;
  utilization: number | null;
}

const ratio = (booked: number, available: number) =>
  available > 0 ? Math.round((booked / available) * 10_000) / 10_000 : null;

/**
 * R1 (docs/42 §5, D148): utilization per teacher and the free-capacity grid. Staff with
 * `reports.view`; a teacher only their own numbers (`sessions.conduct`); parents never.
 */
@Injectable()
export class UtilizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  private async teachers(
    q: { teacherIds?: number[]; courseId?: number; gender?: 'male' | 'female'; audience?: string },
    viewer: AuthUser,
  ): Promise<TeacherRow[]> {
    assertStaffOrTeacher(viewer, 'reports.view');
    const scope = await viewerScope(this.prisma, viewer);
    if (scope.kind === 'family') throw forbidden();
    return this.prisma.teacher.findMany({
      where: {
        archivedAt: null,
        status: 'active',
        ...(scope.kind === 'teacher' ? { id: scope.teacherId } : {}),
        ...(q.teacherIds && scope.kind !== 'teacher' ? { id: { in: q.teacherIds } } : {}),
        ...(q.courseId ? { courses: { some: { courseId: q.courseId } } } : {}),
        ...(q.gender ? { gender: q.gender } : {}),
        ...(q.audience ? { audience: { in: [q.audience as 'children' | 'adults', 'both'] } } : {}),
      },
      select: teacherSelect,
      orderBy: [{ firstName: 'asc' }, { id: 'asc' }],
      take: MAX_TEACHERS,
    });
  }

  /** Available spans of each teacher in [start, end): work hours − blocks − holidays. */
  private async available(
    teachers: TeacherRow[],
    start: number,
    end: number,
  ): Promise<Map<number, Span[]>> {
    const academy = await this.settings.get('academy.timezone');
    const firstDay = localDate(start, academy);
    const lastDay = localDate(end, academy);
    const holidays = await this.prisma.holiday.findMany({
      where: {
        date: { lte: new Date(`${lastDay}T00:00:00Z`) },
        OR: [
          { endsOn: { gte: new Date(`${firstDay}T00:00:00Z`) } },
          { endsOn: null, date: { gte: new Date(`${firstDay}T00:00:00Z`) } },
        ],
      },
    });
    const off = holidays.flatMap((h) => {
      const span = holidaySpan(
        fromDbDate(h.date),
        h.endsOn ? fromDbDate(h.endsOn) : null,
        academy,
        start,
        end,
      );
      return span ? [span] : [];
    });
    const out = new Map<number, Span[]>();
    for (const t of teachers) {
      const blocks: Span[] = t.blocks.flatMap((b) => {
        if (b.kind === 'one_off') {
          return b.startsAt && b.endsAt
            ? [{ start: b.startsAt.getTime(), end: b.endsAt.getTime() }]
            : [];
        }
        if (!b.weekday || !b.localStartTime || !b.durationMinutes) return [];
        return expandRecurring(
          {
            weekday: b.weekday,
            localStartTime: b.localStartTime,
            durationMinutes: b.durationMinutes,
            timezone: b.timezone ?? t.timezone,
            validFrom: b.validFrom ? fromDbDate(b.validFrom) : null,
            validTo: b.validTo ? fromDbDate(b.validTo) : null,
          },
          start,
          end,
        );
      });
      out.set(t.id, subtract(expandWorkHours(t.workHours, start, end), [...blocks, ...off]));
    }
    return out;
  }

  /** Classes that count as booked (not cancelled, moved or deleted), clipped to [start, end). */
  private async booked(teacherIds: number[], start: number, end: number) {
    const rows = teacherIds.length
      ? await this.prisma.classSession.findMany({
          where: {
            teacherId: { in: teacherIds },
            deletedAt: null,
            stage: { notIn: ['cancelled', 'moved_out'] },
            startsAt: { gte: new Date(start - LONGEST_CLASS_MS), lt: new Date(end) },
            endsAt: { gt: new Date(start) },
          },
          select: { teacherId: true, startsAt: true, endsAt: true },
        })
      : [];
    const out = new Map<number, Span[]>();
    for (const r of rows) {
      const span = {
        start: Math.max(r.startsAt.getTime(), start),
        end: Math.min(r.endsAt.getTime(), end),
      };
      out.set(r.teacherId, [...(out.get(r.teacherId) ?? []), span]);
    }
    return out;
  }

  private numbers(available: Span[], classes: Span[]): Numbers {
    const busy = merge(classes);
    const availableHours = hoursOf(available);
    // Each class counts in full (two overlapping classes are two bookings).
    const bookedHours = hoursOf(classes);
    return {
      availableHours,
      bookedHours,
      freeHours: hoursOf(subtract(available, busy)),
      outsideHours: hoursOf(subtract(busy, available)),
      utilization: ratio(bookedHours, availableHours),
    };
  }

  // ---------------------------------------------------------------- utilization

  async utilization(q: UtilQuery, viewer: AuthUser): Promise<UtilizationReportDto> {
    const teachers = await this.teachers(q, viewer);
    const academy = await this.settings.get('academy.timezone');
    const today = localDate(this.clock.nowMs(), academy);
    const from = q.from ?? `${today.slice(0, 7)}-01`;
    const to = q.to ?? addDays(addMonths(from, 1), -1);
    const length = (dateMs(to) - dateMs(from)) / DAY + 1;
    const prevFrom = addDays(from, -length);
    const prevTo = addDays(from, -1);
    const range = (a: string, b: string) =>
      [toUtc(a, '00:00', academy), toUtc(addDays(b, 1), '00:00', academy)] as const;

    const [start, end] = range(from, to);
    const [pStart, pEnd] = range(prevFrom, prevTo);
    const ids = teachers.map((t) => t.id);
    const [avail, pAvail, booked, pBooked] = await Promise.all([
      this.available(teachers, start, end),
      this.available(teachers, pStart, pEnd),
      this.booked(ids, start, end),
      this.booked(ids, pStart, pEnd),
    ]);

    const rows: TeacherUtilizationDto[] = teachers.map((t) => {
      const classes = booked.get(t.id) ?? [];
      const now = this.numbers(avail.get(t.id) ?? [], classes);
      const previous = this.numbers(pAvail.get(t.id) ?? [], pBooked.get(t.id) ?? []);
      return {
        teacher: { id: t.id, name: teacherName(t), timezone: t.timezone },
        classes: classes.length,
        ...now,
        previous,
        utilizationDelta:
          now.utilization !== null && previous.utilization !== null
            ? Math.round((now.utilization - previous.utilization) * 10_000) / 10_000
            : null,
      };
    });
    rows.sort(
      (a, b) =>
        (b.utilization ?? -1) - (a.utilization ?? -1) ||
        a.teacher.name.localeCompare(b.teacher.name),
    );
    // Per academy-local day: the same numbers, each teacher's spans cut to that day.
    const days: UtilizationReportDto['days'] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const [dStart, dEnd] = range(date, date);
      const cut = (spans: Span[]) =>
        spans.flatMap((x) => {
          const a = Math.max(x.start, dStart);
          const b = Math.min(x.end, dEnd);
          return a < b ? [{ start: a, end: b }] : [];
        });
      let classes = 0;
      const parts = teachers.map((t) => {
        const mine = booked.get(t.id) ?? [];
        classes += mine.filter((x) => x.start >= dStart && x.start < dEnd).length;
        return this.numbers(cut(avail.get(t.id) ?? []), cut(mine));
      });
      const total = (k: 'availableHours' | 'bookedHours' | 'freeHours' | 'outsideHours') =>
        Math.round(parts.reduce((x, p) => x + p[k], 0) * 100) / 100;
      days.push({
        date,
        weekday: isoWeekday(date),
        classes,
        availableHours: total('availableHours'),
        bookedHours: total('bookedHours'),
        freeHours: total('freeHours'),
        outsideHours: total('outsideHours'),
        utilization: ratio(total('bookedHours'), total('availableHours')),
      });
    }
    const sum = (k: 'availableHours' | 'bookedHours' | 'freeHours' | 'outsideHours') =>
      Math.round(rows.reduce((t, r) => t + r[k], 0) * 100) / 100;
    return {
      range: { from, to, previous: { from: prevFrom, to: prevTo }, timezone: academy },
      teachers: rows,
      days,
      totals: {
        availableHours: sum('availableHours'),
        bookedHours: sum('bookedHours'),
        freeHours: sum('freeHours'),
        outsideHours: sum('outsideHours'),
        utilization: ratio(sum('bookedHours'), sum('availableHours')),
      },
    };
  }

  // ---------------------------------------------------------------- free capacity

  async freeCapacity(q: FreeQuery, viewer: AuthUser): Promise<FreeCapacityDto> {
    const teachers = await this.teachers(q, viewer);
    const zone = q.tz ?? (await this.settings.get('academy.timezone'));
    const today = localDate(this.clock.nowMs(), zone);
    const from = q.from ?? today;
    const to = q.to ?? addDays(today, 6);
    const start = toUtc(from, '00:00', zone);
    const end = toUtc(addDays(to, 1), '00:00', zone);
    const [avail, booked] = await Promise.all([
      this.available(teachers, start, end),
      this.booked(
        teachers.map((t) => t.id),
        start,
        end,
      ),
    ]);
    const free = new Map(
      teachers.map((t) => [t.id, subtract(avail.get(t.id) ?? [], booked.get(t.id) ?? [])]),
    );
    const days: FreeCapacityDto['days'] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const counts: number[] = [];
      for (let h = 0; h < 24; h++) {
        const cellStart = toUtc(date, `${String(h).padStart(2, '0')}:00`, zone);
        const cellEnd =
          h === 23
            ? toUtc(addDays(date, 1), '00:00', zone)
            : toUtc(date, `${String(h + 1).padStart(2, '0')}:00`, zone);
        let n = 0;
        for (const spans of free.values()) {
          if (spans.some((s) => s.start <= cellStart && s.end >= cellEnd)) n++;
        }
        counts.push(n);
      }
      days.push({ date, weekday: isoWeekday(date), free: counts });
    }
    return { range: { from, to, timezone: zone }, teacherCount: teachers.length, days };
  }
}
