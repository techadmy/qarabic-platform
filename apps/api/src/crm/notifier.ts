import { Inject, Injectable, Logger } from '@nestjs/common';
import { LEAD_NOTIFICATION_LABELS, type LeadNotificationEvent } from '@qarabic/shared';
import { Clock } from '../common/clock.js';
import { ENV, type Env } from '../config/env.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import type { Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** A staff alert about a lead, collected inside a transaction and delivered after it commits. */
export interface LeadAlert {
  userId: number;
  event: LeadNotificationEvent;
  leadId: number;
  parentName: string;
  dueAt?: string | null;
  assignee?: string | null;
}

/** Alerts raised by one write; `LeadNotifier.deliver` sends them once the write has committed. */
export class Outbox {
  readonly alerts: LeadAlert[] = [];
  /** Zoom meetings of classes cancelled inside the transaction (deleted after commit). */
  readonly cancelledSessions: number[] = [];

  push(alert: LeadAlert): void {
    this.alerts.push(alert);
  }
}

/** Active holders of a permission (the owner role holds every permission). */
export function usersWithPermission(
  db: Tx | PrismaService,
  permission: string,
  where: { id?: number | { in: number[] }; role?: { name: { in: string[] } } } = {},
) {
  return db.user.findMany({
    where: {
      isActive: true,
      archivedAt: null,
      ...(where.id !== undefined ? { id: where.id } : {}),
      role: {
        ...(where.role ?? {}),
        permissions: { some: { permission: { name: permission } } },
      },
    },
    select: { id: true, name: true, email: true, role: { select: { name: true } } },
    orderBy: { id: 'asc' },
  });
}

/**
 * Staff alerts about leads (Laravel `LeadNotification`): an in-app row the bell reads
 * (`notifications`) and an email to the staff member. Carries the parent's name only, never
 * contact details. Families are never messaged from here except the trial-form confirmation,
 * which is off by default (D140).
 */
@Injectable()
export class LeadNotifier {
  private readonly logger = new Logger(LeadNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Delivers each alert once per user + event + lead; never throws (the change is saved). */
  async deliver(alerts: readonly LeadAlert[]): Promise<number> {
    const seen = new Set<string>();
    let sent = 0;
    for (const alert of alerts) {
      const key = `${alert.userId}:${alert.event}:${alert.leadId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const user = await this.prisma.user.findUnique({
          where: { id: alert.userId },
          select: { id: true, email: true, isActive: true, archivedAt: true },
        });
        if (!user?.isActive || user.archivedAt) continue;
        const data = {
          kind: 'lead',
          event: alert.event,
          leadId: alert.leadId,
          parentName: alert.parentName,
          ...(alert.dueAt ? { dueAt: alert.dueAt } : {}),
          ...(alert.assignee ? { assignee: alert.assignee } : {}),
        };
        await this.prisma.notification.create({
          data: {
            userId: user.id,
            kind: 'lead',
            event: alert.event,
            data,
            createdAt: this.clock.now(),
          },
        });
        const label = LEAD_NOTIFICATION_LABELS[alert.event];
        const url = new URL(`/leads/${alert.leadId}`, this.env.APP_URL).toString();
        await this.mailer.send({
          kind: `lead_${alert.event}`,
          to: user.email,
          subject: `${label.ar} — ${label.en}`,
          text: `${label.ar}: ${alert.parentName}\n${label.en}: ${alert.parentName}\n\n${url}`,
        });
        sent++;
      } catch (error) {
        this.logger.error(`Lead alert not delivered: ${(error as Error).message}`);
      }
    }
    return sent;
  }

  /** Confirmation to the family after a trial request (Laravel `TrialRequestReceived`). */
  async confirmTrialRequest(to: string, parentName: string, lang: 'ar' | 'en'): Promise<void> {
    const ar = lang === 'ar';
    await this.mailer.send({
      kind: 'trial_request_received',
      to,
      subject: ar ? 'استلمنا طلب الحصة التجريبية' : 'We received your free trial request',
      text: ar
        ? `السلام عليكم ${parentName}،\nاستلمنا طلبكم للحصة التجريبية المجانية، وسيتواصل معكم فريقنا قريبًا لتحديد الموعد.\nأكاديمية قرآبك`
        : `Assalamu alaikum ${parentName},\nWe received your free trial request. Our team will contact you soon to arrange the class.\nQarabic Academy`,
    });
  }
}
