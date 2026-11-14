import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  createPayRuleSetSchema,
  Paginated,
  PayProfileDto,
  payProfileListQuerySchema,
  PayrollPickerPersonDto,
  PayRuleSetDto,
  savePayProfileSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { notFound, validationError } from '../common/errors.js';
import { payrollError } from './errors.js';
import { pageMeta } from '../common/pagination.js';
import { contains } from '../common/search.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isoZ, localDate, startOfLocalDay } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { parseRules } from './pay-rules.js';
import { person, profileDto, profileInclude, type ProfileRow, slotTiers } from './presenter.js';

function snapshot(p: ProfileRow | null): Record<string, unknown> {
  if (!p) return {};
  return {
    salaryType: p.salaryType,
    currency: p.currency,
    monthlySalary: p.monthlySalary.toFixed(2),
    classRate: p.classRate.toFixed(2),
    hourlyRate: p.hourlyRate.toFixed(2),
    csrRate: p.csrRate.toFixed(2),
    allowance: p.allowance.toFixed(2),
    tax: p.tax.toFixed(2),
    slotTiers: slotTiers(p.slotTiers),
    active: p.active,
    notes: p.notes,
  };
}

/**
 * Salary (pay) profiles (D89; Laravel `SalaryProfileController`): how each person is paid, the
 * person picker of fines / attendance, and the versioned pay rules (D41, `PayRuleSetController`).
 */
@Injectable()
export class PayProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  async list(q: z.output<typeof payProfileListQuerySchema>): Promise<Paginated<PayProfileDto>> {
    const where: Prisma.PayProfileWhereInput = q.q ? { user: { name: contains(q.q) } } : {};
    const [rows, total, currency] = await Promise.all([
      this.prisma.payProfile.findMany({
        where,
        include: profileInclude,
        orderBy: [{ active: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.perPage,
        take: q.perPage,
      }),
      this.prisma.payProfile.count({ where }),
      this.settings.get('payroll.default_currency'),
    ]);
    return {
      data: rows.map((r) => profileDto(r, currency)),
      meta: pageMeta(q, total, { all: total }),
    };
  }

  /** People with an active profile (id, name, currency only), for the pickers. 50, by name. */
  async people(q: string | undefined): Promise<PayrollPickerPersonDto[]> {
    const [rows, currency] = await Promise.all([
      this.prisma.payProfile.findMany({
        where: { active: true, user: { archivedAt: null, ...(q ? { name: contains(q) } : {}) } },
        include: profileInclude,
        take: 50,
      }),
      this.settings.get('payroll.default_currency'),
    ]);
    return rows
      .map((p) => ({ ...person(p.user), currency: p.currency ?? currency }))
      .sort((a, b) => a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()));
  }

  async show(userId: number): Promise<PayProfileDto | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw notFound();
    const profile = await this.prisma.payProfile.findUnique({
      where: { userId },
      include: profileInclude,
    });
    return profile
      ? profileDto(profile, await this.settings.get('payroll.default_currency'))
      : null;
  }

  async save(
    userId: number,
    input: z.output<typeof savePayProfileSchema>,
    by: AuthUser,
  ): Promise<PayProfileDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: { select: { kind: true } }, teacher: { select: { id: true } } },
    });
    if (!user) throw notFound();
    // P0-3 (B116): nobody sets their own pay.
    if (userId === by.id) throw payrollError(HttpStatus.FORBIDDEN, 'self_decision');
    if (user.role?.kind === 'parent') {
      throw validationError({ userId: ['A parent account has no salary.'] });
    }
    const currencies = await this.settings.get('payroll.currencies');
    if (!currencies.includes(input.currency)) {
      throw validationError({ currency: ['The selected currency is invalid.'] });
    }
    const tiers = (input.slotTiers ?? [])
      .map((t) => ({ minSlots: t.minSlots, amount: t.amount }))
      .sort((a, b) => a.minSlots - b.minSlots);
    const data = {
      teacherId: user.teacher?.id ?? null,
      salaryType: input.salaryType,
      currency: input.currency,
      monthlySalary: input.monthlySalary ?? '0.00',
      classRate: input.classRate ?? '0.00',
      hourlyRate: input.hourlyRate ?? '0.00',
      csrRate: input.csrRate ?? '0.00',
      allowance: input.allowance ?? '0.00',
      tax: input.tax ?? '0.00',
      slotTiers: tiers,
      active: input.active ?? true,
      notes: input.notes ?? null,
      updatedById: by.id,
    };
    const saved = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "pay_profiles" WHERE user_id = ${userId} FOR UPDATE`;
      const before = await tx.payProfile.findUnique({ where: { userId }, include: profileInclude });
      const row = await tx.payProfile.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
        include: profileInclude,
      });
      const changes = diff(snapshot(before), snapshot(row));
      if (changes) {
        await this.audit.record(
          {
            actorId: by.id,
            action: 'salary_profile_saved',
            subjectType: 'pay_profile',
            subjectId: row.id,
            before: changes[0],
            after: changes[1],
            reason: input.reason ?? null,
          },
          tx,
        );
      }
      return row;
    });
    return profileDto(saved, await this.settings.get('payroll.default_currency'));
  }

  // ------------------------------------------------------------------ pay rule sets (D41)

  async ruleSets(): Promise<PayRuleSetDto[]> {
    const sets = await this.prisma.payRuleSet.findMany({
      include: { createdBy: { select: { id: true, name: true } } },
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
    });
    return sets.map((s) => ({
      id: s.id,
      effectiveFrom: isoZ(s.effectiveFrom)!,
      rules: parseRules(s.rules),
      note: s.note,
      createdBy: s.createdBy,
      createdAt: isoZ(s.createdAt)!,
    }));
  }

  /** A new version (sets are never edited): from today (academy zone) or later. */
  async createRuleSet(
    input: z.output<typeof createPayRuleSetSchema>,
    by: AuthUser,
  ): Promise<PayRuleSetDto> {
    const zone = await this.settings.get('academy.timezone');
    const today = startOfLocalDay(localDate(this.clock.nowMs(), zone), zone);
    const from = new Date(input.effectiveFrom);
    if (from.getTime() < today) {
      throw validationError({ effectiveFrom: ['The rules must start today or later.'] });
    }
    const rules = { ...input.rules };
    rules.default ??= { factor: 0, billable: false };
    const set = await this.prisma.$transaction(async (tx) => {
      const row = await tx.payRuleSet.create({
        data: {
          effectiveFrom: from,
          rules,
          note: input.note ?? null,
          createdById: by.id,
          createdAt: this.clock.now(),
        },
        include: { createdBy: { select: { id: true, name: true } } },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'pay_rule_set_created',
          subjectType: 'pay_rule_set',
          subjectId: row.id,
          after: { effectiveFrom: isoZ(from), rules },
        },
        tx,
      );
      return row;
    });
    return {
      id: set.id,
      effectiveFrom: isoZ(set.effectiveFrom)!,
      rules: parseRules(set.rules),
      note: set.note,
      createdBy: set.createdBy,
      createdAt: isoZ(set.createdAt)!,
    };
  }
}
