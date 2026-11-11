import { HttpStatus, Injectable } from '@nestjs/common';
import {
  BILLING_ERROR_MESSAGES,
  isEditableInvoice,
  isOpenInvoice,
  percentOf,
  toMinor,
} from '@qarabic/shared';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { ApiException, notFound } from '../common/errors.js';
import { type Invoice, Prisma } from '../generated/prisma/client.js';
import type { InvoiceLineType } from '../generated/prisma/enums.js';
import type { Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, fromDbDate, localDate, toDbDate } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { BillingConfig } from './billing.config.js';
import { billingError } from './errors.js';
import { BILLING_EVENT, invoiceEvent } from './events.js';
import { type FamilyFee, FamilyFeeCalculator, feeFamilyInclude, type FeeLine } from './fees.js';
import { dec, minor } from './money.js';
import { BillingNotifier } from './notifier.js';
import { BillingPeriod } from './period.js';

export interface RunRow extends FamilyFee {
  familyId: number;
  familyName: string;
  children: number;
  periodStart: string;
  periodEnd: string;
  existingInvoiceId: number | null;
  willIssue: boolean;
}

export interface RunResult {
  issued: number[];
  skipped: Array<{ familyId: number; reason: string }>;
}

export interface ManualLine {
  description: string;
  amount: string;
  studentId?: number | null | undefined;
}

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export const balanceMinor = (i: Pick<Invoice, 'total' | 'paid'>) =>
  Math.max(0, minor(i.total) - minor(i.paid));

/**
 * Every invoice state change (Laravel `InvoiceService`, docs/20 §4, D83). Each mutation runs in a
 * transaction holding the invoice row lock; totals and status come only from `recalculate()`.
 * Emails go out after the commit (and only while `billing.notify_parents` is on).
 */
@Injectable()
export class InvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fees: FamilyFeeCalculator,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly config: BillingConfig,
    private readonly notifier: BillingNotifier,
  ) {}

  /** Today in the academy's zone (`YYYY-MM-DD`). */
  async today(): Promise<string> {
    return localDate(this.clock.nowMs(), await this.settings.get('academy.timezone'));
  }

  // ------------------------------------------------------------------ monthly run

  /** Families that would get an invoice for the period, with amounts and warnings. Writes nothing. */
  async preview(month: string, day: 1 | 15, familyIds?: number[]): Promise<RunRow[]> {
    const period = BillingPeriod.of(month, day);
    const families = await this.prisma.family.findMany({
      where: {
        status: 'regular',
        archivedAt: null,
        billingProfile: {
          enabled: true,
          billingDay: day,
        },
        ...(familyIds ? { id: { in: familyIds } } : {}),
      },
      include: feeFamilyInclude,
      orderBy: { id: 'asc' },
    });
    const existing = await this.prisma.invoice.findMany({
      where: { periodKey: { in: families.map((f) => period.key(f.id)) } },
      select: { id: true, periodKey: true },
    });
    const byKey = new Map(existing.map((e) => [e.periodKey, e.id]));
    return families.map((family) => {
      const fee = this.fees.forPeriod(family, period);
      const existingInvoiceId = byKey.get(period.key(family.id)) ?? null;
      return {
        ...fee,
        familyId: family.id,
        familyName: family.user.name,
        children: family.students.length,
        periodStart: period.start,
        periodEnd: period.end,
        existingInvoiceId,
        willIssue: existingInvoiceId === null && fee.lines.length > 0 && fee.totalMinor > 0,
      };
    });
  }

  /**
   * Issues the period's invoices. Idempotent: a family that already has the period is skipped, even
   * when two runs race (unique `period_key`).
   */
  async run(
    month: string,
    day: 1 | 15,
    dueDate: string,
    actor: AuthUser | null,
    familyIds?: number[],
  ): Promise<RunResult> {
    const period = BillingPeriod.of(month, day);
    const result: RunResult = { issued: [], skipped: [] };
    for (const row of await this.preview(month, day, familyIds)) {
      if (!row.willIssue) {
        result.skipped.push({
          familyId: row.familyId,
          reason: row.existingInvoiceId ? 'exists' : (row.warnings[0] ?? 'no_fee'),
        });
        continue;
      }
      try {
        const id = await this.prisma.$transaction(async (tx) => {
          const invoice = await tx.invoice.create({
            data: {
              familyId: row.familyId,
              kind: 'monthly',
              status: 'draft',
              periodStart: toDbDate(period.start),
              periodEnd: toDbDate(period.end),
              periodKey: period.key(row.familyId),
              currency: row.currency!,
              dueDate: toDbDate(dueDate),
              createdById: actor?.id ?? null,
            },
          });
          await this.createLines(tx, invoice.id, row.lines, actor?.id ?? null);
          await this.issueLocked(tx, invoice, actor);
          return invoice.id;
        });
        result.issued.push(id);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        result.skipped.push({ familyId: row.familyId, reason: 'exists' });
      }
    }
    if (result.issued.length) {
      await this.audit.record({
        actorId: actor?.id ?? null,
        action: 'invoice_run',
        subjectType: 'invoice',
        subjectId: null,
        after: { period: period.start, day, dueDate, issued: result.issued.length },
      });
    }
    await this.notifier.issued(result.issued);
    return result;
  }

  private async createLines(tx: Tx, invoiceId: number, lines: FeeLine[], by: number | null) {
    for (const line of lines) {
      await tx.invoiceLine.create({
        data: {
          invoiceId,
          type: line.type,
          studentId: line.studentId,
          feePackageId: line.feePackageId,
          description: line.description,
          amount: dec(line.amountMinor),
          meta: line.meta as Prisma.InputJsonValue,
          createdById: by,
          createdAt: this.clock.now(),
        },
      });
    }
  }

  // ------------------------------------------------------------------ manual invoice

  /** CSR (`invoices.request` only) creates a draft; billing may issue at once (D87). */
  async createManual(
    familyId: number,
    lines: ManualLine[],
    dueDate: string | null,
    notes: string | null,
    actor: AuthUser,
    issue: boolean,
  ): Promise<number> {
    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      include: { billingProfile: true, students: { select: { id: true } } },
    });
    if (!family) throw notFound();
    const ids = new Set(family.students.map((s) => s.id));
    const errors: Record<string, string[]> = {};
    lines.forEach((l, i) => {
      if (l.studentId && !ids.has(l.studentId)) {
        errors[`lines.${i}.studentId`] = ['Unknown student for this family.'];
      }
    });
    if (Object.keys(errors).length) {
      throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
        message: BILLING_ERROR_MESSAGES.unknown_student.en,
        code: 'unknown_student',
        errors,
      });
    }
    const currency = family.billingProfile?.currency;
    if (!currency) throw billingError('missing_currency', 'familyId');

    const invoiceId = await this.prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          familyId,
          kind: 'manual',
          status: 'draft',
          currency,
          dueDate: dueDate ? toDbDate(dueDate) : null,
          notes,
          createdById: actor.id,
        },
      });
      for (const line of lines) {
        await tx.invoiceLine.create({
          data: {
            invoiceId: invoice.id,
            type: 'manual',
            studentId: line.studentId ?? null,
            description: line.description,
            amount: line.amount,
            createdById: actor.id,
            createdAt: this.clock.now(),
          },
        });
      }
      const fresh = await this.recalculate(tx, invoice);
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'invoice_created',
          subjectType: 'invoice',
          subjectId: invoice.id,
          after: { familyId, kind: 'manual', total: dec(minor(fresh.total)), issue },
        },
        tx,
      );
      if (issue) await this.issueLocked(tx, fresh, actor);
      return invoice.id;
    });
    if (issue) await this.notifier.issued([invoiceId]);
    return invoiceId;
  }

  // ------------------------------------------------------------------ lifecycle

  async issue(id: number, actor: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const invoice = await this.lock(tx, id);
      if (invoice.status !== 'draft') throw billingError('not_draft', 'status');
      await this.issueLocked(tx, invoice, actor);
    });
    await this.notifier.issued([id]);
  }

  private async issueLocked(tx: Tx, draft: Invoice, actor: AuthUser | null): Promise<Invoice> {
    let invoice = await this.recalculate(tx, draft);
    if ((await tx.invoiceLine.count({ where: { invoiceId: invoice.id } })) === 0) {
      throw billingError('empty_invoice', 'lines');
    }
    const st = await this.settings.all();
    const today = localDate(this.clock.nowMs(), st['academy.timezone']);
    const now = this.clock.now();
    invoice = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        number: await this.nextNumber(tx, Number(today.slice(0, 4))),
        status: 'issued',
        issueDate: toDbDate(today),
        dueDate: invoice.dueDate ?? toDbDate(addDays(today, st['billing.default_due_days'])),
        issuedAt: now,
        issuedById: actor?.id ?? null,
        lockVersion: { increment: 1 },
      },
    });
    invoice = await this.recalculate(tx, invoice);
    await invoiceEvent(tx, BILLING_EVENT.invoiceIssued, invoice, minor(invoice.total), now);
    await this.audit.record(
      {
        actorId: actor?.id ?? null,
        action: 'invoice_issued',
        subjectType: 'invoice',
        subjectId: invoice.id,
        after: {
          number: invoice.number,
          total: dec(minor(invoice.total)),
          currency: invoice.currency,
        },
      },
      tx,
    );
    return invoice;
  }

  /** Adjustment (signed) or discount (amount or percent of the current total): always a new line. */
  async addLine(
    id: number,
    input: {
      type: 'adjustment' | 'discount';
      amount?: string | undefined;
      percent?: string | undefined;
      reason: string;
    },
    actor: AuthUser,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      let invoice = await this.lock(tx, id);
      if (!isEditableInvoice(invoice.status)) throw billingError('not_editable', 'status');
      const total = minor(invoice.total);
      let amount: number;
      if (input.type === 'discount') {
        amount =
          input.percent !== undefined
            ? -percentOf(total, input.percent)
            : -Math.abs(toMinor(input.amount ?? '0'));
      } else {
        amount = toMinor(input.amount ?? '0');
      }
      if (amount === 0) throw billingError('zero_amount', 'amount');
      if (total + amount < minor(invoice.paid) || total + amount < 0) {
        throw billingError('below_paid', 'amount');
      }
      const now = this.clock.now();
      await tx.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
          type: input.type,
          description: input.reason,
          amount: dec(amount),
          meta: input.percent !== undefined ? { percent: input.percent } : Prisma.DbNull,
          createdById: actor.id,
          createdAt: now,
        },
      });
      invoice = await this.recalculate(tx, invoice);
      if (invoice.status !== 'draft') {
        await invoiceEvent(tx, BILLING_EVENT.invoiceAdjusted, invoice, amount, now, {
          lineType: input.type,
          reason: input.reason,
        });
      }
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'invoice_line_added',
          subjectType: 'invoice',
          subjectId: invoice.id,
          after: { type: input.type, amount: dec(amount), percent: input.percent ?? null },
          reason: input.reason,
        },
        tx,
      );
    });
  }

  async void(id: number, reason: string, actor: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const invoice = await this.lock(tx, id);
      if (!isEditableInvoice(invoice.status)) throw billingError('not_editable', 'status');
      if (await this.hasSucceededPayments(tx, invoice.id))
        throw billingError('has_payments', 'status');
      const wasIssued = invoice.status !== 'draft';
      const now = this.clock.now();
      const voided = await tx.invoice.update({
        where: { id },
        data: {
          status: 'void',
          voidedAt: now,
          voidedById: actor.id,
          voidReason: reason,
          // The family can be billed for this period again.
          periodKey: null,
          lockVersion: { increment: 1 },
        },
      });
      await this.cancelPendingPayments(tx, id);
      if (wasIssued) {
        await invoiceEvent(tx, BILLING_EVENT.invoiceVoided, voided, -minor(voided.total), now, {
          reason,
        });
      }
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'invoice_voided',
          subjectType: 'invoice',
          subjectId: id,
          before: { status: invoice.status },
          after: { status: 'void' },
          reason,
        },
        tx,
      );
    });
  }

  /** Splits an open, unpaid invoice into 2–6 issued parts that sum to its total (docs/20 §4.5). */
  async split(
    id: number,
    parts: Array<{ amount: string; dueDate: string }>,
    reason: string,
    actor: AuthUser,
  ): Promise<number[]> {
    const created = await this.prisma.$transaction(async (tx) => {
      const invoice = await this.lock(tx, id);
      if (
        !isOpenInvoice(invoice.status) ||
        minor(invoice.paid) > 0 ||
        (await this.hasSucceededPayments(tx, invoice.id))
      ) {
        throw billingError('split_not_allowed', 'status');
      }
      const total = minor(invoice.total);
      if (parts.reduce((s, p) => s + toMinor(p.amount), 0) !== total) {
        throw billingError('split_sum', 'parts', HttpStatus.UNPROCESSABLE_ENTITY, {
          total: dec(total),
        });
      }
      const now = this.clock.now();
      const closed = await tx.invoice.update({
        where: { id },
        data: {
          status: 'split',
          periodKey: null,
          voidReason: reason,
          lockVersion: { increment: 1 },
        },
      });
      await this.cancelPendingPayments(tx, id);
      await invoiceEvent(tx, BILLING_EVENT.invoiceVoided, closed, -total, now, {
        reason: 'split',
        note: reason,
      });
      const ids: number[] = [];
      for (const [i, part] of parts.entries()) {
        const child = await tx.invoice.create({
          data: {
            familyId: invoice.familyId,
            kind: 'split',
            status: 'draft',
            periodStart: invoice.periodStart,
            periodEnd: invoice.periodEnd,
            currency: invoice.currency,
            dueDate: toDbDate(part.dueDate),
            splitFromId: invoice.id,
            notes: reason,
            createdById: actor.id,
          },
        });
        await tx.invoiceLine.create({
          data: {
            invoiceId: child.id,
            type: 'split',
            description: `Part ${i + 1} of ${parts.length} of invoice ${invoice.number ?? invoice.id}`,
            amount: part.amount,
            meta: { splitFrom: invoice.number, part: i + 1, parts: parts.length },
            createdById: actor.id,
            createdAt: now,
          },
        });
        ids.push((await this.issueLocked(tx, child, actor)).id);
      }
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'invoice_split',
          subjectType: 'invoice',
          subjectId: id,
          after: { parts: ids },
          reason,
        },
        tx,
      );
      return ids;
    });
    await this.notifier.issued(created);
    return created;
  }

  /** Totals from lines, paid from succeeded payments, the open status from both (docs/20 §4.6). */
  async recalculate(tx: Tx, invoice: Invoice): Promise<Invoice> {
    const sums = await tx.invoiceLine.groupBy({
      by: ['type'],
      where: { invoiceId: invoice.id },
      _sum: { amount: true },
    });
    const of = (type: InvoiceLineType) => minor(sums.find((s) => s.type === type)?._sum.amount);
    const paidAgg = await tx.payment.aggregate({
      where: { invoiceId: invoice.id, status: 'succeeded' },
      _sum: { amount: true },
    });
    const subtotal = of('package') + of('manual') + of('split');
    const adjustments = of('adjustment');
    const discounts = of('discount');
    const total = subtotal + adjustments + discounts;
    const paid = minor(paidAgg._sum.amount);

    const next: Partial<Record<'status', Invoice['status']>> & { paidAt?: Date | null } = {};
    if (isOpenInvoice(invoice.status) || invoice.status === 'paid') {
      next.status = paid >= total ? 'paid' : paid > 0 ? 'partially_paid' : 'issued';
      if (next.status === 'paid' && !invoice.paidAt) next.paidAt = this.clock.now();
      else if (next.status !== 'paid') next.paidAt = null;
    }
    const changed =
      minor(invoice.subtotal) !== subtotal ||
      minor(invoice.adjustments) !== adjustments ||
      minor(invoice.discounts) !== discounts ||
      minor(invoice.total) !== total ||
      minor(invoice.paid) !== paid ||
      (next.status !== undefined && next.status !== invoice.status) ||
      (next.paidAt !== undefined &&
        (next.paidAt?.getTime() ?? null) !== (invoice.paidAt?.getTime() ?? null));
    if (!changed) return invoice;
    return tx.invoice.update({
      where: { id: invoice.id },
      data: {
        subtotal: dec(subtotal),
        adjustments: dec(adjustments),
        discounts: dec(discounts),
        total: dec(total),
        paid: dec(paid),
        ...next,
        lockVersion: { increment: 1 },
      },
    });
  }

  /** Re-reads the invoice with a write lock inside the caller's transaction (404 when missing). */
  async lock(tx: Tx, id: number): Promise<Invoice> {
    const rows = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM "invoices" WHERE id = ${id} FOR UPDATE`;
    if (!rows.length) throw notFound();
    return tx.invoice.findUniqueOrThrow({ where: { id } });
  }

  private async hasSucceededPayments(tx: Tx, invoiceId: number): Promise<boolean> {
    return (await tx.payment.count({ where: { invoiceId, status: 'succeeded' } })) > 0;
  }

  private async cancelPendingPayments(tx: Tx, invoiceId: number): Promise<void> {
    await tx.payment.updateMany({
      where: { invoiceId, status: 'pending' },
      data: { status: 'cancelled', failureReason: 'invoice_closed' },
    });
  }

  /** Gap-free yearly counter under a row lock: `INV-2026-000123`. */
  private async nextNumber(tx: Tx, year: number): Promise<string> {
    await tx.$executeRaw`
      INSERT INTO "invoice_sequences" (year, last_number) VALUES (${year}, 0) ON CONFLICT DO NOTHING`;
    const [row] = await tx.$queryRaw<Array<{ last_number: number }>>`
      UPDATE "invoice_sequences" SET last_number = last_number + 1 WHERE year = ${year}
      RETURNING last_number`;
    return `${this.config.invoicePrefix}-${year}-${String(row!.last_number).padStart(6, '0')}`;
  }

  /** A fresh idempotency key for a provider call. */
  static idempotencyKey(): string {
    return randomUUID();
  }

  /** `YYYY-MM-DD` of a date column (null-safe). */
  static date(value: Date | null): string | null {
    return value ? fromDbDate(value) : null;
  }
}
