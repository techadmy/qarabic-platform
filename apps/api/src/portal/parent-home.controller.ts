import { Controller, Get, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CLOSED_TICKET_STATUSES, type ParentHomeDto } from '@qarabic/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CurrentUser } from '../auth/decorators.js';
import { Clock } from '../common/clock.js';
import { isParentViewer } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { forbidden } from '../schedule/scope.js';
import { DAY, isoZ } from '../schedule/time.js';
import { SessionPresenter, sessionInclude, teacherName } from '../sessions/presenter.js';

const LIVE_STAGES = ['scheduled', 'activated', 'in_progress'] as const;

/**
 * `GET /parent/home` (M4 parent portal, D138): the signed-in parent's own family only — there is
 * no id to guess. Laravel composed the parent home from `/sessions`, `/students` and
 * `/session-requests`; this is the same data in one round trip for the web and the mobile app.
 * Lesson reports (`recentReports`) are filled once N3 is merged.
 */
@ApiTags('portal')
@Controller('parent')
export class ParentHomeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly presenter: SessionPresenter,
  ) {}

  @Can('families.view')
  @Get('home')
  async home(@CurrentUser() user: AuthUser): Promise<{ data: ParentHomeDto }> {
    if (!isParentViewer(user)) throw forbidden();
    const family = await this.prisma.family.findUnique({
      where: { userId: user.id },
      include: {
        user: { select: { name: true } },
        students: {
          where: { archivedAt: null },
          orderBy: { name: 'asc' },
          include: {
            regularCourse: { select: { id: true, nameAr: true, nameEn: true } },
            teacher: { select: { id: true, firstName: true, lastName: true, timezone: true } },
          },
        },
      },
    });
    if (!family) throw forbidden();
    const now = this.clock.now();
    const ids = family.students.map((s) => s.id);
    const [upcoming, nextByChild, pending, openTickets, updates] = await Promise.all([
      this.prisma.classSession.findMany({
        where: {
          studentId: { in: ids },
          deletedAt: null,
          stage: { in: [...LIVE_STAGES] },
          endsAt: { gt: now },
          startsAt: { lt: new Date(now.getTime() + 7 * DAY) },
        },
        include: sessionInclude,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: 20,
      }),
      Promise.all(
        ids.map((studentId) =>
          this.prisma.classSession.findFirst({
            where: {
              studentId,
              deletedAt: null,
              stage: { in: [...LIVE_STAGES] },
              endsAt: { gt: now },
            },
            orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
            select: { id: true, startsAt: true, endsAt: true, stage: true },
          }),
        ),
      ),
      this.prisma.sessionRequest.count({ where: { status: 'pending', studentId: { in: ids } } }),
      this.prisma.ticket.count({
        where: { reporterId: user.id, status: { notIn: [...CLOSED_TICKET_STATUSES] } },
      }),
      this.prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM tickets
        WHERE reporter_id = ${user.id} AND last_public_at IS NOT NULL
          AND (reporter_seen_at IS NULL OR last_public_at > reporter_seen_at)`,
    ]);
    return {
      data: {
        family: {
          id: family.id,
          name: family.user.name,
          timezone: family.timezone,
          status: family.status,
        },
        children: family.students.map((s, i) => {
          const next = nextByChild[i];
          return {
            id: s.id,
            name: s.name,
            status: s.status,
            course: s.regularCourse,
            teacher: s.teacher
              ? { id: s.teacher.id, name: teacherName(s.teacher), timezone: s.teacher.timezone }
              : null,
            nextClass: next
              ? {
                  id: next.id,
                  startsAt: isoZ(next.startsAt)!,
                  endsAt: isoZ(next.endsAt)!,
                  stage: next.stage,
                }
              : null,
          };
        }),
        upcomingClasses: await this.presenter.many(upcoming, user),
        requests: {
          pendingClassRequests: pending,
          openTickets,
          ticketUpdates: Number(updates[0]?.n ?? 0),
        },
        // TODO(N3 merge): latest lesson reports per child, without the teacher's internal notes.
        recentReports: null,
      },
    };
  }
}

@Module({ imports: [ScheduleModule], controllers: [ParentHomeController] })
export class PortalModule {}
