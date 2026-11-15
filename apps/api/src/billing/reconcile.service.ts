import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GatewayError, StripeGateway } from './gateways.js';
import { PaymentService, REUSE_MINUTES } from './payments.service.js';

/** PayPal orders nobody approved lapse after about 3 hours. */
const PAYPAL_STALE_MINUTES = 3 * 60;

export interface ReconcileStats {
  checked: number;
  paid: number;
  closed: number;
  failed: number;
}

/**
 * P1-2 (docs/39 BIL-3): the safety net behind the webhooks. Online attempts still `pending` after
 * their checkout's lifetime are looked up at the provider (sandbox keys only): a Stripe session
 * that was paid is finalized exactly as its webhook would have done (idempotent), an expired one is
 * closed; an unapproved PayPal order that lapsed is closed. Nightly (`billing:reconcile`) or by CLI.
 */
@Injectable()
export class PaymentReconciler {
  private readonly logger = new Logger(PaymentReconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly stripe: StripeGateway,
    private readonly payments: PaymentService,
  ) {}

  async run(): Promise<ReconcileStats> {
    const now = this.clock.nowMs();
    const stats: ReconcileStats = { checked: 0, paid: 0, closed: 0, failed: 0 };
    const stale = await this.prisma.payment.findMany({
      where: {
        status: 'pending',
        OR: [
          {
            method: 'stripe',
            providerRef: { not: null },
            createdAt: { lt: new Date(now - REUSE_MINUTES * 60_000) },
          },
          { method: 'paypal', createdAt: { lt: new Date(now - PAYPAL_STALE_MINUTES * 60_000) } },
        ],
      },
      orderBy: { id: 'asc' },
      take: 200,
    });
    for (const p of stale) {
      stats.checked++;
      if (p.method === 'paypal') {
        await this.payments.markFailed(p.id, 'cancelled', 'expired');
        stats.closed++;
        continue;
      }
      if (!this.stripe.enabled()) continue;
      try {
        const s = await this.stripe.session(p.providerRef!);
        if (s.paymentStatus === 'paid') {
          await this.payments.markSucceeded(p.id, s.paymentIntent, s.amountMinor, s.currency);
          stats.paid++;
          this.logger.warn(`Reconciled payment ${p.id}: paid at Stripe, no webhook applied it.`);
        } else if (s.status === 'expired') {
          await this.payments.markFailed(p.id, 'cancelled', 'expired');
          stats.closed++;
        }
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        stats.failed++;
        this.logger.warn(`Could not reconcile payment ${p.id}: ${error.message}`);
      }
    }
    return stats;
  }
}
