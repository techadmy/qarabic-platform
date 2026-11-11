import { Injectable } from '@nestjs/common';
import {
  CLOSED_TICKET_STATUSES,
  type InboxItemDto,
  type inboxQuerySchema,
  type InboxResponse,
  isClosedStatus,
  type MyRequestItemDto,
  type myRequestsQuerySchema,
  type MyRequestsResponse,
  type NextStep,
  type QueueCountsDto,
  type SupportPeopleDto,
  type SupportSummaryDto,
  type TicketPriority,
  type TicketQueue,
  type TicketStatus,
} from '@qarabic/shared';
import type { z } from 'zod';
import { Clock } from '../common/clock.js';
import { contains } from '../common/search.js';
import type { Prisma } from '../generated/prisma/client.js';
import { isParentViewer } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { teacherName } from '../sessions/presenter.js';
import { SessionRequestsService } from '../sessions/requests.service.js';
import { isoZ } from '../schedule/time.js';
import { has, SupportPolicy, type SupportViewer } from './policy.js';
import { SlaClock } from './sla.js';
import { forbidden, textSearch, TicketsService } from './tickets.service.js';

type InboxQuery = z.output<typeof inboxQuerySchema>;
type MineQuery = z.output<typeof myRequestsQuerySchema>;

interface Narrow {
  kind: 'ticket' | 'session_request';
  id: number;
  slaDueAt: number | null;
  breached: boolean;
  open: boolean;
  createdAt: number;
  updatedAt: number;
}

const requestNarrowSelect = {
  id: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  session: {
    select: { startsAt: true, teacher: { select: { id: true, firstName: true, lastName: true } } },
  },
  student: { select: { familyId: true, family: { select: { user: { select: { name: true } } } } } },
} satisfies Prisma.SessionRequestSelect;

/** The `X → Y` next step a requester sees on a ticket («طلباتي»). */
export function ticketNextStep(status: TicketStatus): NextStep | null {
  switch (status) {
    case 'new':
    case 'triaged':
      return 'awaiting_team';
    case 'in_progress':
      return 'in_progress';
    case 'needs_info':
      return 'reply_needed';
    case 'fixed':
      return 'confirm_fix';
    default:
      return null;
  }
}

function page<T>(items: T[], q: { page: number; perPage: number }): T[] {
  return items.slice((q.page - 1) * q.perPage, q.page * q.perPage);
}
const lastPage = (total: number, perPage: number) => Math.max(1, Math.ceil(total / perPage));

/**
 * The unified staff inbox, the merged «طلباتي», the dashboard counters and the inbox side panel
 * (docs/32 §4–§6, D135), port of Laravel `SupportInboxController` / `MyRequestsController` /
 * `InboxItems`. Tickets and pending class requests are reduced to the same narrow row, sorted and
 * paginated, then hydrated with the usual DTOs. Open items are few (hundreds), so the merge runs
 * in memory; a pending class request's SLA is computed from its creation and its class start (the
 * same rule Laravel stored at creation).
 */
@Injectable()
export class InboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly tickets: TicketsService,
    private readonly requests: SessionRequestsService,
  ) {}

  private requestSla(
    v: SupportViewer,
    r: { createdAt: Date; session: { startsAt: Date } },
  ): number {
    return SlaClock.dueFor(
      'scheduling',
      r.createdAt.getTime(),
      v.config,
      r.session.startsAt.getTime(),
    );
  }

  private ticketBreachedWhere(nowMs: number): Prisma.TicketWhereInput {
    return {
      status: { notIn: [...CLOSED_TICKET_STATUSES] },
      firstResponseAt: null,
      slaDueAt: { lt: new Date(nowMs) },
    };
  }

  // ------------------------------------------------------------------ inbox

  async inbox(q: InboxQuery, v: SupportViewer): Promise<InboxResponse> {
    const visible = SupportPolicy.visibleQueues(v);
    if (q.queue && !visible.includes(q.queue)) throw forbidden();
    const now = this.clock.nowMs();
    const rows: Narrow[] = [];

    if (q.kind !== 'session_request') {
      const and: Prisma.TicketWhereInput[] = [
        SupportPolicy.staffWhere(v, false),
        { queue: { in: visible } },
      ];
      if (q.status === 'open') and.push({ status: { notIn: [...CLOSED_TICKET_STATUSES] } });
      else if (q.status === 'closed') and.push({ status: { in: [...CLOSED_TICKET_STATUSES] } });
      else if (q.status !== 'all') and.push({ status: q.status });
      if (q.queue) and.push({ queue: q.queue });
      if (q.category?.length) and.push({ category: { in: q.category } });
      if (q.priority?.length) {
        const named = q.priority.filter((p): p is TicketPriority => p !== 'none');
        and.push({
          OR: [
            ...(named.length ? [{ priority: { in: named } }] : []),
            ...(q.priority.includes('none') ? [{ priority: null }] : []),
          ],
        });
      }
      if (q.breached) and.push(this.ticketBreachedWhere(now));
      if (q.familyId) and.push({ familyId: q.familyId });
      if (q.assignee !== undefined) {
        and.push({
          assigneeId: q.assignee === 'none' ? null : q.assignee === 'me' ? v.user.id : q.assignee,
        });
      }
      if (q.q) and.push(textSearch(q.q));
      const tickets = await this.prisma.ticket.findMany({
        where: { AND: and },
        select: {
          id: true,
          status: true,
          slaDueAt: true,
          firstResponseAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      for (const t of tickets) {
        const open = !isClosedStatus(t.status);
        const due = t.slaDueAt?.getTime() ?? null;
        rows.push({
          kind: 'ticket',
          id: t.id,
          slaDueAt: due,
          breached: open && t.firstResponseAt === null && due !== null && due < now,
          open,
          createdAt: t.createdAt.getTime(),
          updatedAt: t.updatedAt.getTime(),
        });
      }
    }

    const assigneeExcludes = q.assignee === 'me' || typeof q.assignee === 'number';
    const withRequests =
      q.kind !== 'ticket' &&
      has(v.user, 'session_requests.view') &&
      visible.includes('scheduling') &&
      (!q.queue || q.queue === 'scheduling') &&
      (!q.category?.length || q.category.includes('classes')) &&
      (q.status === 'open' || q.status === 'all') &&
      !q.priority?.length &&
      !assigneeExcludes;
    if (withRequests) {
      const and: Prisma.SessionRequestWhereInput[] = [{ status: 'pending' }];
      if (q.familyId) and.push({ student: { familyId: q.familyId } });
      if (q.q) and.push({ reason: contains(q.q) });
      const pending = await this.prisma.sessionRequest.findMany({
        where: { AND: and },
        select: requestNarrowSelect,
      });
      for (const r of pending) {
        const due = this.requestSla(v, r);
        if (q.breached && !(due < now)) continue;
        rows.push({
          kind: 'session_request',
          id: r.id,
          slaDueAt: due,
          breached: due < now,
          open: true,
          createdAt: r.createdAt.getTime(),
          updatedAt: r.updatedAt.getTime(),
        });
      }
    }

    // Breached first, then by deadline (none last), then newest.
    rows.sort(
      (a, b) =>
        Number(b.breached) - Number(a.breached) ||
        (a.slaDueAt === null ? 1 : 0) - (b.slaDueAt === null ? 1 : 0) ||
        (a.slaDueAt ?? 0) - (b.slaDueAt ?? 0) ||
        b.createdAt - a.createdAt ||
        b.id - a.id,
    );
    return {
      data: await this.hydrate(page(rows, q), v),
      meta: {
        page: q.page,
        perPage: q.perPage,
        total: rows.length,
        lastPage: lastPage(rows.length, q.perPage),
        queues: visible,
        counts: await this.counts(v),
      },
    };
  }

  private async hydrate(rows: Narrow[], v: SupportViewer): Promise<InboxItemDto[]> {
    const now = this.clock.nowMs();
    const ticketIds = rows.filter((r) => r.kind === 'ticket').map((r) => r.id);
    const requestIds = rows.filter((r) => r.kind === 'session_request').map((r) => r.id);
    const [tickets, requests] = await Promise.all([
      this.tickets.dtos(ticketIds, v),
      this.prisma.sessionRequest.findMany({
        where: { id: { in: requestIds } },
        select: requestNarrowSelect,
      }),
    ]);
    const byId = new Map(requests.map((r) => [r.id, r]));
    const out: InboxItemDto[] = [];
    for (const row of rows) {
      if (row.kind === 'ticket') {
        const t = tickets.get(row.id);
        if (!t) continue;
        const staffTicket = t as typeof t & {
          family?: { id: number; name: string | null } | null;
          teacher?: { id: number; name: string | null } | null;
        };
        out.push({
          kind: 'ticket',
          key: `ticket:${row.id}`,
          id: row.id,
          queue: t.queue,
          slaDueAt: t.slaDueAt,
          slaState: t.slaState,
          family: staffTicket.family ?? null,
          teacher: staffTicket.teacher ?? null,
          open: row.open,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          ticket: t,
          request: null,
        });
        continue;
      }
      const r = byId.get(row.id);
      if (!r) continue;
      const due = row.slaDueAt === null ? null : new Date(row.slaDueAt);
      out.push({
        kind: 'session_request',
        key: `request:${row.id}`,
        id: row.id,
        queue: 'scheduling',
        slaDueAt: isoZ(due),
        slaState: r.status === 'pending' ? SlaClock.state(due, null, true, now) : 'none',
        family: { id: r.student.familyId, name: r.student.family.user.name },
        teacher: { id: r.session.teacher.id, name: teacherName(r.session.teacher) },
        open: r.status === 'pending',
        createdAt: isoZ(r.createdAt)!,
        updatedAt: isoZ(r.updatedAt)!,
        ticket: null,
        request: await this.requests.show(r.id, v.user),
      });
    }
    return out;
  }

  /** Per visible queue: open, breached and unassigned (filters ignored). */
  async counts(v: SupportViewer): Promise<Partial<Record<TicketQueue, QueueCountsDto>>> {
    const visible = SupportPolicy.visibleQueues(v);
    const now = this.clock.nowMs();
    const base: Prisma.TicketWhereInput = {
      AND: [
        SupportPolicy.staffWhere(v, false),
        { queue: { in: visible } },
        { status: { notIn: [...CLOSED_TICKET_STATUSES] } },
      ],
    };
    const group = async (extra: Prisma.TicketWhereInput) =>
      new Map(
        (
          await this.prisma.ticket.groupBy({
            by: ['queue'],
            where: { AND: [base, extra] },
            _count: { _all: true },
          })
        ).map((g) => [g.queue, g._count._all]),
      );
    const [open, breached, unassigned] = await Promise.all([
      group({}),
      group(this.ticketBreachedWhere(now)),
      group({ assigneeId: null }),
    ]);
    const counts: Partial<Record<TicketQueue, QueueCountsDto>> = {};
    for (const queue of visible) {
      counts[queue] = {
        open: open.get(queue) ?? 0,
        breached: breached.get(queue) ?? 0,
        unassigned: unassigned.get(queue) ?? 0,
      };
    }
    if (counts.scheduling && has(v.user, 'session_requests.view')) {
      const pending = await this.prisma.sessionRequest.findMany({
        where: { status: 'pending' },
        select: { createdAt: true, session: { select: { startsAt: true } } },
      });
      counts.scheduling.open += pending.length;
      counts.scheduling.unassigned += pending.length;
      counts.scheduling.breached += pending.filter((r) => this.requestSla(v, r) < now).length;
    }
    return counts;
  }

  async summary(v: SupportViewer): Promise<SupportSummaryDto> {
    const queues = await this.counts(v);
    const sum = (k: keyof QueueCountsDto) =>
      Object.values(queues).reduce((n, c) => n + (c?.[k] ?? 0), 0);
    return {
      openTotal: sum('open'),
      breachedTotal: sum('breached'),
      unassignedTotal: sum('unassigned'),
      queues,
    };
  }

  // ------------------------------------------------------------------ «طلباتي»

  /** My requests' row scope: filed by me; a parent also those on their children. */
  private async myRequestsWhere(v: SupportViewer): Promise<Prisma.SessionRequestWhereInput | null> {
    if (!has(v.user, 'session_requests.view', 'session_requests.request')) return null;
    const or: Prisma.SessionRequestWhereInput[] = [{ requestedById: v.user.id }];
    if (isParentViewer(v.user)) {
      const family = await this.prisma.family.findUnique({
        where: { userId: v.user.id },
        select: { students: { select: { id: true } } },
      });
      const ids = family?.students.map((s) => s.id) ?? [];
      if (ids.length) or.push({ studentId: { in: ids } });
    }
    return { OR: or };
  }

  async mine(q: MineQuery, v: SupportViewer): Promise<MyRequestsResponse> {
    const now = this.clock.nowMs();
    const [tickets, requestsWhere] = await Promise.all([
      this.prisma.ticket.findMany({
        where: { reporterId: v.user.id },
        select: { id: true, status: true, slaDueAt: true, createdAt: true, updatedAt: true },
      }),
      this.myRequestsWhere(v),
    ]);
    const requests = requestsWhere
      ? await this.prisma.sessionRequest.findMany({
          where: requestsWhere,
          select: requestNarrowSelect,
        })
      : [];
    const all: Narrow[] = [
      ...tickets.map((t) => ({
        kind: 'ticket' as const,
        id: t.id,
        slaDueAt: t.slaDueAt?.getTime() ?? null,
        breached: false,
        open: !isClosedStatus(t.status),
        createdAt: t.createdAt.getTime(),
        updatedAt: t.updatedAt.getTime(),
      })),
      ...requests.map((r) => ({
        kind: 'session_request' as const,
        id: r.id,
        slaDueAt: r.status === 'pending' ? this.requestSla(v, r) : null,
        breached: false,
        open: r.status === 'pending',
        createdAt: r.createdAt.getTime(),
        updatedAt: r.updatedAt.getTime(),
      })),
    ];
    const openCount = all.filter((r) => r.open).length;
    const rows = all
      .filter((r) => (q.status === 'open' ? r.open : q.status === 'closed' ? !r.open : true))
      .sort(
        (a, b) =>
          Number(b.open) - Number(a.open) ||
          b.updatedAt - a.updatedAt ||
          b.createdAt - a.createdAt ||
          b.id - a.id,
      );
    const items = await this.hydrateMine(page(rows, q), v, now);
    return {
      data: items,
      meta: {
        page: q.page,
        perPage: q.perPage,
        total: rows.length,
        lastPage: lastPage(rows.length, q.perPage),
        open: openCount,
      },
    };
  }

  private async hydrateMine(
    rows: Narrow[],
    v: SupportViewer,
    _now: number,
  ): Promise<MyRequestItemDto[]> {
    const tickets = await this.tickets.dtos(
      rows.filter((r) => r.kind === 'ticket').map((r) => r.id),
      v,
    );
    const out: MyRequestItemDto[] = [];
    for (const row of rows) {
      if (row.kind === 'ticket') {
        const t = tickets.get(row.id);
        if (!t) continue;
        out.push({
          kind: 'ticket',
          key: `ticket:${row.id}`,
          id: row.id,
          title: t.title,
          status: t.status,
          open: row.open,
          category: t.category,
          requestType: null,
          nextStep: ticketNextStep(t.status),
          slaDueAt: t.slaDueAt,
          hasUpdate: t.hasUpdate,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          ticket: t,
          request: null,
        });
        continue;
      }
      const r = await this.requests.show(row.id, v.user);
      out.push({
        kind: 'session_request',
        key: `request:${row.id}`,
        id: row.id,
        title: null,
        status: r.status,
        open: row.open,
        category: null,
        requestType: r.type,
        nextStep: r.status === 'pending' ? 'awaiting_approval' : null,
        slaDueAt: isoZ(row.slaDueAt),
        hasUpdate: false,
        createdAt: r.createdAt,
        updatedAt: isoZ(row.updatedAt)!,
        ticket: null,
        request: r,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ side panel

  /**
   * The family and / or teacher of an inbox item. Family details (status, zone, children, counts)
   * need `families.view`; without it they come back empty (same shape).
   */
  async people(
    q: { familyId?: number | undefined; teacherId?: number | undefined },
    v: SupportViewer,
  ): Promise<SupportPeopleDto> {
    const [family, teacher] = await Promise.all([
      q.familyId
        ? this.prisma.family.findUnique({
            where: { id: q.familyId },
            include: {
              user: { select: { name: true } },
              students: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
            },
          })
        : null,
      q.teacherId ? this.prisma.teacher.findUnique({ where: { id: q.teacherId } }) : null,
    ]);
    let familyDto: SupportPeopleDto['family'] = null;
    if (family) {
      familyDto = {
        id: family.id,
        name: family.user.name,
        status: null,
        timezone: null,
        children: [],
        openTickets: 0,
        pendingRequests: 0,
      };
      if (has(v.user, 'families.view')) {
        const ids = family.students.map((s) => s.id);
        const [openTickets, pendingRequests] = await Promise.all([
          this.prisma.ticket.count({
            where: {
              AND: [
                { familyId: family.id },
                { status: { notIn: [...CLOSED_TICKET_STATUSES] } },
                SupportPolicy.staffWhere(v),
              ],
            },
          }),
          this.prisma.sessionRequest.count({
            where: { status: 'pending', studentId: { in: ids.length ? ids : [0] } },
          }),
        ]);
        familyDto = {
          ...familyDto,
          status: family.status,
          timezone: family.timezone,
          children: family.students,
          openTickets,
          pendingRequests,
        };
      }
    }
    return {
      family: familyDto,
      teacher: teacher
        ? { id: teacher.id, name: teacherName(teacher), timezone: teacher.timezone }
        : null,
    };
  }
}
