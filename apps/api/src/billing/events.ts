import type { Invoice, Payment, Prisma } from '../generated/prisma/client.js';
import { fromDbDate } from '../schedule/time.js';
import { dec } from './money.js';

type Tx = Prisma.TransactionClient;

/** Ledger hooks for the accounting milestone (D86): `billing_events` rows in the caller's transaction. */
export const BILLING_EVENT = {
  invoiceIssued: 'invoice.issued',
  invoiceAdjusted: 'invoice.adjusted',
  invoiceVoided: 'invoice.voided',
  paymentSucceeded: 'payment.succeeded',
  paymentRefunded: 'payment.refunded',
} as const;
type EventType = (typeof BILLING_EVENT)[keyof typeof BILLING_EVENT];

export async function invoiceEvent(
  tx: Tx,
  type: EventType,
  invoice: Invoice,
  amountMinor: number,
  at: Date,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await tx.billingEvent.create({
    data: {
      type,
      subjectType: 'invoice',
      subjectId: invoice.id,
      familyId: invoice.familyId,
      amount: dec(amountMinor),
      currency: invoice.currency,
      occurredAt: at,
      payload: {
        ...payload,
        number: invoice.number,
        kind: invoice.kind,
        periodStart: invoice.periodStart ? fromDbDate(invoice.periodStart) : null,
        periodEnd: invoice.periodEnd ? fromDbDate(invoice.periodEnd) : null,
      },
    },
  });
}

export async function paymentEvent(
  tx: Tx,
  type: EventType,
  payment: Payment,
  amountMinor: number,
  at: Date,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await tx.billingEvent.create({
    data: {
      type,
      subjectType: 'payment',
      subjectId: payment.id,
      familyId: payment.familyId,
      amount: dec(amountMinor),
      currency: payment.currency,
      occurredAt: at,
      payload: {
        ...payload,
        invoiceId: payment.invoiceId,
        method: payment.method,
        providerRef: payment.providerRef,
        providerPaymentId: payment.providerPaymentId,
        receivedAt: payment.receivedAt?.toISOString() ?? null,
      },
    },
  });
}
