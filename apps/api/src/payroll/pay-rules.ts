import { Global, Injectable, Module } from '@nestjs/common';
import { DEFAULT_PAY_RULES, type PayRule, payRuleCandidates, payRuleSchema } from '@qarabic/shared';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import type { Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { holidayOn } from '../schedule/conflicts.js';
import { SettingsService } from '../settings/settings.service.js';

type Db = PrismaService | Tx;

/** What the engine needs of a class. */
export interface PayInput {
  kind: string;
  stage: string;
  stageReason: string | null;
  durationMinutes: number;
  startsAt: Date;
}

/** The pay snapshot written on a class (`class_sessions.pay_*`, `billable`). */
export interface PaySnapshot {
  payHours: string;
  payRuleKey: string;
  payRuleSetId: number | null;
  billable: boolean;
}

export const CLEARED_PAY = {
  payHours: null,
  payRuleKey: null,
  payRuleSetId: null,
  billable: null,
} satisfies Prisma.ClassSessionUncheckedUpdateInput;

const rulesSchema = z.record(z.string(), payRuleSchema);

/** A stored rule set's rules, tolerant of a malformed row (falls back to the defaults). */
export function parseRules(value: unknown): Record<string, PayRule> {
  const parsed = rulesSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_PAY_RULES;
}

/**
 * Resolves the pay rule of a class entering a terminal stage and snapshots it on the row (D41,
 * docs/14 §2.9; Laravel `PayRuleEngine`). The set in force at the class start applies, so a new
 * set never rewrites history. Keys are matched most specific first (see `payRuleCandidates`).
 * pay hours = factor × duration / 60, rounded to hundredths.
 */
@Injectable()
export class PayRuleEngine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** The set in force at an instant (else the oldest set; none at all = the built-in defaults). */
  async setAt(
    at: Date,
    db: Db = this.prisma,
  ): Promise<{ id: number | null; rules: Record<string, PayRule> }> {
    const set =
      (await db.payRuleSet.findFirst({
        where: { effectiveFrom: { lte: at } },
        orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
      })) ?? (await db.payRuleSet.findFirst({ orderBy: { id: 'asc' } }));
    return set
      ? { id: set.id, rules: parseRules(set.rules) }
      : { id: null, rules: DEFAULT_PAY_RULES };
  }

  async resolve(
    s: PayInput,
    db: Db = this.prisma,
  ): Promise<{ key: string; factor: number; billable: boolean; setId: number | null }> {
    const set = await this.setAt(s.startsAt, db);
    for (const key of payRuleCandidates(s.kind, s.stage, s.stageReason)) {
      const rule = set.rules[key];
      if (!rule) continue;
      let factor = rule.factor;
      if (rule.paidHolidayOnly && !(await this.holidayIsPaid(s, db))) factor = 0;
      return { key, factor, billable: rule.billable, setId: set.id };
    }
    return { key: 'default', factor: 0, billable: false, setId: set.id };
  }

  async snapshot(s: PayInput, db: Db = this.prisma): Promise<PaySnapshot> {
    const rule = await this.resolve(s, db);
    // factor has at most a few decimals: hundredths of an hour, rounded half-up.
    const centiHours = Math.round(rule.factor * s.durationMinutes * 100) / 60;
    return {
      payHours: (Math.round(centiHours) / 100).toFixed(2),
      payRuleKey: rule.key,
      payRuleSetId: rule.setId,
      billable: rule.billable,
    };
  }

  private async holidayIsPaid(s: PayInput, db: Db): Promise<boolean> {
    if (s.stageReason !== 'holiday') return true;
    const zone = await this.settings.get('academy.timezone');
    const holiday = await holidayOn(db, s.startsAt.getTime(), zone);
    return holiday ? holiday.paid : true;
  }
}

@Global()
@Module({ providers: [PayRuleEngine], exports: [PayRuleEngine] })
export class PayRulesModule {}
