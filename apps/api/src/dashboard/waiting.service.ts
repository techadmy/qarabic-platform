import { Injectable } from '@nestjs/common';
import {
  DASHBOARD_WAITING_LINKS,
  type DashboardWaitingItemDto,
  type DashboardWaitingKey,
  visibleWaiting,
} from '@qarabic/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { uncontactedLeadWhere } from '../crm/reports.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { InboxService } from '../support/inbox.service.js';
import { SupportContext } from '../support/policy.js';

/**
 * «Waiting for action» (docs/40 §3 row 3, D3): what is queued right now, each count the same filter
 * as the list it links to, and only for viewers who may open that list (DASHBOARD_WAITING_PERMISSIONS).
 * Live on every request (cheap counts), never part of the range cache.
 */
@Injectable()
export class DashboardWaitingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inbox: InboxService,
    private readonly support: SupportContext,
  ) {}

  async list(viewer: AuthUser): Promise<DashboardWaitingItemDto[]> {
    const keys = visibleWaiting(viewer.permissions);
    const counts = await Promise.all(keys.map((k) => this.count(k, viewer)));
    return keys.map((key, i) => ({ key, count: counts[i]!, href: DASHBOARD_WAITING_LINKS[key] }));
  }

  private async count(key: DashboardWaitingKey, viewer: AuthUser): Promise<number> {
    switch (key) {
      case 'leads_uncontacted':
        return this.prisma.lead.count({ where: uncontactedLeadWhere() });
      case 'payments_to_review':
        return this.prisma.payment.count({ where: { needsReview: true } });
      case 'credits_to_review':
        return this.prisma.familyCredit.count({ where: { reviewedAt: null } });
      case 'leave_requests':
        return this.prisma.sessionRequest.count({ where: { type: 'leave', status: 'pending' } });
      case 'tickets_past_sla':
        // The support inbox's own «breached» total for this viewer (its queues and visibility).
        return (await this.inbox.summary(await this.support.viewer(viewer))).breachedTotal;
    }
  }
}
