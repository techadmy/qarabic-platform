import type {
  FamilyFeeDto,
  FeePackageDto,
  InvoiceDetailDto,
  InvoiceDto,
  PackageUsageDto,
  PaymentDto,
} from '@qarabic/shared';
import { fromMinor, isEditableInvoice, isOpenInvoice } from '@qarabic/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { fromDbDate } from '../schedule/time.js';
import type { FamilyFee } from './fees.js';
import { amountOf, minor } from './money.js';
import type { BillingPeriod } from './period.js';

export const invoiceListInclude = {
  family: { select: { id: true, user: { select: { name: true } } } },
} satisfies Prisma.InvoiceInclude;
export type InvoiceListRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceListInclude }>;

export const invoiceDetailInclude = {
  ...invoiceListInclude,
  lines: { orderBy: { id: 'asc' }, include: { student: { select: { id: true, name: true } } } },
  payments: {
    orderBy: { id: 'asc' },
    include: { recordedBy: { select: { id: true, name: true } } },
  },
  splitFrom: { select: { id: true, number: true } },
  splits: { orderBy: { id: 'asc' } },
} satisfies Prisma.InvoiceInclude;
export type InvoiceDetailRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceDetailInclude }>;

const date = (v: Date | null) => (v ? fromDbDate(v) : null);
const iso = (v: Date | null) => (v ? v.toISOString() : null);

/** Open and past its due date (`today` = academy-local date). */
export const isOverdue = (
  i: { status: InvoiceDto['status']; dueDate: Date | null },
  today: string,
): boolean => isOpenInvoice(i.status) && !!i.dueDate && fromDbDate(i.dueDate) < today;

export function invoiceDto(i: InvoiceListRow, today: string): InvoiceDto {
  return {
    id: i.id,
    number: i.number,
    kind: i.kind,
    status: i.status,
    isOverdue: isOverdue(i, today),
    family: { id: i.family.id, name: i.family.user.name },
    currency: i.currency,
    periodStart: date(i.periodStart),
    periodEnd: date(i.periodEnd),
    issueDate: date(i.issueDate),
    dueDate: date(i.dueDate),
    subtotal: amountOf(i.subtotal),
    adjustments: amountOf(i.adjustments),
    discounts: amountOf(i.discounts),
    total: amountOf(i.total),
    paid: amountOf(i.paid),
    balance: fromMinor(Math.max(0, minor(i.total) - minor(i.paid))),
    paidAt: iso(i.paidAt),
    createdAt: i.createdAt.toISOString(),
  };
}

type PaymentRow = InvoiceDetailRow['payments'][number];

export function paymentDto(p: PaymentRow, staff: boolean): PaymentDto {
  return {
    id: p.id,
    invoiceId: p.invoiceId,
    method: p.method,
    status: p.status,
    amount: amountOf(p.amount),
    currency: p.currency,
    reference: p.reference,
    receivedAt: iso(p.receivedAt),
    refundedAt: iso(p.refundedAt),
    createdAt: p.createdAt.toISOString(),
    receiptNumber: p.status === 'succeeded' ? `RC-${String(p.id).padStart(6, '0')}` : null,
    unapplied: amountOf(p.unapplied),
    needsReview: p.needsReview,
    reviewReason: p.reviewReason,
    ...(staff
      ? {
          note: p.note,
          failureReason: p.failureReason,
          providerPaymentId: p.providerPaymentId,
          recordedBy: p.recordedBy ? { id: p.recordedBy.id, name: p.recordedBy.name } : null,
        }
      : {}),
  };
}

const PARENT_PAYMENT_STATUSES = new Set(['succeeded', 'refunded', 'pending']);

export function invoiceDetailDto(
  i: InvoiceDetailRow,
  today: string,
  viewer: { staff: boolean; manage: boolean },
  usage: PackageUsageDto[],
): InvoiceDetailDto {
  const paid = minor(i.paid);
  const balance = Math.max(0, minor(i.total) - paid);
  const staffManage = viewer.staff && viewer.manage;
  return {
    ...invoiceDto(i, today),
    notes: i.notes,
    voidReason: i.voidReason,
    voidedAt: iso(i.voidedAt),
    lines: i.lines.map((l) => ({
      id: l.id,
      type: l.type,
      student: l.student ? { id: l.student.id, name: l.student.name } : null,
      description: l.description,
      amount: amountOf(l.amount),
      meta: (l.meta ?? null) as Record<string, unknown> | null,
      createdAt: l.createdAt.toISOString(),
    })),
    payments: i.payments
      .filter((p) => viewer.staff || PARENT_PAYMENT_STATUSES.has(p.status))
      .map((p) => paymentDto(p, viewer.staff)),
    splitFrom: i.splitFrom ? { id: i.splitFrom.id, number: i.splitFrom.number } : null,
    splits: i.splits.map((s) => ({
      id: s.id,
      number: s.number,
      status: s.status,
      total: amountOf(s.total),
      dueDate: date(s.dueDate),
    })),
    usage,
    can: {
      pay: !viewer.staff && isOpenInvoice(i.status) && balance > 0,
      issue: staffManage && i.status === 'draft',
      edit: staffManage && isEditableInvoice(i.status),
      recordPayment: staffManage && isOpenInvoice(i.status),
      split: staffManage && isOpenInvoice(i.status) && paid === 0,
      void: staffManage && isEditableInvoice(i.status) && paid === 0,
      remind: staffManage && isOpenInvoice(i.status),
    },
  };
}

export function feeDto(fee: FamilyFee, period: BillingPeriod): FamilyFeeDto {
  return {
    periodStart: period.start,
    periodEnd: period.end,
    currency: fee.currency,
    total: fromMinor(fee.totalMinor),
    lines: fee.lines.map((l) => ({
      type: l.type,
      studentId: l.studentId,
      feePackageId: l.feePackageId,
      description: l.description,
      amount: fromMinor(l.amountMinor),
      meta: l.meta,
    })),
    warnings: fee.warnings,
  };
}

export const feePackageInclude = {
  prices: { orderBy: { currency: 'asc' } },
  _count: { select: { students: true } },
} satisfies Prisma.FeePackageInclude;
type FeePackageRow = Prisma.FeePackageGetPayload<{ include: typeof feePackageInclude }>;

export function feePackageDto(p: FeePackageRow): FeePackageDto {
  return {
    id: p.id,
    name: p.name,
    classesPerWeek: p.classesPerWeek,
    sessionMinutes: p.sessionMinutes,
    description: p.description,
    isActive: p.isActive,
    prices: p.prices.map((x) => ({
      currency: x.currency as FeePackageDto['prices'][number]['currency'],
      monthlyAmount: amountOf(x.monthlyAmount),
    })),
    studentsCount: p._count.students,
  };
}
