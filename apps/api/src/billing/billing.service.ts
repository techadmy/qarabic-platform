import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type BillingSummaryDto,
  type createFeePackageSchema,
  type FamilyBillingDto,
  type FeePackageDto,
  fromMinor,
  INVOICE_STATUSES,
  type InvoiceDetailDto,
  type InvoiceDto,
  type invoiceListQuerySchema,
  OPEN_INVOICE_STATUSES,
  type Paginated,
  type updateFamilyBillingSchema,
  type updateFeePackageSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { ApiException, notFound } from '../common/errors.js';
import { pageMeta } from '../common/pagination.js';
import { contains } from '../common/search.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addMonths, fromDbDate, localDate, startOfLocalDay, toDbDate } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { FamilyFeeCalculator } from './fees.js';
import { amountOf, dec, minor } from './money.js';
import { BillingPeriod } from './period.js';
import {
  feeDto,
  feePackageDto,
  feePackageInclude,
  invoiceDetailDto,
  invoiceDetailInclude,
  type InvoiceDetailRow,
  invoiceDto,
  invoiceListInclude,
} from './presenter.js';
import {
  assertFamilyInScope,
  assertStaffScope,
  billingScope,
  type BillingScope,
  invoiceScopeWhere,
} from './scope.js';
import { PackageUsageService } from './usage.js';

type ListQuery = z.output<typeof invoiceListQuerySchema>;
type CreatePackage = z.output<typeof createFeePackageSchema>;
type UpdatePackage = z.output<typeof updateFeePackageSchema>;
type UpdateProfile = z.output<typeof updateFamilyBillingSchema>;

/** Reads and the simple writes of billing: packages, family profiles, invoice lists, summary. */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly fees: FamilyFeeCalculator,
    private readonly usage: PackageUsageService,
  ) {}

  scope(user: AuthUser): Promise<BillingScope> {
    return billingScope(this.prisma, user);
  }

  async today(): Promise<string> {
    return localDate(this.clock.nowMs(), await this.settings.get('academy.timezone'));
  }

  // ------------------------------------------------------------------ fee packages

  async packages(active: boolean | undefined): Promise<FeePackageDto[]> {
    const rows = await this.prisma.feePackage.findMany({
      where: active === undefined ? {} : { isActive: active },
      include: feePackageInclude,
      orderBy: [
        { isActive: 'desc' },
        { classesPerWeek: 'asc' },
        { sessionMinutes: 'asc' },
        { id: 'asc' },
      ],
    });
    return rows.map(feePackageDto);
  }

  async package(id: number): Promise<FeePackageDto> {
    const row = await this.prisma.feePackage.findUnique({
      where: { id },
      include: feePackageInclude,
    });
    if (!row) throw notFound();
    return feePackageDto(row);
  }

  async createPackage(input: CreatePackage, actor: AuthUser): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const pkg = await tx.feePackage.create({
        data: {
          name: input.name,
          classesPerWeek: input.classesPerWeek,
          sessionMinutes: input.sessionMinutes,
          description: input.description ?? null,
          isActive: input.isActive,
          createdById: actor.id,
          prices: {
            create: input.prices.map((p) => ({
              currency: p.currency,
              monthlyAmount: p.monthlyAmount,
            })),
          },
        },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'created',
          subjectType: 'fee_package',
          subjectId: pkg.id,
          after: { ...input },
        },
        tx,
      );
      return pkg.id;
    });
  }

  async updatePackage(id: number, input: UpdatePackage, actor: AuthUser): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM "fee_packages" WHERE id = ${id} FOR UPDATE`;
      if (!rows.length) throw notFound();
      const before = await tx.feePackage.findUniqueOrThrow({
        where: { id },
        include: { prices: true },
      });
      await tx.feePackage.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.classesPerWeek !== undefined ? { classesPerWeek: input.classesPerWeek } : {}),
          ...(input.sessionMinutes !== undefined ? { sessionMinutes: input.sessionMinutes } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      if (input.prices) {
        const keep = input.prices.map((p) => p.currency);
        for (const p of input.prices) {
          await tx.feePackagePrice.upsert({
            where: { feePackageId_currency: { feePackageId: id, currency: p.currency } },
            create: { feePackageId: id, currency: p.currency, monthlyAmount: p.monthlyAmount },
            update: { monthlyAmount: p.monthlyAmount },
          });
        }
        await tx.feePackagePrice.deleteMany({
          where: { feePackageId: id, currency: { notIn: keep } },
        });
      }
      const changes = diff(
        {
          name: before.name,
          classesPerWeek: before.classesPerWeek,
          sessionMinutes: before.sessionMinutes,
          description: before.description,
          isActive: before.isActive,
          prices: before.prices
            .map((p) => ({ currency: p.currency, monthlyAmount: amountOf(p.monthlyAmount) }))
            .sort((a, b) => a.currency.localeCompare(b.currency)),
        },
        {
          name: input.name ?? before.name,
          classesPerWeek: input.classesPerWeek ?? before.classesPerWeek,
          sessionMinutes: input.sessionMinutes ?? before.sessionMinutes,
          description: input.description === undefined ? before.description : input.description,
          isActive: input.isActive ?? before.isActive,
          prices: input.prices
            ? [...input.prices].sort((a, b) => a.currency.localeCompare(b.currency))
            : before.prices
                .map((p) => ({ currency: p.currency, monthlyAmount: amountOf(p.monthlyAmount) }))
                .sort((a, b) => a.currency.localeCompare(b.currency)),
        },
      );
      if (changes) {
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'updated',
            subjectType: 'fee_package',
            subjectId: id,
            before: changes[0],
            after: changes[1],
          },
          tx,
        );
      }
    });
  }

  // ------------------------------------------------------------------ family billing profile

  async familyBilling(familyId: number, viewer: AuthUser): Promise<FamilyBillingDto> {
    assertFamilyInScope(await this.scope(viewer), familyId);
    const family = await this.fees.load(familyId);
    if (!family) throw notFound();
    const st = await this.settings.all();
    const today = localDate(this.clock.nowMs(), st['academy.timezone']);
    const profile = family.billingProfile;
    const day = profile?.billingDay === 15 ? 15 : 1;
    // The next period to bill: this month's when its billing day is still ahead, else next month's.
    const month =
      Number(today.slice(8, 10)) >= day ? addMonths(`${today.slice(0, 7)}-01`, 1) : today;
    const period = BillingPeriod.of(month.slice(0, 7), day);
    const fee = this.fees.forPeriod(family, period);

    const open = await this.prisma.invoice.findMany({
      where: { familyId, status: { in: [...OPEN_INVOICE_STATUSES] } },
      select: { currency: true, total: true, paid: true, dueDate: true },
    });
    const balance = new Map<string, { due: number; overdue: number; openInvoices: number }>();
    for (const i of open) {
      const b = balance.get(i.currency) ?? { due: 0, overdue: 0, openInvoices: 0 };
      const owed = Math.max(0, minor(i.total) - minor(i.paid));
      b.due += owed;
      b.openInvoices += 1;
      if (i.dueDate && fromDbDate(i.dueDate) < today) b.overdue += owed;
      balance.set(i.currency, b);
    }

    return {
      familyId: family.id,
      familyName: family.user.name,
      billingCurrency: (profile?.currency ?? null) as FamilyBillingDto['billingCurrency'],
      billingDay: day,
      billingEnabled: profile?.enabled ?? false,
      customFee: profile?.customFee ? amountOf(profile.customFee) : null,
      billingStartsOn: profile?.startsOn ? fromDbDate(profile.startsOn) : null,
      status: family.status,
      students: family.students.map((s) => ({
        id: s.id,
        name: s.name,
        feePackageId: s.feePackage?.feePackageId ?? null,
      })),
      nextInvoice: feeDto(fee, period),
      balance: [...balance.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, b]) => ({
          currency,
          due: fromMinor(b.due),
          overdue: fromMinor(b.overdue),
          openInvoices: b.openInvoices,
        })),
    };
  }

  async updateFamilyBilling(
    familyId: number,
    input: UpdateProfile,
    actor: AuthUser,
  ): Promise<void> {
    assertStaffScope(await this.scope(actor));
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM "families" WHERE id = ${familyId} FOR UPDATE`;
      if (!rows.length) throw notFound();
      const students = await tx.student.findMany({
        where: { familyId },
        select: { id: true, feePackage: { select: { feePackageId: true } } },
      });
      const ids = new Set(students.map((s) => s.id));
      const errors: Record<string, string[]> = {};
      const packageIds = new Set(
        (
          await tx.feePackage.findMany({
            where: {
              id: {
                in: (input.students ?? []).flatMap((r) => (r.feePackageId ? [r.feePackageId] : [])),
              },
            },
            select: { id: true },
          })
        ).map((p) => p.id),
      );
      (input.students ?? []).forEach((row, i) => {
        if (!ids.has(row.id)) errors.students = ['Unknown student for this family.'];
        if (row.feePackageId && !packageIds.has(row.feePackageId)) {
          errors[`students.${i}.feePackageId`] = ['The selected package is invalid.'];
        }
      });
      if (Object.keys(errors).length) {
        throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
          message: 'The given data was invalid.',
          code: errors.students ? 'unknown_student' : 'validation_failed',
          errors,
        });
      }
      const before = await tx.familyBillingProfile.findUnique({ where: { familyId } });
      const data = {
        currency: input.billingCurrency,
        billingDay: input.billingDay,
        enabled: input.billingEnabled,
        customFee: input.customFee ?? null,
        startsOn: input.billingStartsOn ? toDbDate(input.billingStartsOn) : null,
        updatedById: actor.id,
      };
      await tx.familyBillingProfile.upsert({
        where: { familyId },
        create: { familyId, ...data },
        update: data,
      });
      const packageChanges: Record<string, number | null> = {};
      for (const row of input.students ?? []) {
        const current = students.find((s) => s.id === row.id)?.feePackage?.feePackageId ?? null;
        if (current === row.feePackageId) continue;
        packageChanges[String(row.id)] = row.feePackageId;
        if (row.feePackageId === null) {
          await tx.studentFeePackage.delete({ where: { studentId: row.id } });
        } else {
          await tx.studentFeePackage.upsert({
            where: { studentId: row.id },
            create: { studentId: row.id, feePackageId: row.feePackageId, updatedById: actor.id },
            update: { feePackageId: row.feePackageId, updatedById: actor.id },
          });
        }
      }
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'billing_profile_updated',
          subjectType: 'family',
          subjectId: familyId,
          before: before
            ? {
                billingCurrency: before.currency,
                billingDay: before.billingDay,
                billingEnabled: before.enabled,
                customFee: before.customFee ? amountOf(before.customFee) : null,
                billingStartsOn: before.startsOn ? fromDbDate(before.startsOn) : null,
              }
            : null,
          after: {
            billingCurrency: data.currency,
            billingDay: data.billingDay,
            billingEnabled: data.enabled,
            customFee: data.customFee,
            billingStartsOn: input.billingStartsOn ?? null,
            ...(Object.keys(packageChanges).length ? { packages: packageChanges } : {}),
          },
        },
        tx,
      );
    });
  }

  // ------------------------------------------------------------------ invoices

  async list(q: ListQuery, viewer: AuthUser): Promise<Paginated<InvoiceDto>> {
    const scope = await this.scope(viewer);
    const today = await this.today();
    const and: Prisma.InvoiceWhereInput[] = [invoiceScopeWhere(scope)];
    if (scope.kind === 'staff' && q.familyId) and.push({ familyId: q.familyId });
    if (q.period) {
      const from = toDbDate(`${q.period}-01`);
      const to = toDbDate(addMonths(`${q.period}-01`, 1));
      and.push({
        OR: [
          { periodStart: { gte: from, lt: to } },
          { periodStart: null, issueDate: { gte: from, lt: to } },
        ],
      });
    }
    if (q.q) {
      and.push({
        OR: [
          { number: contains(q.q) },
          { family: { user: { name: contains(q.q) } } },
          { family: { user: { email: contains(q.q) } } },
        ],
      });
    }
    const overdueWhere: Prisma.InvoiceWhereInput = {
      status: { in: [...OPEN_INVOICE_STATUSES] },
      dueDate: { lt: toDbDate(today) },
    };
    const tab = (status: ListQuery['status']): Prisma.InvoiceWhereInput =>
      status === undefined
        ? {}
        : status === 'open'
          ? { status: { in: [...OPEN_INVOICE_STATUSES] } }
          : status === 'overdue'
            ? overdueWhere
            : { status };
    const where: Prisma.InvoiceWhereInput = { AND: [...and, tab(q.status)] };
    const [rows, total, groups, overdue] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: invoiceListInclude,
        orderBy: { id: 'desc' },
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
      }),
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.groupBy({ by: ['status'], where: { AND: and }, _count: { _all: true } }),
      this.prisma.invoice.count({ where: { AND: [...and, overdueWhere] } }),
    ]);
    const counts: Record<string, number> = { all: 0, open: 0, overdue };
    for (const s of INVOICE_STATUSES) counts[s] = 0;
    for (const g of groups) {
      counts[g.status] = g._count._all;
      counts.all! += g._count._all;
      if ((OPEN_INVOICE_STATUSES as readonly string[]).includes(g.status))
        counts.open! += g._count._all;
    }
    if (scope.kind === 'family') delete counts.draft;
    return { data: rows.map((r) => invoiceDto(r, today)), meta: pageMeta(q, total, counts) };
  }

  /** List rows of the given invoices (staff), in the given order. */
  async rows(ids: number[]): Promise<InvoiceDto[]> {
    const today = await this.today();
    const rows = await this.prisma.invoice.findMany({
      where: { id: { in: ids } },
      include: invoiceListInclude,
    });
    return ids.flatMap((id) => {
      const row = rows.find((r) => r.id === id);
      return row ? [invoiceDto(row, today)] : [];
    });
  }

  /** One invoice in the viewer's scope (404 otherwise; a parent never sees a draft). */
  async findRow(id: number, viewer: AuthUser): Promise<InvoiceDetailRow> {
    const scope = await this.scope(viewer);
    const row = await this.prisma.invoice.findFirst({
      where: { AND: [{ id }, invoiceScopeWhere(scope)] },
      include: invoiceDetailInclude,
    });
    if (!row) throw notFound();
    return row;
  }

  async show(id: number, viewer: AuthUser): Promise<InvoiceDetailDto> {
    const row = await this.findRow(id, viewer);
    const scope = await this.scope(viewer);
    return invoiceDetailDto(
      row,
      await this.today(),
      { staff: scope.kind === 'staff', manage: viewer.permissions.has('invoices.manage') },
      await this.usage.forInvoice(row, row.lines),
    );
  }

  /** Staff actions: the invoice must exist (404) and the viewer must be staff (portal user 404). */
  async assertStaffInvoice(id: number, viewer: AuthUser): Promise<void> {
    assertStaffScope(await this.scope(viewer));
    const row = await this.prisma.invoice.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw notFound();
  }

  // ------------------------------------------------------------------ summary

  /** Staff KPIs per currency: due, overdue, collected this month, and status counts. */
  async summary(viewer: AuthUser): Promise<BillingSummaryDto> {
    assertStaffScope(await this.scope(viewer));
    const zone = await this.settings.get('academy.timezone');
    const today = localDate(this.clock.nowMs(), zone);
    const monthStart = `${today.slice(0, 7)}-01`;
    const from = new Date(startOfLocalDay(monthStart, zone));
    const to = new Date(startOfLocalDay(addMonths(monthStart, 1), zone));
    const openWhere: Prisma.InvoiceWhereInput = { status: { in: [...OPEN_INVOICE_STATUSES] } };
    const overdueWhere: Prisma.InvoiceWhereInput = {
      ...openWhere,
      dueDate: { lt: toDbDate(today) },
    };
    const [open, overdue, collected, statuses] = await Promise.all([
      this.prisma.invoice.groupBy({
        by: ['currency'],
        where: openWhere,
        _sum: { total: true, paid: true },
        _count: { _all: true },
      }),
      this.prisma.invoice.groupBy({
        by: ['currency'],
        where: overdueWhere,
        _sum: { total: true, paid: true },
        _count: { _all: true },
      }),
      this.prisma.payment.groupBy({
        by: ['currency'],
        where: { status: 'succeeded', receivedAt: { gte: from, lt: to } },
        _sum: { amount: true },
      }),
      this.prisma.invoice.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const currencies = [
      ...new Set([...open.map((o) => o.currency), ...collected.map((c) => c.currency)]),
    ].sort();
    const due = (r?: { _sum: { total: Prisma.Decimal | null; paid: Prisma.Decimal | null } }) =>
      r ? minor(r._sum.total) - minor(r._sum.paid) : 0;
    const counts: Record<string, number> = {};
    for (const s of statuses) counts[s.status] = s._count._all;
    counts.overdue = overdue.reduce((n, o) => n + o._count._all, 0);
    return {
      byCurrency: currencies.map((c) => {
        const o = open.find((x) => x.currency === c);
        const od = overdue.find((x) => x.currency === c);
        return {
          currency: c,
          due: fromMinor(due(o)),
          openCount: o?._count._all ?? 0,
          overdue: fromMinor(due(od)),
          overdueCount: od?._count._all ?? 0,
          collectedThisMonth: dec(minor(collected.find((x) => x.currency === c)?._sum.amount)),
        };
      }),
      counts,
      month: today.slice(0, 7),
    };
  }
}
