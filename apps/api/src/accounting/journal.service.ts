import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  CreateJournalEntryInput,
  JournalEntryDto,
  JournalEntryRowDto,
  JournalListQuery,
  Paginated,
} from '@qarabic/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { pageArgs, pageMeta } from '../common/pagination.js';
import { contains } from '../common/search.js';
import type { Prisma } from '../generated/prisma/client.js';
import { cents, fromCents } from '../payroll/money.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fromDbDate, localDate, toDbDate } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { accountingError } from './errors.js';
import { LedgerService } from './ledger.service.js';

const entryInclude = {
  lines: {
    orderBy: { position: 'asc' },
    include: { account: { select: { code: true, nameAr: true, nameEn: true } } },
  },
  createdBy: { select: { id: true, name: true } },
  reversedBy: { select: { id: true } },
  voucher: { select: { id: true } },
  voidOf: { select: { id: true } },
} satisfies Prisma.JournalEntryInclude;

type EntryRow = Prisma.JournalEntryGetPayload<{ include: typeof entryInclude }>;

/** The journal: list, show, manual entries and reversals. */
@Injectable()
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
  ) {}

  async today(): Promise<string> {
    return localDate(this.clock.nowMs(), await this.settings.get('academy.timezone'));
  }

  async list(q: JournalListQuery): Promise<Paginated<JournalEntryRowDto>> {
    const where: Prisma.JournalEntryWhereInput = {
      ...(q.currency ? { currency: q.currency } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...(q.accountId ? { lines: { some: { accountId: q.accountId } } } : {}),
      ...(q.from || q.to
        ? {
            entryDate: {
              ...(q.from ? { gte: toDbDate(q.from) } : {}),
              ...(q.to ? { lte: toDbDate(q.to) } : {}),
            },
          }
        : {}),
      ...(q.q
        ? {
            OR: [{ number: contains(q.q) }, { memo: contains(q.q) }],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.journalEntry.findMany({
        where,
        include: entryInclude,
        orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
        ...pageArgs(q),
      }),
      this.prisma.journalEntry.count({ where }),
    ]);
    return {
      data: rows.map((r) => withoutLines(present(r))),
      meta: pageMeta(q, total, {}),
    };
  }

  async show(id: number): Promise<JournalEntryDto> {
    const row = await this.prisma.journalEntry.findUnique({ where: { id }, include: entryInclude });
    if (!row) throw notFound();
    return present(row);
  }

  async create(
    input: CreateJournalEntryInput & { lines: Array<{ debit?: string; credit?: string }> },
    by: AuthUser,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const id = await this.ledger.post(tx, {
        date: input.date,
        currency: String(input.currency),
        memo: input.memo,
        source: 'manual',
        createdById: by.id,
        lines: input.lines.map((l) => ({
          accountId: l.accountId,
          debit: cents(l.debit ?? null),
          credit: cents(l.credit ?? null),
          description: l.description ?? null,
        })),
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'journal_entry_posted',
          subjectType: 'journal_entry',
          subjectId: id,
          after: { date: input.date, currency: input.currency, memo: input.memo },
        },
        tx,
      );
      return id;
    });
  }

  async reverse(
    id: number,
    input: { reason: string; date?: string },
    by: AuthUser,
  ): Promise<number> {
    const date = input.date ?? (await this.today());
    return this.prisma.$transaction(async (tx) => {
      const entry = await tx.journalEntry.findUnique({
        where: { id },
        select: {
          id: true,
          number: true,
          source: true,
          voucher: { select: { id: true } },
          voidOf: { select: { id: true } },
        },
      });
      if (!entry) throw notFound();
      if (entry.voucher || entry.voidOf) {
        throw accountingError('reverse_voucher_entry', HttpStatus.CONFLICT);
      }
      const reversal = await this.ledger.reverse(tx, id, {
        date,
        memo: `Reversal of ${entry.number}: ${input.reason}`,
        createdById: by.id,
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'journal_entry_reversed',
          subjectType: 'journal_entry',
          subjectId: id,
          after: { reversalId: reversal, date },
          reason: input.reason,
        },
        tx,
      );
      return reversal;
    });
  }
}

/** A list row: the DTO without its lines. */
export function withoutLines<T extends { lines: unknown }>(dto: T): Omit<T, 'lines'> {
  const copy: Partial<T> = { ...dto };
  delete copy.lines;
  return copy as Omit<T, 'lines'>;
}

export function present(r: EntryRow): JournalEntryDto {
  let total = 0;
  for (const l of r.lines) total += cents(l.debit);
  return {
    id: r.id,
    number: r.number,
    date: fromDbDate(r.entryDate),
    currency: r.currency,
    memo: r.memo,
    source: r.source,
    sourceRef: r.sourceRef,
    reversesId: r.reversesId,
    reversedById: r.reversedBy?.id ?? null,
    voucherId: r.voucher?.id ?? r.voidOf?.id ?? null,
    total: fromCents(total),
    createdBy: r.createdBy ? { id: r.createdBy.id, name: r.createdBy.name } : null,
    createdAt: r.createdAt.toISOString(),
    lines: r.lines.map((l) => ({
      id: l.id,
      accountId: l.accountId,
      accountCode: l.account.code,
      accountNameAr: l.account.nameAr,
      accountNameEn: l.account.nameEn,
      debit: l.debit.toFixed(2),
      credit: l.credit.toFixed(2),
      description: l.description,
      partyType: (l.partyType as 'family' | 'user' | null) ?? null,
      partyId: l.partyId,
    })),
  };
}
