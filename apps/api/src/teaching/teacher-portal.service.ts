import { Injectable } from '@nestjs/common';
import type { TeacherStudentDto, TeacherWeekDto } from '@qarabic/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { isTeacherViewer } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { zoneOr } from '../schedule/conflicts.js';
import { forbidden, LIVE_ENROLLMENT } from '../schedule/scope.js';
import { addDays, isoWeekday, isoZ, localDate, startOfLocalDay } from '../schedule/time.js';
import { SessionPresenter, sessionInclude, teacherName } from '../sessions/presenter.js';
import { SettingsService } from '../settings/settings.service.js';
import { lastPositions } from './progress.service.js';

/** ISO weekday of Saturday: the academy week runs Saturday → Friday (D71). */
const SATURDAY = 6;

/**
 * The teacher portal (D71, D138): «أسبوعي» (own classes of a Saturday–Friday week in the teacher's
 * zone, with the summary tiles) and «طلابي» (own students with their next class, last report and
 * last positions). Only a signed-in teacher (role kind `teacher`) — staff get 403.
 */
@Injectable()
export class TeacherPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly presenter: SessionPresenter,
  ) {}

  private async teacherOf(viewer: AuthUser) {
    if (!isTeacherViewer(viewer) || viewer.teacherId === null) throw forbidden();
    return this.prisma.teacher.findUniqueOrThrow({ where: { id: viewer.teacherId } });
  }

  async week(viewer: AuthUser, date?: string): Promise<TeacherWeekDto> {
    const teacher = await this.teacherOf(viewer);
    const zone = zoneOr(teacher.timezone, (await this.settings.all())['academy.timezone']);
    const today = localDate(this.clock.nowMs(), zone);
    const day = date ?? today;
    const weekStart = addDays(day, -((isoWeekday(day) - SATURDAY + 7) % 7));
    const weekEnd = addDays(weekStart, 6);
    const rows = await this.prisma.classSession.findMany({
      where: {
        teacherId: teacher.id,
        deletedAt: null,
        startsAt: {
          gte: new Date(startOfLocalDay(weekStart, zone)),
          lt: new Date(startOfLocalDay(addDays(weekStart, 7), zone)),
        },
      },
      include: sessionInclude,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    const sessions = await this.presenter.many(rows, viewer);
    const count = (stages: string[]) => sessions.filter((s) => stages.includes(s.stage)).length;
    return {
      teacher: { id: teacher.id, name: teacherName(teacher), timezone: zone },
      timezone: zone,
      weekStart,
      weekEnd,
      today,
      previousWeek: addDays(weekStart, -7),
      nextWeek: addDays(weekStart, 7),
      summary: {
        total: sessions.filter((s) => s.stage !== 'moved_out').length,
        taken: count(['taken']),
        remaining: count(['scheduled', 'activated', 'in_progress']),
        needsReport: count(['ended']),
        absent: count(['absent']),
        leave: count(['leave']),
      },
      days: Array.from({ length: 7 }, (_, i) => {
        const d = addDays(weekStart, i);
        return {
          date: d,
          sessions: sessions.filter((s) => localDate(Date.parse(s.startsAt), zone) === d),
        };
      }),
    };
  }

  /** The students the teacher teaches now: their own, or a live enrollment with them (D137). */
  async students(viewer: AuthUser): Promise<TeacherStudentDto[]> {
    const teacher = await this.teacherOf(viewer);
    const academy = (await this.settings.all())['academy.timezone'];
    const teacherId = teacher.id;
    const students = await this.prisma.student.findMany({
      where: {
        archivedAt: null,
        OR: [{ teacherId }, { enrollments: { some: { teacherId, ...LIVE_ENROLLMENT } } }],
      },
      include: {
        family: { select: { timezone: true } },
        enrollments: {
          where: { teacherId, ...LIVE_ENROLLMENT },
          include: { course: { select: { id: true, nameAr: true, nameEn: true } } },
          orderBy: { id: 'asc' },
        },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const ids = students.map((s) => s.id);
    const now = this.clock.now();
    const [next, reports, missing, positions] = await Promise.all([
      this.prisma.classSession.findMany({
        where: {
          teacherId,
          studentId: { in: ids },
          deletedAt: null,
          stage: 'scheduled',
          startsAt: { gte: now },
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        distinct: ['studentId'],
        select: { id: true, studentId: true, startsAt: true },
      }),
      this.prisma.lessonReport.findMany({
        where: { studentId: { in: ids } },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        distinct: ['studentId'],
        select: { studentId: true, sessionId: true, submittedAt: true },
      }),
      this.prisma.classSession.groupBy({
        by: ['studentId'],
        where: { teacherId, studentId: { in: ids }, deletedAt: null, stage: 'ended' },
        _count: { _all: true },
      }),
      lastPositions(this.prisma, ids),
    ]);
    return students.map((s) => {
      const n = next.find((x) => x.studentId === s.id);
      const r = reports.find((x) => x.studentId === s.id);
      return {
        id: s.id,
        name: s.name,
        age: s.age,
        timezone: zoneOr(s.family.timezone, academy),
        remarkTeacher: s.remarkTeacher,
        enrollments: s.enrollments.map((e) => ({ id: e.id, status: e.status, course: e.course })),
        nextSession: n ? { id: n.id, startsAt: isoZ(n.startsAt)! } : null,
        lastReport: r ? { sessionId: r.sessionId, submittedAt: isoZ(r.submittedAt)! } : null,
        reportsMissing: missing.find((m) => m.studentId === s.id)?._count._all ?? 0,
        lastPositions: positions.get(s.id) ?? [],
      };
    });
  }
}
