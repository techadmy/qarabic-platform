import { Injectable, Logger } from '@nestjs/common';
import { toMinor } from '@qarabic/shared';
import { Clock } from '../common/clock.js';
import { type Payment, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { pick, PayPalGateway } from './gateways.js';
import { PaymentService } from './payments.service.js';

export type WebhookResult = 'processed' | 'ignored' | 'duplicate';
type Provider = 'stripe' | 'paypal';
type Json = Record<string, unknown>;

const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

/**
 * Applies verified provider events exactly once (Laravel `WebhookService`, docs/20 §7). The caller
 * has already checked the signature. Every event is stored by (provider, event id): a duplicate that
 * was processed or ignored is a no-op; one that failed is retried.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentService,
    private readonly paypal: PayPalGateway,
    private readonly clock: Clock,
  ) {}

  async handle(provider: Provider, event: Json): Promise<WebhookResult> {
    const eventId = str(event.id);
    const type = str(event.type ?? event.event_type);
    if (!eventId || !type) return 'ignored';

    const row = await this.claim(provider, eventId, type, event);
    if (!row) return 'duplicate';
    try {
      const applied =
        provider === 'stripe'
          ? await this.stripe(type, event)
          : await this.paypalEvent(type, event);
      await this.prisma.paymentWebhookEvent.update({
        where: { id: row },
        data: {
          status: applied ? 'processed' : 'ignored',
          processedAt: this.clock.now(),
          error: null,
        },
      });
      return applied ? 'processed' : 'ignored';
    } catch (error) {
      await this.prisma.paymentWebhookEvent.update({
        where: { id: row },
        data: { status: 'failed', error: String((error as Error).message).slice(0, 1000) },
      });
      this.logger.error(
        `Payment webhook ${provider} ${eventId} (${type}) failed: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  private async claim(
    provider: Provider,
    eventId: string,
    type: string,
    event: Json,
  ): Promise<number | null> {
    const existing = await this.prisma.paymentWebhookEvent.findUnique({
      where: { provider_eventId: { provider, eventId } },
    });
    if (existing) return existing.status === 'failed' ? existing.id : null;
    try {
      const row = await this.prisma.paymentWebhookEvent.create({
        data: {
          provider,
          eventId,
          type: type.slice(0, 96),
          payload: event as Prisma.InputJsonValue,
          createdAt: this.clock.now(),
        },
      });
      return row.id;
    } catch (error) {
      // The same event is being handled by a parallel delivery.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        return null;
      throw error;
    }
  }

  // ------------------------------------------------------------------ Stripe

  private async stripe(type: string, event: Json): Promise<boolean> {
    const object = (pick(event, 'data.object') ?? {}) as Json;
    switch (type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const payment = await this.stripePaymentForSession(object);
        // Async methods report "unpaid" first, then async_payment_succeeded.
        if (!payment || object.payment_status !== 'paid') return false;
        const amount = typeof object.amount_total === 'number' ? object.amount_total : -1;
        await this.payments.markSucceeded(
          payment.id,
          str(object.payment_intent) || null,
          amount,
          str(object.currency),
        );
        return true;
      }
      case 'checkout.session.async_payment_failed': {
        const payment = await this.stripePaymentForSession(object);
        if (!payment) return false;
        await this.payments.markFailed(payment.id, 'failed', 'async_payment_failed');
        return true;
      }
      case 'checkout.session.expired': {
        const payment = await this.stripePaymentForSession(object);
        if (!payment) return false;
        await this.payments.markFailed(payment.id, 'cancelled', 'expired');
        return true;
      }
      case 'charge.refunded': {
        const intent = str(object.payment_intent);
        const payment = intent
          ? await this.prisma.payment.findFirst({
              where: { method: 'stripe', providerPaymentId: intent },
            })
          : null;
        if (!payment) return false;
        const refunded = typeof object.amount_refunded === 'number' ? object.amount_refunded : 0;
        await this.payments.markRefunded(payment.id, refunded);
        return true;
      }
    }
    return false;
  }

  private async stripePaymentForSession(session: Json): Promise<Payment | null> {
    const sessionId = str(session.id);
    if (!sessionId) return null;
    const payment = await this.prisma.payment.findUnique({
      where: { method_providerRef: { method: 'stripe', providerRef: sessionId } },
    });
    // The metadata must agree with our own record of the session.
    const metaId = pick(session, 'metadata.payment_id');
    if (payment && metaId !== undefined && str(metaId) !== String(payment.id)) {
      this.logger.error(
        `Stripe session ${sessionId} metadata does not match payment ${payment.id}.`,
      );
      return null;
    }
    return payment;
  }

  // ------------------------------------------------------------------ PayPal

  private async paypalEvent(type: string, event: Json): Promise<boolean> {
    const resource = (pick(event, 'resource') ?? {}) as Json;
    switch (type) {
      case 'CHECKOUT.ORDER.APPROVED': {
        const orderId = str(resource.id);
        const payment = orderId
          ? await this.prisma.payment.findUnique({
              where: { method_providerRef: { method: 'paypal', providerRef: orderId } },
            })
          : null;
        if (!payment || payment.status !== 'pending') return false;
        await this.capturePayPal(payment);
        return true;
      }
      case 'PAYMENT.CAPTURE.COMPLETED': {
        const payment = await this.paypalPaymentForCapture(resource);
        if (!payment || resource.status !== 'COMPLETED') return false;
        const currency = str(pick(resource, 'amount.currency_code'));
        const amount = currency ? this.amount(pick(resource, 'amount.value')) : -1;
        await this.payments.markSucceeded(payment.id, str(resource.id) || null, amount, currency);
        return true;
      }
      case 'PAYMENT.CAPTURE.DENIED':
      case 'PAYMENT.CAPTURE.DECLINED': {
        const payment = await this.paypalPaymentForCapture(resource);
        if (!payment) return false;
        await this.payments.markFailed(payment.id, 'failed', 'capture_denied');
        return true;
      }
      case 'PAYMENT.CAPTURE.REFUNDED': {
        const captureId = this.capturedIdFromRefund(resource);
        const payment = captureId
          ? await this.prisma.payment.findFirst({
              where: { method: 'paypal', providerPaymentId: captureId },
            })
          : null;
        if (!payment) return false;
        const value = pick(resource, 'amount.value');
        await this.payments.markRefunded(payment.id, value === undefined ? 0 : this.amount(value));
        return true;
      }
    }
    return false;
  }

  /** Server-side capture (the parent's return, or the ORDER.APPROVED webhook). */
  async capturePayPal(payment: Payment): Promise<Payment> {
    if (payment.status !== 'pending') return payment;
    const result = await this.paypal.capture(
      payment.providerRef ?? '',
      `capture-${payment.idempotencyKey ?? payment.id}`,
    );
    if (result.customId !== null && result.customId !== String(payment.id)) {
      this.logger.error(`PayPal custom_id does not match payment ${payment.id}.`);
      return payment;
    }
    if (result.status === 'COMPLETED' && result.amountMinor !== null) {
      return this.payments.markSucceeded(
        payment.id,
        result.captureId,
        result.amountMinor,
        result.currency ?? '',
      );
    }
    if (result.status === 'DECLINED' || result.status === 'FAILED') {
      return this.payments.markFailed(
        payment.id,
        'failed',
        `capture_${result.status.toLowerCase()}`,
      );
    }
    // PENDING (e.g. eCheck): the CAPTURE.COMPLETED webhook finishes it.
    return this.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  }

  private async paypalPaymentForCapture(capture: Json): Promise<Payment | null> {
    const customId = str(capture.custom_id);
    const orderId = str(pick(capture, 'supplementary_data.related_ids.order_id'));
    if (/^\d{1,10}$/.test(customId)) {
      const payment = await this.prisma.payment.findFirst({
        where: { id: Number(customId), method: 'paypal' },
      });
      if (payment && (!orderId || orderId === payment.providerRef)) return payment;
    }
    return orderId
      ? this.prisma.payment.findUnique({
          where: { method_providerRef: { method: 'paypal', providerRef: orderId } },
        })
      : null;
  }

  private capturedIdFromRefund(refund: Json): string | null {
    const links = refund.links;
    if (!Array.isArray(links)) return null;
    for (const link of links) {
      if (pick(link, 'rel') !== 'up') continue;
      const m = /\/captures\/([^/?]+)/.exec(str(pick(link, 'href')));
      if (m) return m[1]!;
    }
    return null;
  }

  /** A provider decimal (`"60.00"`) in minor units; anything unparsable never matches (-1). */
  private amount(value: unknown): number {
    try {
      return toMinor(str(value));
    } catch {
      return -1;
    }
  }
}
