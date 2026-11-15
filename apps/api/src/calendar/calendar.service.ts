import { Injectable } from '@nestjs/common';
import {
  CALENDAR_MAX_EVENTS,
  type CalendarBackgroundDto,
  type calendarBackgroundQuerySchema,
  type CalendarEventsDto,
  type calendarEventsQuerySchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertStaffOrTeacher, forbidden, viewerScope } from '../schedule/scope.js';
import { fromDbDate, localDate } from '../schedule/time.js';
import { attentionFor, sessionInclude, teacherName } from '../sessions/presenter.js';
import { SettingsService } from '../settings/settings.service.js';
import { expandRecurring, expandWorkHours, holidaySpan, iso, merge } from './expand.js';

type EventsQuery = z.output<typeof calendarEventsQuerySchema>;
type BackgroundQuery = z.output<typeof calendarBackgroundQuerySchema>;

/** No class is longer than a day: lets the range use the `starts_at` indexes. */
const LONGEST_CLASS_MS = 24 * 3_600_000;
const MAX_TEACHERS = 200;

/**
 * C1 (docs/42 §3, D148): the calendar's reads. Staff see every teacher (narrowed by filters); a
 * teacher only their own classes and hours, whatever they ask; a parent nothing (portal later).
 */
@Injectable()
export class CalendarViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
  ) {}

  /** The teacher a teacher viewer is limited to, or null for staff. */
  private async ownTeacher(viewer: AuthUser): Promise<number | null> {
    // Staff with schedule.view, or a teacher for their own; `sessions.conduct` on a staff role
    // never widens access.
    assertStaffOrTeacher(viewer, 'schedule.view');
    const scope = await viewerScope(this.prisma, viewer);
    if (scope.kind === 'family') throw forbidden();
    return scope.kind === 'teacher' ? scope.teacherId : null;
  }

  private zone(q: { tz?: string }, viewer: AuthUser): string {
    return q.tz ?? viewer.timezone;
  }

  async events(q: EventsQuery, viewer: AuthUser): Promise<CalendarEventsDto> {
    const own = await this.ownTeacher(viewer);
    const from = new Date(q.from);
    const to = new Date(q.to);
    const and: Prisma.ClassSessionWhereInput[] = [
      { deletedAt: null },
      // Overlaps [from, to); the lower bound on starts_at keeps the index in play.
      { startsAt: { gte: new Date(from.getTime() - LONGEST_CLASS_MS), lt: to } },
      { endsAt: { gt: from } },
    ];
    if (own !== null) and.push({ teacherId: own });
    if (q.teacherIds) and.push({ teacherId: { in: q.teacherIds } });
    if (q.studentIds) and.push({ studentId: { in: q.studentIds } });
    if (q.familyIds) and.push({ student: { familyId: { in: q.familyIds } } });
    if (q.courseIds) and.push({ courseId: { in: q.courseIds } });
    if (q.kinds) and.push({ kind: { in: q.kinds } });
    if (q.stages) and.push({ stage: { in: q.stages } });

    const rows = await this.prisma.classSession.findMany({
      where: { AND: and },
      include: sessionInclude,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: CALENDAR_MAX_EVENTS + 1,
    });
    const truncated = rows.length > CALENDAR_MAX_EVENTS;
    if (truncated) rows.length = CALENDAR_MAX_EVENTS;

    const st = await this.settings.all();
    const now = this.clock.nowMs();
    const teacherIds = [...new Set(rows.map((r) => r.teacherId))];
    const blocks = teacherIds.length
      ? await this.prisma.teacherBlock.findMany({ where: { teacherId: { in: teacherIds } } })
      : [];
    return {
      range: { from: from.toISOString(), to: to.toISOString(), timezone: this.zone(q, viewer) },
      truncated,
      events: rows.map((s) => ({
        id: s.id,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        durationMinutes: s.durationMinutes,
        kind: s.kind,
        stage: s.stage,
        attention: attentionFor(
          s,
          now,
          st,
          blocks.filter((b) => b.teacherId === s.teacherId),
        ),
        teacher: { id: s.teacher.id, name: teacherName(s.teacher), timezone: s.teacher.timezone },
        student: {
          id: s.student.id,
          name: s.student.name,
          timezone: s.student.family.timezone,
          familyId: s.student.familyId,
        },
        course: s.course,
        enrollmentId: s.enrollmentId,
        slotId: s.scheduleSlotId,
        isDetached: s.isDetached,
        lockVersion: s.lockVersion,
      })),
    };
  }

  async background(q: BackgroundQuery, viewer: AuthUser): Promise<CalendarBackgroundDto> {
    const own = await this.ownTeacher(viewer);
    const from = Date.parse(q.from);
    const to = Date.parse(q.to);
    const where: Prisma.TeacherWhereInput =
      own !== null
        ? { id: own }
        : {
            archivedAt: null,
            ...(q.teacherIds ? { id: { in: q.teacherIds } } : { status: 'active' }),
          };
    const teachers = await this.prisma.teacher.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        timezone: true,
        workHours: {
          select: { weekday: true, localStartTime: true, localEndTime: true, timezone: true },
        },
        blocks: true,
      },
      orderBy: [{ firstName: 'asc' }, { id: 'asc' }],
      take: MAX_TEACHERS,
    });
    const academy = await this.settings.get('academy.timezone');
    const firstDay = localDate(from, academy);
    const lastDay = localDate(to, academy);
    const holidays = await this.prisma.holiday.findMany({
      where: {
        date: { lte: new Date(`${lastDay}T00:00:00Z`) },
        OR: [
          { endsOn: { gte: new Date(`${firstDay}T00:00:00Z`) } },
          { endsOn: null, date: { gte: new Date(`${firstDay}T00:00:00Z`) } },
        ],
      },
      orderBy: { date: 'asc' },
    });

    return {
      range: { from: iso(from), to: iso(to), timezone: this.zone(q, viewer) },
      teachers: teachers.map((t) => ({
        teacherId: t.id,
        name: teacherName(t),
        timezone: t.timezone,
        workHours: expandWorkHours(t.workHours, from, to).map((s) => ({
          start: iso(s.start),
          end: iso(s.end),
        })),
        blocks: t.blocks
          .flatMap((b) => {
            const spans =
              b.kind === 'one_off'
                ? b.startsAt && b.endsAt
                  ? merge([{ start: b.startsAt.getTime(), end: b.endsAt.getTime() }]).filter(
                      (s) => s.start < to && s.end > from,
                    )
                  : []
                : b.weekday && b.localStartTime && b.durationMinutes
                  ? expandRecurring(
                      {
                        weekday: b.weekday,
                        localStartTime: b.localStartTime,
                        durationMinutes: b.durationMinutes,
                        timezone: b.timezone ?? t.timezone,
                        validFrom: b.validFrom ? fromDbDate(b.validFrom) : null,
                        validTo: b.validTo ? fromDbDate(b.validTo) : null,
                      },
                      from,
                      to,
                    )
                  : [];
            return spans.map((s) => ({
              start: iso(Math.max(s.start, from)),
              end: iso(Math.min(s.end, to)),
              blockId: b.id,
              reason: b.reason,
              kind: b.kind,
            }));
          })
          .sort((a, b) => a.start.localeCompare(b.start)),
      })),
      holidays: holidays.flatMap((h) => {
        const span = holidaySpan(
          fromDbDate(h.date),
          h.endsOn ? fromDbDate(h.endsOn) : null,
          academy,
          from,
          to,
        );
        return span
          ? [
              {
                id: h.id,
                name: h.name,
                appliesTo: h.appliesTo,
                start: iso(span.start),
                end: iso(span.end),
              },
            ]
          : [];
      }),
    };
  }
}
