import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type RequestState,
  type requestActionSchema,
  type requestAnswerSchema,
  type TicketStatus,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { ApiException, validationError } from '../common/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SupportViewer } from './policy.js';
import { TicketsService, userActor } from './tickets.service.js';

type Action = z.output<typeof requestActionSchema>['action'];

const conflict = (state: RequestState | null, action: string) =>
  new ApiException(HttpStatus.CONFLICT, {
    message: 'This step is not possible for the request in its current state.',
    code: 'request_transition',
    data: { state, action },
  });

/** From → to per staff action; teacher change and the others differ (docs/32 §3). */
function next(kind: string, state: RequestState, action: Action): RequestState | null {
  const teacher = kind === 'teacher_change';
  switch (action) {
    case 'propose':
      return teacher && ['submitted', 'proposed', 'declined'].includes(state) ? 'proposed' : null;
    case 'approve':
      return !teacher && state === 'submitted' ? 'approved' : null;
    case 'complete':
      return (teacher ? state === 'accepted' : state === 'approved') ? 'done' : null;
    case 'reject':
      return ['submitted', 'proposed', 'declined', 'approved', 'accepted'].includes(state)
        ? 'rejected'
        : null;
  }
}

/** The ticket status that follows a request step (so «طلباتي» and the inbox agree). */
function ticketStatusFor(to: RequestState, current: TicketStatus): TicketStatus | null {
  if (to === 'rejected') return 'wont_fix';
  if (to === 'done') return 'fixed';
  if (['new', 'triaged', 'needs_info'].includes(current)) return 'in_progress';
  return null;
}

/**
 * S3 typed requests (docs/32 §3 #4–#7): the staff steps (propose a teacher, approve, complete,
 * reject) and the family's answer to a proposal. Each step is a public row on the ticket's
 * timeline, the first response for the SLA, and an update dot in «طلباتي».
 */
@Injectable()
export class SupportRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly tickets: TicketsService,
  ) {}

  async act(
    id: number,
    input: z.output<typeof requestActionSchema>,
    v: SupportViewer,
  ): Promise<void> {
    await this.tickets.find(id, v, 'manage');
    let proposal: { teacherId: number; teacherName: string; fromDate: string } | null = null;
    if (input.action === 'propose' && input.proposal) {
      const teacher = await this.prisma.teacher.findUnique({
        where: { id: input.proposal.teacherId },
      });
      if (!teacher || teacher.status !== 'active' || teacher.archivedAt) {
        throw validationError({ 'proposal.teacherId': ['Choose an active teacher.'] });
      }
      proposal = {
        teacherId: teacher.id,
        teacherName: [teacher.firstName, teacher.lastName].filter(Boolean).join(' '),
        fromDate: input.proposal.fromDate,
      };
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${id} FOR UPDATE`;
      const t = await tx.ticket.findUniqueOrThrow({ where: { id } });
      if (!t.requestState || !t.subcategory) throw conflict(null, input.action);
      const to = next(t.subcategory, t.requestState, input.action);
      if (!to) throw conflict(t.requestState, input.action);
      const now = this.clock.now();
      const actor = userActor(v.user);
      const status = ticketStatusFor(to, t.status);
      await this.tickets.addRow(tx, id, actor, 'system', input.note ?? null, false, {
        request: {
          action: input.action,
          from: t.requestState,
          to,
          ...(proposal ? { proposal } : {}),
        },
      });
      await tx.ticket.update({
        where: { id },
        data: {
          requestState: to,
          ...(proposal ? { proposal: proposal } : {}),
          ...(status && status !== t.status ? this.tickets.statusData(t, status, now) : {}),
          ...(to === 'rejected' && input.note ? { resolution: input.note } : {}),
          ...(this.tickets.answersFirst(t, actor) ? { firstResponseAt: now } : {}),
          lastPublicAt: now,
          updatedAt: now,
        },
      });
      await this.audit.record(
        {
          actorId: v.user.id,
          action: 'request_step',
          subjectType: 'ticket',
          subjectId: id,
          before: { state: t.requestState },
          after: { state: to, action: input.action, ...(proposal ? { proposal } : {}) },
        },
        tx,
      );
    });
  }

  /** The requester accepts or declines the proposed teacher. */
  async answer(
    id: number,
    input: z.output<typeof requestAnswerSchema>,
    v: SupportViewer,
    user: AuthUser,
  ): Promise<void> {
    await this.tickets.find(id, v, 'confirm');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${id} FOR UPDATE`;
      const t = await tx.ticket.findUniqueOrThrow({ where: { id } });
      if (t.requestState !== 'proposed') throw conflict(t.requestState, 'answer');
      const to: RequestState = input.accept ? 'accepted' : 'declined';
      const now = this.clock.now();
      await this.tickets.addRow(tx, id, userActor(user), 'system', input.note ?? null, false, {
        request: { action: 'answer', from: 'proposed', to, byReporter: true },
      });
      await tx.ticket.update({
        where: { id },
        data: { requestState: to, reporterSeenAt: now, updatedAt: now },
      });
      await this.audit.record(
        {
          actorId: user.id,
          action: 'request_step',
          subjectType: 'ticket',
          subjectId: id,
          before: { state: 'proposed' },
          after: { state: to, byReporter: true },
        },
        tx,
      );
    });
  }
}
