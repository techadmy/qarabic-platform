import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  isLockedRun,
  type Paginated,
  type PayrollRunDetailDto,
  type PayrollRunDto,
  type PayslipDto,
  type RecordPaymentInput,
  type RunPreviewDto,
  type RunStatus,
} from '@qarabic/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { pageMeta, statusCounts } from '../common/pagination.js';
import { Prisma, type PayrollRun } from '../generated/prisma/client.js';
import { MAILER, type Mailer } from '../mail/mailer.js';
import type { Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isoZ, toDbDate } from '../schedule/time.js';
import { SettingsService, type SettingsMap } from '../settings/settings.service.js';
import { type ComputedSlip, PayrollCalculator } from './calculator.js';
import { payrollError } from './errors.js';
import { cents, fromCents } from './money.js';
import { Period } from './period.js';
import { payslipCan } from './policies.js';
import {
  issues,
  payslipDetailInclude,
  payslipDto,
  payslipInclude,
  runDto,
  runInclude,
  totals,
} from './presenter.js';

type Db = PrismaService | Tx;

const LOCKABLE = new Set(['payroll_runs', 'payslips', 'pay_adjustments', 'leave_requests']);

/** `SELECT … FOR UPDATE` on one payroll row (Laravel `lockForUpdate`); false when missing. */
export async function lockPayrollRow(tx: Tx, table: string, id: number): Promise<boolean> {
  if (!LOCKABLE.has(table)) throw new Error(`Not lockable: ${table}`);
  const rows = await tx.$queryRaw<
    Array<{ id: number }>
  >`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${id} FOR UPDATE`;
  return rows.length > 0;
}

/**
 * The payroll run lifecycle (D92, docs/21 §7; Laravel `PayrollRunService`): draft → reviewed →
 * approved → paid. Every transition locks the run row. Computing is idempotent: a run's payslips
 * are rebuilt in place (same ids) from the current data. An approved month is locked: its inputs
 * (attendance, leave, adjustments) are refused until it is reopened. No money is moved: approval
 * credits the wallet ledger and a recorded payment debits it (D93, D140).
 */
@Injectable()
export class PayrollRunsService {
  private readonly logger = new Logger(PayrollRunsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly calculator: PayrollCalculator,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async currentPeriod(): Promise<Period> {
    return Period.current(this.clock.nowMs(), await this.settings.get('academy.timezone'));
  }

  // ------------------------------------------------------------------ reads

  async list(
    q: { page: number; perPage: number },
    viewer: AuthUser,
  ): Promise<Paginated<PayrollRunDto>> {
    const [rows, total, groups] = await Promise.all([
      this.prisma.payrollRun.findMany({
        include: runInclude,
        orderBy: { period: 'desc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
      }),
      this.prisma.payrollRun.count(),
      this.prisma.payrollRun.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    return {
      data: rows.map((r) => runDto(r, viewer)),
      meta: pageMeta(q, total, statusCounts(['draft', 'reviewed', 'approved', 'paid'], groups)),
    };
  }

  async runDto(id: number, viewer: AuthUser): Promise<PayrollRunDto> {
    const run = await this.prisma.payrollRun.findUnique({ where: { id }, include: runInclude });
    if (!run) throw notFound();
    return runDto(run, viewer);
  }

  async show(id: number, viewer: AuthUser): Promise<PayrollRunDetailDto> {
    const dto = await this.runDto(id, viewer);
    const slips = await this.prisma.payslip.findMany({
      where: { runId: id },
      include: payslipInclude,
    });
    slips.sort(
      (a, b) =>
        a.user.name.toLocaleLowerCase().localeCompare(b.user.name.toLocaleLowerCase()) ||
        a.id - b.id,
    );
    return { ...dto, payslips: slips.map((s) => payslipDto(s, viewer)) };
  }

  /** What a run of the month would hold if computed now. Nothing is stored. */
  async preview(period: Period, userId: number | undefined): Promise<RunPreviewDto> {
    const st = await this.settings.all();
    const now = this.clock.nowMs();
    const profiles = await this.activeProfiles(this.prisma, userId);
    const users = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: profiles.map((p) => p.userId) } },
          select: { id: true, name: true, teacher: { select: { id: true } } },
        })
      ).map((u) => [u.id, u]),
    );
    const slips: ComputedSlip[] = [];
    for (const p of profiles)
      slips.push(await this.calculator.compute(this.prisma, p, period, st, now));
    const out = slips
      .map((s) => {
        const u = users.get(s.userId)!;
        return {
          period: period.toString(),
          user: { id: u.id, name: u.name, teacherId: u.teacher?.id ?? null },
          teacherId: s.teacherId,
          currency: s.currency,
          salaryType: s.salaryType,
          rates: s.rates,
          paidHours: s.paidHours,
          paidClasses: s.paidClasses,
          deductionDays: s.deductionDays,
          earnings: fromCents(s.earningsMinor),
          deductions: fromCents(s.deductionsMinor),
          net: fromCents(s.netMinor),
          status: 'draft' as const,
          warnings: s.warnings,
          errors: s.errors,
          paidAt: null,
          paidOn: null,
          paymentMethod: null,
          paymentReference: null,
          lines: s.lines.map((l) => ({
            code: l.code as never,
            sign: l.sign,
            quantity: l.quantity,
            rate: l.rateMinor === null ? null : fromCents(l.rateMinor),
            amount: fromCents(l.amountMinor),
            adjustment: null,
          })),
          sessions: s.sessions.map((x) => ({
            sessionId: x.sessionId,
            startsAt: isoZ(x.startsAt),
            kind: x.kind as never,
            stage: x.stage as never,
            payHours: x.payHours,
            payRuleKey: x.payRuleKey,
          })),
        };
      })
      .sort((a, b) => a.user.name.localeCompare(b.user.name) || a.user.id - b.user.id);
    return {
      period: period.toString(),
      computedAt: isoZ(now)!,
      payslips: out,
      totals: totals(
        slips.map((s) => ({
          currency: s.currency,
          earnings: fromCents(s.earningsMinor),
          deductions: fromCents(s.deductionsMinor),
          net: fromCents(s.netMinor),
          status: 'draft',
        })),
      ),
    };
  }

  async payslip(id: number, viewer: AuthUser): Promise<PayslipDto> {
    const slip = await this.prisma.payslip.findUnique({
      where: { id },
      include: payslipDetailInclude,
    });
    // Another person's payslip or a draft answers 404, never 403: no existence leak.
    if (!slip || !payslipCan.view(viewer, slip)) throw notFound();
    return payslipDto(slip, viewer);
  }

  /** The signed-in person's approved and paid payslips, newest month first (36). */
  async mine(viewer: AuthUser): Promise<PayslipDto[]> {
    const slips = await this.prisma.payslip.findMany({
      where: { userId: viewer.id, status: { not: 'draft' } },
      include: payslipInclude,
      orderBy: { run: { period: 'desc' } },
      take: 36,
    });
    return slips.map((s) => payslipDto(s, viewer));
  }

  // ------------------------------------------------------------------ lifecycle

  async create(period: Period, by: AuthUser | null): Promise<number> {
    if (period.isAfter(await this.currentPeriod())) {
      throw payrollError(HttpStatus.UNPROCESSABLE_ENTITY, 'period_not_started');
    }
    return this.prisma
      .$transaction(async (tx) => {
        const run = await tx.payrollRun.create({
          data: {
            period: period.toString(),
            startsOn: toDbDate(period.startsOn()),
            endsOn: toDbDate(period.endsOn()),
            status: 'draft',
            createdById: by?.id ?? null,
            createdAt: this.clock.now(),
            updatedAt: this.clock.now(),
          },
        });
        await this.compute(tx, run);
        await this.audit.record(
          {
            actorId: by?.id ?? null,
            action: 'payroll_run_created',
            subjectType: 'payroll_run',
            subjectId: run.id,
            after: { period: run.period },
          },
          tx,
        );
        return run.id;
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw payrollError(HttpStatus.CONFLICT, 'run_exists');
        }
        throw error;
      });
  }

  async recompute(id: number, expectedUpdatedAt?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const run = await this.lock(tx, id, ['draft', 'reviewed'], expectedUpdatedAt);
      await this.backToDraft(tx, run);
      await this.compute(tx, run);
    });
  }

  /**
   * Rebuilds every payslip of a draft / reviewed run from the current data, in place (same ids):
   * running it twice gives the same result. A person whose profile is gone keeps a zeroed payslip
   * only when the wallet ledger already points at it (after a reopen); otherwise it is removed.
   */
  async compute(tx: Tx, run: PayrollRun): Promise<void> {
    const st = await this.settings.all();
    const now = this.clock.nowMs();
    const period = Period.parse(run.period);
    const keep: number[] = [];
    for (const profile of await this.activeProfiles(tx)) {
      const data = await this.calculator.compute(tx, profile, period, st, now);
      const fields = {
        teacherId: data.teacherId,
        currency: data.currency,
        salaryType: data.salaryType,
        rates: data.rates as Prisma.InputJsonValue,
        paidHours: data.paidHours,
        paidClasses: data.paidClasses,
        deductionDays: data.deductionDays,
        earnings: fromCents(data.earningsMinor),
        deductions: fromCents(data.deductionsMinor),
        net: fromCents(data.netMinor),
        warnings: data.warnings as Prisma.InputJsonValue,
        errors: data.errors as Prisma.InputJsonValue,
        status: 'draft' as const,
        paidAt: null,
        updatedAt: this.clock.now(),
      };
      const slip = await tx.payslip.upsert({
        where: { runId_userId: { runId: run.id, userId: profile.userId } },
        create: { runId: run.id, userId: profile.userId, ...fields, createdAt: this.clock.now() },
        update: fields,
      });
      await tx.payslipLine.deleteMany({ where: { payslipId: slip.id } });
      await tx.payslipSession.deleteMany({ where: { payslipId: slip.id } });
      if (data.lines.length) {
        await tx.payslipLine.createMany({
          data: data.lines.map((l) => ({
            payslipId: slip.id,
            code: l.code,
            sign: l.sign,
            quantity: l.quantity,
            rate: l.rateMinor === null ? null : fromCents(l.rateMinor),
            amount: fromCents(l.amountMinor),
            payAdjustmentId: l.payAdjustmentId,
            position: l.position,
          })),
        });
      }
      for (let i = 0; i < data.sessions.length; i += 500) {
        await tx.payslipSession.createMany({
          data: data.sessions.slice(i, i + 500).map((s) => ({ payslipId: slip.id, ...s })),
        });
      }
      keep.push(slip.id);
    }

    const stale = await tx.payslip.findMany({
      where: { runId: run.id, id: { notIn: keep.length ? keep : [0] } },
      select: { id: true, _count: { select: { walletTx: true } } },
    });
    const inLedger = stale.filter((s) => s._count.walletTx > 0).map((s) => s.id);
    const removable = stale.filter((s) => s._count.walletTx === 0).map((s) => s.id);
    if (removable.length) await tx.payslip.deleteMany({ where: { id: { in: removable } } });
    if (inLedger.length) {
      await tx.payslipLine.deleteMany({ where: { payslipId: { in: inLedger } } });
      await tx.payslipSession.deleteMany({ where: { payslipId: { in: inLedger } } });
      await tx.payslip.updateMany({
        where: { id: { in: inLedger } },
        data: {
          status: 'draft',
          paidHours: 0,
          paidClasses: 0,
          deductionDays: 0,
          earnings: 0,
          deductions: 0,
          net: 0,
          warnings: [{ code: 'no_active_profile' }],
          errors: [],
          updatedAt: this.clock.now(),
        },
      });
    }
    await tx.payrollRun.update({
      where: { id: run.id },
      data: { computedAt: this.clock.now(), updatedAt: this.clock.now() },
    });
  }

  async review(id: number, by: AuthUser, expectedUpdatedAt?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const run = await this.lock(tx, id, ['draft'], expectedUpdatedAt);
      await this.compute(tx, run);
      await this.assertNoErrors(tx, run.id);
      await tx.payrollRun.update({
        where: { id },
        data: {
          status: 'reviewed',
          reviewedById: by.id,
          reviewedAt: this.clock.now(),
          updatedAt: this.clock.now(),
        },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'payroll_run_reviewed',
          subjectType: 'payroll_run',
          subjectId: id,
          after: { period: run.period },
        },
        tx,
      );
    });
  }

  async approve(id: number, by: AuthUser, expectedUpdatedAt?: string): Promise<void> {
    const approved = await this.prisma.$transaction(async (tx) => {
      const run = await this.lock(tx, id, ['reviewed'], expectedUpdatedAt);
      await this.assertNoErrors(tx, run.id);
      const now = this.clock.now();
      const totalsBy: Record<string, string> = {};
      const sums = new Map<string, number>();
      const slips = await tx.payslip.findMany({
        where: { runId: id },
        include: { lines: true },
        orderBy: { id: 'asc' },
      });
      for (const slip of slips) {
        const adjIds = slip.lines
          .map((l) => l.payAdjustmentId)
          .filter((x): x is number => x !== null);
        if (adjIds.length) {
          await tx.payAdjustment.updateMany({
            where: { id: { in: adjIds } },
            data: { payslipId: slip.id, updatedAt: now },
          });
        }
        const net = cents(slip.net);
        const zero = net === 0;
        await tx.payslip.update({
          where: { id: slip.id },
          data: { status: zero ? 'paid' : 'approved', paidAt: zero ? now : null, updatedAt: now },
        });
        if (net > 0) {
          await this.wallet(
            tx,
            slip,
            slip.net.toFixed(2),
            'salary_credit',
            `payroll ${run.period}`,
            by.id,
          );
        }
        await this.event(
          tx,
          'payslip.approved',
          'Payslip',
          slip.id,
          this.slipPayload(slip, run.period),
        );
        sums.set(slip.currency, (sums.get(slip.currency) ?? 0) + net);
      }
      for (const [c, v] of sums) totalsBy[c] = fromCents(v);
      await tx.payrollRun.update({
        where: { id },
        data: { status: 'approved', approvedById: by.id, approvedAt: now, updatedAt: now },
      });
      await this.event(tx, 'payroll_run.approved', 'PayrollRun', id, {
        period: run.period,
        netByCurrency: totalsBy,
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'payroll_run_approved',
          subjectType: 'payroll_run',
          subjectId: id,
          after: { period: run.period, netByCurrency: totalsBy },
        },
        tx,
      );
      await this.settleIfPaid(tx, id);
      return run;
    });
    await this.sendPayslipEmails(approved);
  }

  /**
   * Records how Accounts paid one payslip outside the system (method, reference, date). This is a
   * record only: no transfer is made (D140). The wallet ledger is debited by the net.
   */
  async recordPayment(slipId: number, input: RecordPaymentInput, by: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockPayrollRow(tx, 'payslips', slipId))) throw notFound();
      const slip = await tx.payslip.findUniqueOrThrow({
        where: { id: slipId },
        include: { run: true },
      });
      if (slip.status === 'paid') throw payrollError(HttpStatus.CONFLICT, 'payslip_already_paid');
      if (slip.status !== 'approved') {
        throw payrollError(HttpStatus.CONFLICT, 'invalid_run_status', {
          data: { status: slip.run.status },
        });
      }
      const now = this.clock.now();
      const reference = input.reference ?? null;
      await tx.payslip.update({
        where: { id: slipId },
        data: {
          status: 'paid',
          paidAt: now,
          paidOn: toDbDate(input.paidOn),
          paidById: by.id,
          paymentMethod: input.method,
          paymentReference: reference,
          updatedAt: now,
        },
      });
      await this.wallet(
        tx,
        slip,
        `-${slip.net.toFixed(2)}`,
        'salary_payment',
        reference ?? input.method,
        by.id,
      );
      await this.event(tx, 'payslip.paid', 'Payslip', slipId, {
        userId: slip.userId,
        currency: slip.currency,
        net: slip.net.toFixed(2),
        method: input.method,
        reference,
        paidOn: input.paidOn,
        period: slip.run.period,
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'payslip_paid',
          subjectType: 'payslip',
          subjectId: slipId,
          after: {
            method: input.method,
            reference,
            paidOn: input.paidOn,
            net: slip.net.toFixed(2),
          },
        },
        tx,
      );
      await this.settleIfPaid(tx, slip.runId);
    });
  }

  async reopen(
    id: number,
    reason: string,
    by: AuthUser,
    expectedUpdatedAt?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const run = await this.lock(tx, id, ['approved'], expectedUpdatedAt);
      const slips = await tx.payslip.findMany({ where: { runId: id }, include: { lines: true } });
      if (slips.some((s) => s.status === 'paid' && cents(s.net) > 0)) {
        throw payrollError(HttpStatus.CONFLICT, 'payslips_paid');
      }
      for (const slip of slips) {
        if (cents(slip.net) > 0) {
          await this.wallet(
            tx,
            slip,
            `-${slip.net.toFixed(2)}`,
            'reversal',
            `reopen ${run.period}`,
            by.id,
          );
        }
        await this.event(tx, 'payslip.reversed', 'Payslip', slip.id, {
          ...this.slipPayload(slip, run.period),
          reason,
        });
        await tx.payAdjustment.updateMany({
          where: { payslipId: slip.id },
          data: { payslipId: null, updatedAt: this.clock.now() },
        });
      }
      await tx.payrollRun.update({
        where: { id },
        data: {
          status: 'draft',
          reviewedById: null,
          reviewedAt: null,
          approvedById: null,
          approvedAt: null,
          updatedAt: this.clock.now(),
        },
      });
      await this.event(tx, 'payroll_run.reopened', 'PayrollRun', id, {
        period: run.period,
        reason,
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'payroll_run_reopened',
          subjectType: 'payroll_run',
          subjectId: id,
          after: { period: run.period },
          reason,
        },
        tx,
      );
      await this.compute(tx, { ...run, status: 'draft' });
    });
  }

  // ------------------------------------------------------------------ month locking (inputs)

  /** The run of the month a date belongs to, if any. */
  runFor(date: string, db: Db = this.prisma): Promise<PayrollRun | null> {
    return db.payrollRun.findUnique({ where: { period: Period.ofDate(date).toString() } });
  }

  /**
   * Refuses changes to an approved or paid month (D92): 409 `period_locked`. Inside a transaction
   * (P1-4, docs/39 BIL-4) the month's run row is locked first, so an approval running at the same
   * time either waits for this change (and then sees the run back in draft) or has already locked
   * the month (and this change is refused) — never an approved item left out of the payslip.
   */
  async assertOpen(date: string, db: Db = this.prisma): Promise<void> {
    let run = await this.runFor(date, db);
    if (run && db !== this.prisma) {
      await lockPayrollRow(db, 'payroll_runs', run.id);
      run = await db.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
    }
    if (run && isLockedRun(run.status)) {
      throw payrollError(HttpStatus.CONFLICT, 'period_locked', { data: { period: run.period } });
    }
  }

  /** An input of an open month changed: its run goes back to draft and is recomputed (same tx). */
  async touch(tx: Tx, date: string): Promise<void> {
    const found = await this.runFor(date, tx);
    if (!found || isLockedRun(found.status)) return;
    await lockPayrollRow(tx, 'payroll_runs', found.id);
    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: found.id } });
    // The month was approved while this change ran: refuse it rather than drop it silently.
    if (isLockedRun(run.status)) {
      throw payrollError(HttpStatus.CONFLICT, 'period_locked', { data: { period: run.period } });
    }
    await this.backToDraft(tx, run);
    await this.compute(tx, run);
  }

  /** CLI `payroll:compute --period=`: creates the month's run or recomputes an open one. */
  async computePeriod(
    period: Period,
  ): Promise<{ runId: number; action: 'created' | 'recomputed' | 'locked' }> {
    const run = await this.prisma.payrollRun.findUnique({ where: { period: period.toString() } });
    if (!run) return { runId: await this.create(period, null), action: 'created' };
    if (isLockedRun(run.status)) return { runId: run.id, action: 'locked' };
    await this.recompute(run.id);
    return { runId: run.id, action: 'recomputed' };
  }

  // ------------------------------------------------------------------ helpers

  private activeProfiles(db: Db, userId?: number) {
    return db.payProfile.findMany({
      where: { active: true, user: { archivedAt: null }, ...(userId ? { userId } : {}) },
      orderBy: { id: 'asc' },
    });
  }

  /**
   * Locks the run row; 409 `stale_run` when the client saw an older version (`expectedUpdatedAt`),
   * else 409 `invalid_run_status` when the action does not fit the status.
   */
  private async lock(
    tx: Tx,
    id: number,
    allowed: RunStatus[],
    expectedUpdatedAt?: string,
  ): Promise<PayrollRun> {
    if (!(await lockPayrollRow(tx, 'payroll_runs', id))) throw notFound();
    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id } });
    if (
      expectedUpdatedAt !== undefined &&
      new Date(expectedUpdatedAt).getTime() !== run.updatedAt.getTime()
    ) {
      throw payrollError(HttpStatus.CONFLICT, 'stale_run', {
        data: { status: run.status, updatedAt: run.updatedAt.toISOString() },
      });
    }
    if (!allowed.includes(run.status)) {
      throw payrollError(HttpStatus.CONFLICT, 'invalid_run_status', {
        data: { status: run.status },
      });
    }
    return run;
  }

  private async backToDraft(tx: Tx, run: PayrollRun): Promise<void> {
    if (run.status === 'draft') return;
    await tx.payrollRun.update({
      where: { id: run.id },
      data: { status: 'draft', reviewedById: null, reviewedAt: null, updatedAt: this.clock.now() },
    });
  }

  private async assertNoErrors(tx: Tx, runId: number): Promise<void> {
    const slips = await tx.payslip.findMany({
      where: { runId },
      select: { id: true, errors: true, user: { select: { name: true } } },
      orderBy: { id: 'asc' },
    });
    const blocked = slips.filter((s) => issues(s.errors).length > 0);
    if (blocked.length) {
      throw payrollError(HttpStatus.UNPROCESSABLE_ENTITY, 'payroll_blocked', {
        data: blocked.map((s) => ({
          payslipId: s.id,
          user: s.user.name,
          errors: issues(s.errors),
        })),
      });
    }
  }

  private async settleIfPaid(tx: Tx, runId: number): Promise<void> {
    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== 'approved') return;
    const open = await tx.payslip.count({ where: { runId, status: { not: 'paid' } } });
    if (open === 0) {
      await tx.payrollRun.update({
        where: { id: runId },
        data: { status: 'paid', paidAt: this.clock.now(), updatedAt: this.clock.now() },
      });
    }
  }

  private async wallet(
    tx: Tx,
    slip: { id: number; userId: number; currency: string },
    amount: string,
    type: 'salary_credit' | 'salary_payment' | 'reversal',
    reference: string | null,
    by: number,
  ): Promise<void> {
    await tx.walletTransaction.create({
      data: {
        userId: slip.userId,
        currency: slip.currency,
        amount,
        type,
        payslipId: slip.id,
        reference: reference ? reference.slice(0, 190) : null,
        createdById: by,
        occurredAt: this.clock.now(),
        createdAt: this.clock.now(),
      },
    });
  }

  /** Outbox row for accounting (D95), same transaction as the change. */
  private async event(
    tx: Tx,
    type: string,
    aggregateType: string,
    aggregateId: number,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.payrollEvent.create({
      data: {
        type,
        aggregateType,
        aggregateId,
        payload: payload as Prisma.InputJsonValue,
        occurredAt: this.clock.now(),
        createdAt: this.clock.now(),
      },
    });
  }

  private slipPayload(
    slip: {
      userId: number;
      currency: string;
      earnings: Prisma.Decimal;
      deductions: Prisma.Decimal;
      net: Prisma.Decimal;
      lines: Array<{ code: string; sign: number; amount: Prisma.Decimal }>;
    },
    period: string,
  ): Record<string, unknown> {
    return {
      period,
      userId: slip.userId,
      currency: slip.currency,
      earnings: slip.earnings.toFixed(2),
      deductions: slip.deductions.toFixed(2),
      net: slip.net.toFixed(2),
      lines: slip.lines.map((l) => ({ code: l.code, sign: l.sign, amount: l.amount.toFixed(2) })),
    };
  }

  /**
   * Payslip emails behind `payroll.payslip_emails` (off by default: no messages to real people,
   * D140). The mailer is the in-memory one outside production; a failure never undoes approval.
   */
  private async sendPayslipEmails(run: PayrollRun): Promise<void> {
    const st: SettingsMap = await this.settings.all();
    if (!st['payroll.payslip_emails']) return;
    const slips = await this.prisma.payslip.findMany({
      where: { runId: run.id, status: { not: 'draft' } },
      include: { user: { select: { email: true, name: true } } },
    });
    for (const s of slips) {
      try {
        await this.mailer.send({
          to: s.user.email,
          kind: 'payslip_approved',
          subject: `Payslip ${run.period}`,
          text: `Hello ${s.user.name},\n\nYour payslip for ${run.period} is approved: net ${s.net.toFixed(2)} ${s.currency}.\nOpen the app to see the details.`,
        });
      } catch (error) {
        this.logger.error(`Payslip email ${s.id} failed`, error as Error);
      }
    }
  }
}
