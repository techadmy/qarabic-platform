import { Injectable, Logger } from '@nestjs/common';
import type { OutboxRunResultDto, OutboxSource, OutboxStatusDto } from '@qarabic/shared';
import { Clock } from '../common/clock.js';
import type { Prisma } from '../generated/prisma/client.js';
import { cents } from '../payroll/money.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { localDate } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { LedgerService } from './ledger.service.js';
import { billingEntry, type DraftEntry, payrollEntry } from './rules.js';

type Tx = Prisma.TransactionClient;

const BATCH = 200;
const MAX_PER_RUN = 5000;

/**
 * Consumes the billing and payroll outboxes (D86, D95): each unconsumed event, in id order, becomes
 * at most one journal entry (`source_ref` = `billing_event:<id>` / `payroll_event:<id>`) and gets
 * `consumed_at`, in one transaction. An event that cannot be posted is listed in
 * `ledger_outbox_failures` and retried on the next run; the others go on. Events of a closed month
 * are dated on the first day of the next open month.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
  ) {}

  async process(): Promise<OutboxRunResultDto> {
    const zone = await this.settings.get('academy.timezone');
    const result = { posted: 0, skipped: 0, failed: 0 };
    for (const source of ['billing', 'payroll'] as const) {
      let after = 0;
      let seen = 0;
      while (seen < MAX_PER_RUN) {
        const ids = await this.pendingIds(source, after);
        if (ids.length === 0) break;
        for (const id of ids) {
          const outcome = await this.consume(source, id, zone);
          result[outcome] += 1;
        }
        seen += ids.length;
        after = ids[ids.length - 1]!;
      }
    }
    if (result.failed) this.logger.warn(`Ledger outbox: ${result.failed} event(s) failed.`);
    return result;
  }

  private async pendingIds(source: OutboxSource, after: number): Promise<number[]> {
    const where = { consumedAt: null, id: { gt: after } };
    const rows =
      source === 'billing'
        ? await this.prisma.billingEvent.findMany({
            where,
            orderBy: { id: 'asc' },
            take: BATCH,
            select: { id: true },
          })
        : await this.prisma.payrollEvent.findMany({
            where,
            orderBy: { id: 'asc' },
            take: BATCH,
            select: { id: true },
          });
    return rows.map((r) => r.id);
  }

  private async consume(
    source: OutboxSource,
    id: number,
    zone: string,
  ): Promise<'posted' | 'skipped' | 'failed'> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const draft = await this.draft(tx, source, id, zone);
        if (draft === 'locked') return 'skipped';
        const sourceRef = `${source}_event:${id}`;
        let posted = false;
        if (draft.entry && !(await tx.journalEntry.findUnique({ where: { sourceRef } }))) {
          await this.postDraft(tx, draft.entry, source, sourceRef);
          posted = true;
        }
        const now = this.clock.now();
        if (source === 'billing') {
          await tx.billingEvent.update({ where: { id }, data: { consumedAt: now } });
        } else {
          await tx.payrollEvent.update({ where: { id }, data: { consumedAt: now } });
        }
        await tx.ledgerOutboxFailure.deleteMany({ where: { source, eventId: id } });
        return posted ? 'posted' : 'skipped';
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      const now = this.clock.now();
      const event =
        source === 'billing'
          ? await this.prisma.billingEvent.findUnique({ where: { id }, select: { type: true } })
          : await this.prisma.payrollEvent.findUnique({ where: { id }, select: { type: true } });
      const eventType = event?.type ?? '?';
      await this.prisma.ledgerOutboxFailure.upsert({
        where: { source_eventId: { source, eventId: id } },
        create: { source, eventId: id, eventType, error: message, lastAttemptAt: now },
        update: { eventType, error: message, attempts: { increment: 1 }, lastAttemptAt: now },
      });
      return 'failed';
    }
  }

  /** Locks the event (skipping one another worker holds) and maps it to an entry. */
  private async draft(
    tx: Tx,
    source: OutboxSource,
    id: number,
    zone: string,
  ): Promise<'locked' | { entry: DraftEntry | null }> {
    if (source === 'billing') {
      const locked = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM billing_events WHERE id = ${id} AND consumed_at IS NULL FOR UPDATE SKIP LOCKED`;
      if (locked.length === 0) return 'locked';
      const e = await tx.billingEvent.findUniqueOrThrow({ where: { id } });
      return {
        entry: billingEntry({
          id: e.id,
          type: e.type,
          subjectType: e.subjectType,
          subjectId: e.subjectId,
          familyId: e.familyId,
          amount: cents(e.amount),
          currency: e.currency,
          payload: (e.payload ?? {}) as Record<string, unknown>,
          date: localDate(e.occurredAt.getTime(), zone),
        }),
      };
    }
    const locked = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM payroll_events WHERE id = ${id} AND consumed_at IS NULL FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return 'locked';
    const e = await tx.payrollEvent.findUniqueOrThrow({ where: { id } });
    return {
      entry: payrollEntry({
        id: e.id,
        type: e.type,
        aggregateId: e.aggregateId,
        payload: (e.payload ?? {}) as Record<string, unknown>,
        date: localDate(e.occurredAt.getTime(), zone),
      }),
    };
  }

  private async postDraft(
    tx: Tx,
    entry: DraftEntry,
    source: OutboxSource,
    sourceRef: string,
  ): Promise<void> {
    const accounts = await this.ledger.systemAccounts(tx);
    const date = await this.ledger.firstOpenDate(tx, entry.date);
    const memo = date === entry.date ? entry.memo : `${entry.memo} (dated ${entry.date})`;
    await this.ledger.post(tx, {
      date,
      currency: entry.currency,
      memo,
      source,
      sourceRef,
      createdById: null,
      lines: entry.lines.map((l) => {
        const accountId = accounts.get(l.key);
        if (!accountId) throw new Error(`System account "${l.key}" is missing.`);
        return { ...l, accountId };
      }),
    });
  }

  async status(): Promise<OutboxStatusDto> {
    const [billing, payroll, oldestB, oldestP, failures] = await Promise.all([
      this.prisma.billingEvent.count({ where: { consumedAt: null } }),
      this.prisma.payrollEvent.count({ where: { consumedAt: null } }),
      this.prisma.billingEvent.findFirst({
        where: { consumedAt: null },
        orderBy: { id: 'asc' },
        select: { occurredAt: true },
      }),
      this.prisma.payrollEvent.findFirst({
        where: { consumedAt: null },
        orderBy: { id: 'asc' },
        select: { occurredAt: true },
      }),
      this.prisma.ledgerOutboxFailure.findMany({ orderBy: { id: 'asc' }, take: 100 }),
    ]);
    const oldest = [oldestB?.occurredAt, oldestP?.occurredAt]
      .filter((d): d is Date => Boolean(d))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    return {
      pending: { billing, payroll },
      oldestPendingAt: oldest?.toISOString() ?? null,
      failures: failures.map((f) => ({
        source: f.source as OutboxSource,
        eventId: f.eventId,
        eventType: f.eventType,
        error: f.error,
        attempts: f.attempts,
        lastAttemptAt: f.lastAttemptAt.toISOString(),
      })),
    };
  }

  /** Unconsumed events that happened before `before` (period close refuses while any are left). */
  async pendingBefore(before: Date): Promise<number> {
    const where = { consumedAt: null, occurredAt: { lt: before } };
    const [b, p] = await Promise.all([
      this.prisma.billingEvent.count({ where }),
      this.prisma.payrollEvent.count({ where }),
    ]);
    return b + p;
  }
}
