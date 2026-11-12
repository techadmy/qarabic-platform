import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ADJUSTMENT_STATUSES,
  type AdjustmentDto,
  type adjustmentListQuerySchema,
  type CancelAdjustmentResultDto,
  type createAdjustmentSchema,
  FINE_TYPES,
  isLockedRun,
  type Paginated,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound, validationError } from '../common/errors.js';
import { pageMeta, statusCounts } from '../common/pagination.js';
import type { PayAdjustment, Prisma } from '../generated/prisma/client.js';
import type { Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { forbidden } from '../schedule/scope.js';
import { localDate, toDbDate } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { payrollError } from './errors.js';
import { cents, fromCents } from './money.js';
import { Period } from './period.js';
import { adjustmentCan, adjustmentStatusFor, seesAllFines, seesAllTypes } from './policies.js';
import { adjustmentDto, adjustmentInclude, dateStr } from './presenter.js';
import { lockPayrollRow, PayrollRunsService } from './runs.service.js';

type Ability = 'view' | 'decide' | 'cancel';

/**
 * Fines, bonuses, advances and the other dated pay adjustments (D91; Laravel `AdjustmentService`,
 * `PayAdjustmentPolicy`). The monitor proposes a fine, a manager approves it; every other type is
 * Accounts'. Nothing is deleted: cancel while the month is open, a fine reduction after.
 */
@Injectable()
export class AdjustmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly runs: PayrollRunsService,
  ) {}

  async find(id: number, viewer: AuthUser, ability: Ability = 'view'): Promise<PayAdjustment> {
    const a = await this.prisma.payAdjustment.findUnique({ where: { id } });
    if (!a || !adjustmentCan.view(viewer, a)) throw notFound();
    if (ability === 'decide' && !adjustmentCan.decide(viewer, a)) throw forbidden();
    if (ability === 'cancel' && !adjustmentCan.cancel(viewer, a)) throw forbidden();
    return a;
  }

  async show(id: number, viewer: AuthUser): Promise<AdjustmentDto> {
    await this.find(id, viewer);
    return this.dto(id, viewer);
  }

  async list(
    q: z.output<typeof adjustmentListQuerySchema>,
    viewer: AuthUser,
  ): Promise<Paginated<AdjustmentDto>> {
    const allTypes = seesAllTypes(viewer);
    const allFines = seesAllFines(viewer);
    const and: Prisma.PayAdjustmentWhereInput[] = [];
    if (!allTypes && !allFines) {
      // Own items only, and only decided ones.
      and.push({ userId: viewer.id, status: { in: ['approved', 'cancelled'] } });
    } else if (!allTypes) {
      and.push({ type: { in: [...FINE_TYPES] } });
    }
    if ((allTypes || allFines) && q.userId) and.push({ userId: q.userId });
    if (q.month) {
      const p = Period.parse(q.month);
      and.push({ effectiveOn: { gte: toDbDate(p.startsOn()), lte: toDbDate(p.endsOn()) } });
    }
    if (q.type?.length) and.push({ type: { in: q.type } });
    const base: Prisma.PayAdjustmentWhereInput = { AND: and };
    const where: Prisma.PayAdjustmentWhereInput = q.status
      ? { AND: [...and, { status: q.status }] }
      : base;
    const proposedWhere = { AND: [where, { status: 'proposed' as const }] };
    const restWhere = { AND: [where, { status: { not: 'proposed' as const } }] };
    const order = [{ effectiveOn: 'desc' as const }, { id: 'desc' as const }];
    const [proposedTotal, restTotal, groups] = await Promise.all([
      this.prisma.payAdjustment.count({ where: proposedWhere }),
      this.prisma.payAdjustment.count({ where: restWhere }),
      this.prisma.payAdjustment.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    const skip = (q.page - 1) * q.perPage;
    const first =
      skip < proposedTotal
        ? await this.prisma.payAdjustment.findMany({
            where: proposedWhere,
            include: adjustmentInclude,
            orderBy: order,
            skip,
            take: q.perPage,
          })
        : [];
    const restTake = q.perPage - first.length;
    const second =
      restTake > 0
        ? await this.prisma.payAdjustment.findMany({
            where: restWhere,
            include: adjustmentInclude,
            orderBy: order,
            skip: Math.max(0, skip - proposedTotal),
            take: restTake,
          })
        : [];
    return {
      data: [...first, ...second].map((a) => adjustmentDto(a, viewer)),
      meta: pageMeta(q, proposedTotal + restTotal, statusCounts(ADJUSTMENT_STATUSES, groups)),
    };
  }

  async create(input: z.output<typeof createAdjustmentSchema>, by: AuthUser): Promise<number> {
    const status = adjustmentStatusFor(by, input.type);
    if (!status) throw payrollError(HttpStatus.FORBIDDEN, 'forbidden_type');
    const target = await this.prisma.user.findUnique({ where: { id: input.userId } });
    if (!target) throw validationError({ userId: ['The selected user is invalid.'] });
    if (input.sessionId) {
      const session = await this.prisma.classSession.count({ where: { id: input.sessionId } });
      if (!session) throw validationError({ sessionId: ['The selected class is invalid.'] });
    }
    const profile = await this.prisma.payProfile.findUnique({ where: { userId: target.id } });
    if (!profile) throw payrollError(HttpStatus.UNPROCESSABLE_ENTITY, 'no_pay_profile');
    await this.runs.assertOpen(input.effectiveOn);

    let amount = cents(input.amount ?? '0');
    let quantity: number | null = null;
    if (input.type === 'csr_conversions') {
      quantity = input.quantity ?? 0;
      const rate = cents(profile.csrRate);
      if (rate <= 0) throw payrollError(HttpStatus.UNPROCESSABLE_ENTITY, 'no_csr_rate');
      amount = quantity * rate;
    }
    const currency = profile.currency ?? (await this.settings.get('payroll.default_currency'));

    return this.prisma.$transaction(async (tx) => {
      await this.runs.assertOpen(input.effectiveOn, tx);
      const now = this.clock.now();
      const approved = status === 'approved';
      const a = await tx.payAdjustment.create({
        data: {
          userId: target.id,
          type: input.type,
          amount: fromCents(amount),
          quantity,
          currency,
          effectiveOn: toDbDate(input.effectiveOn),
          reason: input.reason,
          status,
          sessionId: input.sessionId ?? null,
          createdById: by.id,
          decidedById: approved ? by.id : null,
          decidedAt: approved ? now : null,
          createdAt: now,
          updatedAt: now,
        },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'pay_adjustment_created',
          subjectType: 'pay_adjustment',
          subjectId: a.id,
          after: {
            userId: a.userId,
            type: a.type,
            amount: fromCents(amount),
            status,
            effectiveOn: input.effectiveOn,
          },
          reason: input.reason,
        },
        tx,
      );
      if (approved) await this.runs.touch(tx, input.effectiveOn);
      return a.id;
    });
  }

  async approve(a: PayAdjustment, note: string | null, by: AuthUser): Promise<void> {
    const date = dateStr(a.effectiveOn)!;
    await this.runs.assertOpen(date);
    await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lock(tx, a.id, ['proposed']);
      await this.runs.assertOpen(date, tx);
      const now = this.clock.now();
      await tx.payAdjustment.update({
        where: { id: fresh.id },
        data: {
          status: 'approved',
          decidedById: by.id,
          decidedAt: now,
          decisionNote: note,
          updatedAt: now,
        },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'pay_adjustment_approved',
          subjectType: 'pay_adjustment',
          subjectId: fresh.id,
          after: { note },
        },
        tx,
      );
      await this.runs.touch(tx, date);
    });
  }

  async reject(a: PayAdjustment, note: string, by: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lock(tx, a.id, ['proposed']);
      const now = this.clock.now();
      await tx.payAdjustment.update({
        where: { id: fresh.id },
        data: {
          status: 'rejected',
          decidedById: by.id,
          decidedAt: now,
          decisionNote: note,
          updatedAt: now,
        },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'pay_adjustment_rejected',
          subjectType: 'pay_adjustment',
          subjectId: fresh.id,
          reason: note,
        },
        tx,
      );
    });
  }

  /**
   * Cancels an open adjustment. A fine already locked in an approved month is waived with a fine
   * reduction in the first open month instead (old type 5); that new row is returned too.
   */
  async cancel(
    a: PayAdjustment,
    reason: string,
    by: AuthUser,
  ): Promise<{ adjustmentId: number; reductionId: number | null }> {
    const date = dateStr(a.effectiveOn)!;
    return this.prisma.$transaction(async (tx) => {
      const fresh = await this.lock(tx, a.id, ['proposed', 'approved']);
      const run = await this.runs.runFor(date, tx);
      const locked = fresh.payslipId !== null || (run !== null && isLockedRun(run.status));
      const now = this.clock.now();

      if (locked) {
        if (fresh.type !== 'fine' || fresh.status !== 'approved') {
          throw payrollError(HttpStatus.CONFLICT, 'period_locked', {
            data: { period: Period.ofDate(date).toString() },
          });
        }
        const waived = await tx.payAdjustment.count({
          where: { reversesId: fresh.id, status: { in: ['approved', 'proposed'] } },
        });
        if (waived) throw payrollError(HttpStatus.CONFLICT, 'already_waived');
        const effectiveOn = await this.firstOpenDate(tx);
        const reduction = await tx.payAdjustment.create({
          data: {
            userId: fresh.userId,
            type: 'fine_reduction',
            amount: fresh.amount,
            currency: fresh.currency,
            effectiveOn: toDbDate(effectiveOn),
            reason,
            status: 'approved',
            reversesId: fresh.id,
            sessionId: fresh.sessionId,
            createdById: by.id,
            decidedById: by.id,
            decidedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        });
        await this.audit.record(
          {
            actorId: by.id,
            action: 'fine_waived',
            subjectType: 'pay_adjustment',
            subjectId: fresh.id,
            after: { reductionId: reduction.id, effectiveOn },
            reason,
          },
          tx,
        );
        await this.runs.touch(tx, effectiveOn);
        return { adjustmentId: fresh.id, reductionId: reduction.id };
      }

      const wasApproved = fresh.status === 'approved';
      await tx.payAdjustment.update({
        where: { id: fresh.id },
        data: {
          status: 'cancelled',
          decidedById: by.id,
          decidedAt: now,
          decisionNote: reason,
          updatedAt: now,
        },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'pay_adjustment_cancelled',
          subjectType: 'pay_adjustment',
          subjectId: fresh.id,
          reason,
        },
        tx,
      );
      if (wasApproved) await this.runs.touch(tx, date);
      return { adjustmentId: fresh.id, reductionId: null };
    });
  }

  async cancelResult(
    r: { adjustmentId: number; reductionId: number | null },
    viewer: AuthUser,
  ): Promise<CancelAdjustmentResultDto> {
    return {
      adjustment: await this.dto(r.adjustmentId, viewer),
      reduction: r.reductionId ? await this.dto(r.reductionId, viewer) : null,
    };
  }

  async dto(id: number, viewer: AuthUser): Promise<AdjustmentDto> {
    return adjustmentDto(
      await this.prisma.payAdjustment.findUniqueOrThrow({
        where: { id },
        include: adjustmentInclude,
      }),
      viewer,
    );
  }

  /** Today (academy zone) if its month is open, else the first day of the next open month. */
  private async firstOpenDate(tx: Tx): Promise<string> {
    let date = localDate(this.clock.nowMs(), await this.settings.get('academy.timezone'));
    for (let i = 0; i < 24; i++) {
      const run = await this.runs.runFor(date, tx);
      if (!run || !isLockedRun(run.status)) return date;
      date = Period.ofDate(date).next().startsOn();
    }
    return date;
  }

  private async lock(tx: Tx, id: number, allowed: string[]): Promise<PayAdjustment> {
    if (!(await lockPayrollRow(tx, 'pay_adjustments', id))) throw notFound();
    const a = await tx.payAdjustment.findUniqueOrThrow({ where: { id } });
    if (!allowed.includes(a.status)) {
      throw payrollError(HttpStatus.CONFLICT, 'invalid_adjustment_status');
    }
    return a;
  }
}
