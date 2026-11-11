import { Injectable } from '@nestjs/common';
import { type Currency, CURRENCIES, fromMinor, prorate } from '@qarabic/shared';
import type { Prisma } from '../generated/prisma/client.js';
import type { Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { dateMs, DAY, fromDbDate } from '../schedule/time.js';
import { minor } from './money.js';
import type { BillingPeriod } from './period.js';

export interface FeeLine {
  type: 'package';
  studentId: number | null;
  feePackageId: number | null;
  description: string;
  amountMinor: number;
  meta: Record<string, unknown>;
}

export interface FamilyFee {
  currency: Currency | null;
  lines: FeeLine[];
  totalMinor: number;
  warnings: string[];
}

/** What the calculator needs of a family (one query per run, see `familyInclude`). */
export const feeFamilyInclude = {
  user: { select: { name: true, email: true, locale: true } },
  billingProfile: true,
  students: {
    where: { archivedAt: null },
    orderBy: { id: 'asc' },
    include: { feePackage: { include: { feePackage: { include: { prices: true } } } } },
  },
} satisfies Prisma.FamilyInclude;
export type FeeFamily = Prisma.FamilyGetPayload<{ include: typeof feeFamilyInclude }>;

const isCurrency = (c: string | null | undefined): c is Currency =>
  !!c && (CURRENCIES as readonly string[]).includes(c);

/**
 * The monthly amount of a family for a period (Laravel `FamilyFeeCalculator`, D84, D85):
 *  - the family's custom fee when set (old `account.fee`), else
 *  - one package line per child with a fee package, priced in the family currency;
 *  - prorated by days when billing starts inside the period.
 * Never guesses: a missing currency or price is a warning and no lines.
 */
@Injectable()
export class FamilyFeeCalculator {
  constructor(private readonly prisma: PrismaService) {}

  load(id: number, db: PrismaService | Tx = this.prisma): Promise<FeeFamily | null> {
    return db.family.findUnique({ where: { id }, include: feeFamilyInclude });
  }

  forPeriod(family: FeeFamily, period: BillingPeriod): FamilyFee {
    const profile = family.billingProfile;
    const currency = isCurrency(profile?.currency) ? profile.currency : null;
    const out: FamilyFee = { currency, lines: [], totalMinor: 0, warnings: [] };
    if (!currency) {
      out.warnings.push('missing_currency');
      return out;
    }

    // An inactive child is not billed (docs/28 §4.2, D125).
    const students = family.students.filter((s) => s.status !== 'inactive');
    let lines: FeeLine[] = [];
    if (profile?.customFee !== null && profile?.customFee !== undefined) {
      lines.push({
        type: 'package',
        studentId: null,
        feePackageId: null,
        description: 'Monthly fee',
        amountMinor: minor(profile.customFee),
        meta: { source: 'custom_fee', children: students.length },
      });
    } else {
      for (const student of students) {
        const pkg = student.feePackage?.feePackage;
        if (!pkg) {
          out.warnings.push(`no_package:${student.id}`);
          continue;
        }
        const price = pkg.prices.find((p) => p.currency === currency);
        if (!price) {
          out.warnings.push(`missing_price:${student.id}`);
          continue;
        }
        lines.push({
          type: 'package',
          studentId: student.id,
          feePackageId: pkg.id,
          description: `${student.name} — ${pkg.name}`,
          amountMinor: minor(price.monthlyAmount),
          meta: {
            source: 'package',
            classesPerWeek: pkg.classesPerWeek,
            sessionMinutes: pkg.sessionMinutes,
          },
        });
      }
      // A partial invoice would be wrong money: skip the family until the prices exist.
      if (out.warnings.some((w) => w.startsWith('missing_price'))) return out;
    }

    const start = profile?.startsOn ? fromDbDate(profile.startsOn) : null;
    if (start && start > period.end) {
      out.warnings.push('not_started');
      return out;
    }
    if (start && start > period.start && period.contains(start)) {
      const remaining = Math.round((dateMs(period.end) - dateMs(start)) / DAY) + 1;
      lines = lines.map((line) => ({
        ...line,
        amountMinor: prorate(line.amountMinor, remaining, period.days()),
        meta: {
          ...line.meta,
          prorated: true,
          fullAmount: fromMinor(line.amountMinor),
          days: remaining,
          periodDays: period.days(),
        },
      }));
    }

    out.lines = lines;
    out.totalMinor = lines.reduce((sum, l) => sum + l.amountMinor, 0);
    if (!lines.length && !out.warnings.length) out.warnings.push('no_fee');
    return out;
  }
}
