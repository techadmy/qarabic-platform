import { HttpStatus, Injectable } from '@nestjs/common';
import type { JournalSource, SystemAccountKey } from '@qarabic/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { notFound } from '../common/errors.js';
import { cents, fromCents } from '../payroll/money.js';
import { Period } from '../payroll/period.js';
import { toDbDate } from '../schedule/time.js';
import { accountingError } from './errors.js';

type Tx = Prisma.TransactionClient;

export interface PostLine {
  accountId: number;
  /** Minor units; exactly one of debit / credit is > 0. */
  debit: number;
  credit: number;
  description?: string | null;
  partyType?: 'family' | 'user' | null;
  partyId?: number | null;
}

export interface PostEntry {
  date: string;
  currency: string;
  memo: string;
  source: JournalSource;
  sourceRef?: string | null;
  reversesId?: number | null;
  createdById?: number | null;
  lines: PostLine[];
}

/**
 * The journal (M7). Every write goes through {@link LedgerService.post}: it checks the accounts
 * (postable, active, currency), the balance and the period, numbers the entry (`JE-2026-000001`)
 * and inserts it with its lines in the caller's transaction. The database checks the same rules
 * again (append-only, deferred balance trigger, closed-period trigger).
 */
@Injectable()
export class LedgerService {
  /** Next number of a sequence (`JE`, `RV`, `PV`) in a year, locked by the upsert. */
  async nextNumber(tx: Tx, prefix: string, year: string): Promise<string> {
    const key = `${prefix}-${year}`;
    const row = await tx.accountingSequence.upsert({
      where: { key },
      create: { key, last: 1 },
      update: { last: { increment: 1 } },
    });
    const width = prefix === 'JE' ? 6 : 5;
    return `${key}-${String(row.last).padStart(width, '0')}`;
  }

  async isClosed(tx: Tx, date: string): Promise<boolean> {
    const row = await tx.accountingPeriod.findUnique({
      where: { period: Period.ofDate(date).toString() },
    });
    return Boolean(row?.closed);
  }

  /** The first date on or after `date` whose period is open (automatic entries of a closed month). */
  async firstOpenDate(tx: Tx, date: string): Promise<string> {
    let d = date;
    for (let i = 0; i < 240 && (await this.isClosed(tx, d)); i++) {
      d = Period.ofDate(d).next().startsOn();
    }
    return d;
  }

  async systemAccounts(tx: Tx): Promise<Map<SystemAccountKey, number>> {
    const rows = await tx.ledgerAccount.findMany({
      where: { systemKey: { not: null } },
      select: { id: true, systemKey: true },
    });
    return new Map(rows.map((r) => [r.systemKey as SystemAccountKey, r.id]));
  }

  async post(tx: Tx, input: PostEntry): Promise<number> {
    const lines = input.lines.filter((l) => l.debit > 0 || l.credit > 0);
    if (lines.length < 2) throw accountingError('unbalanced', HttpStatus.UNPROCESSABLE_ENTITY);
    let debit = 0;
    let credit = 0;
    for (const l of lines) {
      if (l.debit < 0 || l.credit < 0 || (l.debit > 0 && l.credit > 0)) {
        throw accountingError('unbalanced', HttpStatus.UNPROCESSABLE_ENTITY, 'lines');
      }
      debit += l.debit;
      credit += l.credit;
    }
    if (debit !== credit)
      throw accountingError('unbalanced', HttpStatus.UNPROCESSABLE_ENTITY, 'lines');

    const ids = [...new Set(lines.map((l) => l.accountId))];
    const accounts = await tx.ledgerAccount.findMany({
      where: { id: { in: ids } },
      select: { id: true, isGroup: true, isActive: true, currency: true },
    });
    if (accounts.length !== ids.length || accounts.some((a) => a.isGroup || !a.isActive)) {
      throw accountingError('account_not_postable', HttpStatus.UNPROCESSABLE_ENTITY, 'lines');
    }
    if (accounts.some((a) => a.currency && a.currency !== input.currency)) {
      throw accountingError('account_currency', HttpStatus.UNPROCESSABLE_ENTITY, 'lines');
    }
    if (await this.isClosed(tx, input.date)) {
      throw accountingError('period_closed', HttpStatus.CONFLICT, 'date');
    }

    const number = await this.nextNumber(tx, 'JE', input.date.slice(0, 4));
    const entryDate = toDbDate(input.date);
    const entry = await tx.journalEntry.create({
      data: {
        number,
        entryDate,
        currency: input.currency,
        memo: input.memo.slice(0, 500),
        source: input.source,
        sourceRef: input.sourceRef ?? null,
        reversesId: input.reversesId ?? null,
        createdById: input.createdById ?? null,
        lines: {
          create: lines.map((l, i) => ({
            accountId: l.accountId,
            currency: input.currency,
            entryDate,
            debit: fromCents(l.debit),
            credit: fromCents(l.credit),
            description: l.description ?? null,
            partyType: l.partyType ?? null,
            partyId: l.partyId ?? null,
            position: i,
          })),
        },
      },
      select: { id: true },
    });
    return entry.id;
  }

  /** A reversing entry (debits and credits swapped), dated `date`. */
  async reverse(
    tx: Tx,
    entryId: number,
    opts: {
      date: string;
      memo: string;
      source?: JournalSource;
      sourceRef?: string | null;
      createdById: number | null;
    },
  ): Promise<number> {
    const original = await tx.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: { orderBy: { position: 'asc' } }, reversedBy: { select: { id: true } } },
    });
    if (!original) throw notFound();
    if (original.reversedBy) throw accountingError('already_reversed', HttpStatus.CONFLICT);
    return this.post(tx, {
      date: opts.date,
      currency: original.currency,
      memo: opts.memo,
      source: opts.source ?? 'reversal',
      sourceRef: opts.sourceRef ?? null,
      reversesId: original.id,
      createdById: opts.createdById,
      lines: original.lines.map((l) => ({
        accountId: l.accountId,
        debit: cents(l.credit),
        credit: cents(l.debit),
        description: l.description,
        partyType: l.partyType as 'family' | 'user' | null,
        partyId: l.partyId,
      })),
    });
  }
}
