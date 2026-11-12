import { HttpStatus, Injectable } from '@nestjs/common';
import type { AccountingPeriodDto } from '@qarabic/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { Period } from '../payroll/period.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { startOfLocalDay } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { accountingError } from './errors.js';
import { JournalService } from './journal.service.js';
import { OutboxService } from './outbox.service.js';

/**
 * Monthly period close: a closed month takes no new entry (API check + database trigger).
 * Closing needs the month to have ended and its automatic entries posted; reopening needs a
 * reason (audited). There are no closing entries: the balance sheet shows the year's result.
 */
@Injectable()
export class PeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly journal: JournalService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
  ) {}

  async list(year: number): Promise<AccountingPeriodDto[]> {
    const months = Array.from(
      { length: 12 },
      (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`,
    );
    const [rows, counts] = await Promise.all([
      this.prisma.accountingPeriod.findMany({
        where: { period: { in: months } },
        include: { closedBy: { select: { id: true, name: true } } },
      }),
      this.prisma.$queryRaw<Array<{ period: string; n: number }>>`
        SELECT to_char(entry_date, 'YYYY-MM') AS period, count(*)::int AS n
          FROM journal_entries
         WHERE entry_date >= ${new Date(Date.UTC(year, 0, 1))}
           AND entry_date < ${new Date(Date.UTC(year + 1, 0, 1))}
         GROUP BY 1`,
    ]);
    const byPeriod = new Map(rows.map((r) => [r.period, r]));
    const entries = new Map(counts.map((c) => [c.period, c.n]));
    return months.map((period) => {
      const row = byPeriod.get(period);
      return {
        period,
        status: row?.closed ? 'closed' : 'open',
        closedAt: row?.closed ? (row.closedAt?.toISOString() ?? null) : null,
        closedBy: row?.closed ? (row.closedBy ?? null) : null,
        reopenReason: row?.reopenReason ?? null,
        entries: entries.get(period) ?? 0,
      };
    });
  }

  async close(period: string, by: AuthUser): Promise<void> {
    const p = Period.parse(period);
    const today = await this.journal.today();
    if (today <= p.endsOn()) throw accountingError('period_not_ended', HttpStatus.CONFLICT);
    const zone = await this.settings.get('academy.timezone');
    const end = new Date(startOfLocalDay(p.next().startsOn(), zone));
    if ((await this.outbox.pendingBefore(end)) > 0) {
      throw accountingError('outbox_pending', HttpStatus.CONFLICT);
    }
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.accountingPeriod.findUnique({ where: { period } });
      if (row?.closed) throw accountingError('period_already_closed', HttpStatus.CONFLICT);
      const now = this.clock.now();
      await tx.accountingPeriod.upsert({
        where: { period },
        create: { period, closed: true, closedAt: now, closedById: by.id, updatedAt: now },
        update: { closed: true, closedAt: now, closedById: by.id, updatedAt: now },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'period_closed',
          subjectType: 'accounting_period',
          subjectId: null,
          after: { period },
        },
        tx,
      );
    });
  }

  async reopen(period: string, reason: string, by: AuthUser): Promise<void> {
    Period.parse(period);
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.accountingPeriod.findUnique({ where: { period } });
      if (!row?.closed) throw accountingError('period_not_closed', HttpStatus.CONFLICT);
      await tx.accountingPeriod.update({
        where: { period },
        data: { closed: false, reopenReason: reason, updatedAt: this.clock.now() },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'period_reopened',
          subjectType: 'accounting_period',
          subjectId: null,
          after: { period },
          reason,
        },
        tx,
      );
    });
  }
}
