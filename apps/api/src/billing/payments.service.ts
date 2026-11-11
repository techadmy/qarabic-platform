import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  invoicePath,
  isOpenInvoice,
  type ManualPaymentMethod,
  ONLINE_PAYMENT_METHODS,
  type OnlinePaymentMethod,
  toMinor,
} from '@qarabic/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound, validationError } from '../common/errors.js';
import { ENV, type Env } from '../config/env.js';
import type { Payment } from '../generated/prisma/client.js';
import type { PaymentStatus } from '../generated/prisma/enums.js';
import type { Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { localDate, MINUTE, toUtc } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { billingError } from './errors.js';
import { BILLING_EVENT, paymentEvent } from './events.js';
import { GatewayError, type PaymentGateway, PayPalGateway, StripeGateway } from './gateways.js';
import { balanceMinor, InvoiceService } from './invoices.service.js';
import { dec, minor } from './money.js';

/** A pending attempt younger than this is reused instead of creating another one. */
export const REUSE_MINUTES = 30;

export interface ManualPaymentInput {
  method: ManualPaymentMethod;
  amount: string;
  receivedOn: string;
  reference?: string | null | undefined;
  note?: string | null | undefined;
}

/**
 * Money in (Laravel `PaymentService`, docs/20 §7). Manual payments are recorded by billing staff;
 * online payments are started here and completed only by the provider's confirmed outcome.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoiceService,
    private readonly stripe: StripeGateway,
    private readonly paypal: PayPalGateway,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  gateway(method: OnlinePaymentMethod): PaymentGateway {
    return method === 'stripe' ? this.stripe : this.paypal;
  }

  enabledProviders(): OnlinePaymentMethod[] {
    return ONLINE_PAYMENT_METHODS.filter((m) => this.gateway(m).enabled());
  }

  // ------------------------------------------------------------------ manual

  async recordManual(
    invoiceId: number,
    input: ManualPaymentInput,
    actor: AuthUser,
  ): Promise<number> {
    const zone = await this.settings.get('academy.timezone');
    if (input.receivedOn > localDate(this.clock.nowMs(), zone)) {
      throw validationError({ receivedOn: ['The date received cannot be in the future.'] });
    }
    return this.prisma.$transaction(async (tx) => {
      const invoice = await this.invoices.lock(tx, invoiceId);
      if (!isOpenInvoice(invoice.status)) throw billingError('not_open', 'invoice');
      const amount = toMinor(input.amount);
      if (amount > balanceMinor(invoice)) throw billingError('over_balance', 'amount');
      const now = this.clock.now();
      const payment = await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          familyId: invoice.familyId,
          method: input.method,
          status: 'succeeded',
          amount: dec(amount),
          currency: invoice.currency,
          reference: input.reference ?? null,
          note: input.note ?? null,
          receivedAt: new Date(toUtc(input.receivedOn, '12:00', zone)),
          recordedById: actor.id,
          createdAt: now,
        },
      });
      await this.invoices.recalculate(tx, invoice);
      await paymentEvent(tx, BILLING_EVENT.paymentSucceeded, payment, amount, now);
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'payment_recorded',
          subjectType: 'payment',
          subjectId: payment.id,
          after: {
            invoiceId,
            method: input.method,
            amount: dec(amount),
            currency: invoice.currency,
          },
        },
        tx,
      );
      return payment.id;
    });
  }

  /** Reverses a wrongly recorded manual payment (reason required). Online ones are refunded at the provider. */
  async voidManual(paymentId: number, reason: string, actor: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!found) throw notFound();
      const invoice = await this.invoices.lock(tx, found.invoiceId);
      const payment = await this.lockPayment(tx, paymentId);
      if (
        ONLINE_PAYMENT_METHODS.includes(payment.method as OnlinePaymentMethod) ||
        payment.status !== 'succeeded'
      ) {
        throw billingError('payment_not_voidable', 'payment');
      }
      const now = this.clock.now();
      const voided = await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'cancelled', failureReason: reason, refundedAt: now },
      });
      await this.invoices.recalculate(tx, invoice);
      await paymentEvent(tx, BILLING_EVENT.paymentRefunded, voided, -minor(voided.amount), now, {
        reason: 'void',
        note: reason,
        by: actor.id,
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'payment_voided',
          subjectType: 'payment',
          subjectId: paymentId,
          before: { status: 'succeeded' },
          after: { status: 'cancelled' },
          reason,
        },
        tx,
      );
    });
  }

  // ------------------------------------------------------------------ online

  /** Starts (or reuses) a hosted checkout for the invoice's current balance. */
  async startCheckout(
    invoiceId: number,
    method: OnlinePaymentMethod,
    actor: AuthUser,
  ): Promise<Payment> {
    const gateway = this.gateway(method);
    if (!gateway.enabled()) throw billingError('provider_unavailable', 'provider');
    const now = this.clock.now();

    const payment = await this.prisma.$transaction(async (tx) => {
      const invoice = await this.invoices.lock(tx, invoiceId);
      const balance = balanceMinor(invoice);
      if (!isOpenInvoice(invoice.status) || balance <= 0) throw billingError('not_open', 'invoice');
      const reuse = await tx.payment.findFirst({
        where: {
          invoiceId,
          method,
          status: 'pending',
          amount: dec(balance),
          checkoutUrl: { not: null },
          createdAt: { gte: new Date(now.getTime() - REUSE_MINUTES * MINUTE) },
        },
        orderBy: { id: 'desc' },
      });
      if (reuse) return reuse;
      return tx.payment.create({
        data: {
          invoiceId,
          familyId: invoice.familyId,
          method,
          status: 'pending',
          amount: dec(balance),
          currency: invoice.currency,
          initiatedById: actor.id,
          idempotencyKey: randomUUID(),
          createdAt: now,
        },
      });
    });
    if (payment.checkoutUrl) return payment;

    const invoice = await this.prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const base = `${this.env.APP_URL.replace(/\/+$/, '')}${invoicePath(invoiceId)}`;
    try {
      const checkout = await gateway.createCheckout({
        paymentId: payment.id,
        invoiceId,
        invoiceNumber: invoice.number,
        amountMinor: minor(payment.amount),
        currency: payment.currency,
        idempotencyKey: payment.idempotencyKey ?? randomUUID(),
        email: actor.email,
        returnUrl: `${base}?checkout=return&provider=${method}`,
        cancelUrl: `${base}?checkout=cancelled`,
      });
      return await this.prisma.payment.update({
        where: { id: payment.id },
        data: { providerRef: checkout.ref, checkoutUrl: checkout.url },
      });
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      this.logger.warn(`Checkout failed (payment ${payment.id}, ${method}): ${error.message}`);
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'failed', failureReason: 'checkout_failed' },
      });
      throw billingError('provider_error', 'provider');
    }
  }

  /** The provider confirmed the money. Idempotent; the amount and currency must match the attempt. */
  async markSucceeded(
    paymentId: number,
    providerPaymentId: string | null,
    amountMinor: number,
    currency: string,
  ): Promise<Payment> {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const invoice = await this.invoices.lock(tx, found.invoiceId);
      const payment = await this.lockPayment(tx, paymentId);
      if (payment.status === 'succeeded' || payment.status === 'refunded') return payment;
      if (amountMinor !== minor(payment.amount) || currency.toUpperCase() !== payment.currency) {
        this.logger.error(
          `Payment ${payment.id} amount mismatch: expected ${dec(minor(payment.amount))} ${payment.currency}`,
        );
        return tx.payment.update({
          where: { id: paymentId },
          data: { status: 'failed', failureReason: 'amount_mismatch', providerPaymentId },
        });
      }
      const now = this.clock.now();
      const done = await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'succeeded', providerPaymentId, receivedAt: now, failureReason: null },
      });
      const after = await this.invoices.recalculate(tx, invoice);
      if (after.status !== 'paid' && after.status !== 'partially_paid') {
        // Money arrived for a void / split invoice (rare race): keep it; staff refund or move it.
        this.logger.warn(
          `Payment ${paymentId} for a closed invoice ${invoice.id} (${after.status}).`,
        );
      }
      await paymentEvent(tx, BILLING_EVENT.paymentSucceeded, done, minor(done.amount), now);
      return done;
    });
  }

  async markFailed(paymentId: number, status: PaymentStatus, reason: string): Promise<Payment> {
    return this.prisma.$transaction(async (tx) => {
      const payment = await this.lockPayment(tx, paymentId);
      if (payment.status !== 'pending') return payment;
      return tx.payment.update({
        where: { id: paymentId },
        data: { status, failureReason: reason },
      });
    });
  }

  /** Full refund done at the provider: the invoice is open again. A partial refund is flagged only (B42). */
  async markRefunded(paymentId: number, refundedMinor: number): Promise<Payment> {
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const invoice = await this.invoices.lock(tx, found.invoiceId);
      const payment = await this.lockPayment(tx, paymentId);
      if (payment.status !== 'succeeded') return payment;
      if (refundedMinor < minor(payment.amount)) {
        this.logger.warn(`Partial refund of payment ${paymentId} needs review.`);
        return tx.payment.update({
          where: { id: paymentId },
          data: {
            note: `${payment.note ?? ''}\nPartial refund ${dec(refundedMinor)} at the provider: needs review.`.trim(),
          },
        });
      }
      const now = this.clock.now();
      const refunded = await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'refunded', refundedAt: now },
      });
      await this.invoices.recalculate(tx, invoice);
      await paymentEvent(
        tx,
        BILLING_EVENT.paymentRefunded,
        refunded,
        -minor(refunded.amount),
        now,
        {
          reason: 'provider_refund',
        },
      );
      return refunded;
    });
  }

  private async lockPayment(tx: Tx, id: number): Promise<Payment> {
    await tx.$queryRaw`SELECT id FROM "payments" WHERE id = ${id} FOR UPDATE`;
    return tx.payment.findUniqueOrThrow({ where: { id } });
  }
}
