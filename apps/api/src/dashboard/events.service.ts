import { Injectable } from '@nestjs/common';
import {
  type DashboardEventDto,
  type DashboardEventKind,
  type DashboardEventsDto,
  type dashboardEventsQuerySchema,
  visibleEventKinds,
} from '@qarabic/shared';
import type { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';

type Query = z.output<typeof dashboardEventsQuerySchema>;
type Data = DashboardEventDto['data'];

/** Audit actions that are business events, with the facts each may show (never the raw record). */
const AUDIT: Record<string, { kind: DashboardEventKind; subjectType: string; pick: string[] }> = {
  payment_recorded: {
    kind: 'payment_received',
    subjectType: 'payment',
    pick: ['amount', 'currency', 'method', 'invoiceId'],
  },
  payment_succeeded: {
    kind: 'payment_received',
    subjectType: 'payment',
    pick: ['amount', 'currency', 'method', 'invoiceId'],
  },
  payment_refunded: {
    kind: 'payment_refunded',
    subjectType: 'payment',
    pick: ['amount', 'currency', 'method', 'invoiceId'],
  },
  invoice_issued: {
    kind: 'invoice_issued',
    subjectType: 'invoice',
    pick: ['number', 'total', 'currency'],
  },
  invoice_voided: { kind: 'invoice_voided', subjectType: 'invoice', pick: [] },
  converted: { kind: 'lead_converted', subjectType: 'lead', pick: ['familyId'] },
  trial_booked: { kind: 'trial_booked', subjectType: 'lead', pick: ['sessionId', 'startsAt'] },
  payroll_run_approved: { kind: 'payroll_approved', subjectType: 'payroll_run', pick: ['period'] },
  payslip_paid: { kind: 'payslip_paid', subjectType: 'payslip', pick: ['paidOn'] },
};

const actorSelect = { select: { id: true, name: true, role: { select: { name: true } } } };

function pick(raw: unknown, keys: string[]): Data {
  const out: Data = {};
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
    else if (v === null) out[k] = null;
  }
  return out;
}

/**
 * docs/40 §3 row 3 «Recent events»: business events from the audit log and the class history,
 * newest first, each kind gated by the permissions of the dashboard widget it belongs to
 * (DASHBOARD_EVENT_PERMISSIONS). Staff only (the route needs reports.view), so actor names are
 * shown; portal views never reach it (B118).
 */
@Injectable()
export class DashboardEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: Query, permissions: ReadonlySet<string>): Promise<DashboardEventsDto> {
    const kinds = new Set(visibleEventKinds(permissions));
    const before = q.before ? new Date(q.before) : undefined;
    const actions = Object.entries(AUDIT)
      .filter(([, m]) => kinds.has(m.kind))
      .map(([action]) => action);

    const [audits, cancels] = await Promise.all([
      actions.length
        ? this.prisma.auditLog.findMany({
            where: {
              action: { in: actions },
              ...(before ? { createdAt: { lt: before } } : {}),
            },
            include: { actor: actorSelect },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: q.limit,
          })
        : [],
      kinds.has('class_cancelled')
        ? this.prisma.sessionEvent.findMany({
            where: {
              type: 'cancelled',
              // A person cancelled it (holiday / schedule re-sync cancellations are the system's).
              actorUserId: { not: null },
              ...(before ? { occurredAt: { lt: before } } : {}),
            },
            include: { actor: actorSelect, session: { select: { startsAt: true } } },
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            take: q.limit,
          })
        : [],
    ]);

    const events: DashboardEventDto[] = [];
    for (const a of audits) {
      const m = AUDIT[a.action]!;
      if (a.subjectType !== m.subjectType) continue;
      events.push({
        key: `audit:${a.id}`,
        kind: m.kind,
        at: a.createdAt.toISOString(),
        actor: a.actor
          ? { id: a.actor.id, name: a.actor.name, role: a.actor.role?.name ?? null }
          : null,
        subject: { type: a.subjectType, id: a.subjectId },
        data: pick(a.after, m.pick),
      });
    }
    for (const e of cancels) {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      events.push({
        key: `session:${e.id}`,
        kind: 'class_cancelled',
        at: e.occurredAt.toISOString(),
        actor: e.actor
          ? { id: e.actor.id, name: e.actor.name, role: e.actor.role?.name ?? null }
          : null,
        subject: { type: 'class_session', id: e.sessionId },
        data: {
          startsAt: e.session.startsAt.toISOString(),
          reason: typeof payload.stageReason === 'string' ? payload.stageReason : null,
        },
      });
    }
    events.sort((x, y) => y.at.localeCompare(x.at) || y.key.localeCompare(x.key));
    const page = events.slice(0, q.limit);
    return {
      events: page,
      nextBefore: page.length === q.limit ? page.at(-1)!.at : null,
    };
  }
}
