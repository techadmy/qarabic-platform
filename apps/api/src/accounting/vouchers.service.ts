import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  Paginated,
  VoucherDto,
  VoucherListQuery,
  VoucherRowDto,
  createVoucherSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { pageArgs, pageMeta, statusCounts } from '../common/pagination.js';
import { contains } from '../common/search.js';
import type { Prisma } from '../generated/prisma/client.js';
import { cents, fromCents } from '../payroll/money.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fromDbDate, toDbDate } from '../schedule/time.js';
import { accountingError } from './errors.js';
import { JournalService, withoutLines } from './journal.service.js';
import { LedgerService } from './ledger.service.js';

type CreateInput = z.output<typeof createVoucherSchema>;

const account = { select: { id: true, code: true, nameAr: true, nameEn: true } } as const;
const voucherInclude = {
  cashAccount: account,
  lines: { orderBy: { position: 'asc' }, include: { account } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.VoucherInclude;
type VoucherRow = Prisma.VoucherGetPayload<{ include: typeof voucherInclude }>;

/**
 * Receipt (قبض) and payment (صرف) vouchers (old `voucher` + `account_entry`): a receipt debits the
 * cash account and credits each line's account; a payment the other way round. Posting is
 * immediate; voiding posts the reversing entry (the voucher stays, marked void).
 */
@Injectable()
export class VouchersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly journal: JournalService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(q: VoucherListQuery): Promise<Paginated<VoucherRowDto>> {
    const base: Prisma.VoucherWhereInput = {
      ...(q.type ? { type: q.type } : {}),
      ...(q.currency ? { currency: q.currency } : {}),
      ...(q.from || q.to
        ? {
            voucherDate: {
              ...(q.from ? { gte: toDbDate(q.from) } : {}),
              ...(q.to ? { lte: toDbDate(q.to) } : {}),
            },
          }
        : {}),
      ...(q.q
        ? {
            OR: [
              { number: contains(q.q) },
              { party: contains(q.q) },
              { description: contains(q.q) },
              { reference: contains(q.q) },
            ],
          }
        : {}),
    };
    const where = { ...base, ...(q.status ? { status: q.status } : {}) };
    const [rows, total, groups] = await Promise.all([
      this.prisma.voucher.findMany({
        where,
        include: voucherInclude,
        orderBy: [{ voucherDate: 'desc' }, { id: 'desc' }],
        ...pageArgs(q),
      }),
      this.prisma.voucher.count({ where }),
      this.prisma.voucher.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return {
      data: rows.map((r) => withoutLines(present(r))),
      meta: pageMeta(q, total, statusCounts(['posted', 'void'], groups)),
    };
  }

  async show(id: number): Promise<VoucherDto> {
    const row = await this.prisma.voucher.findUnique({ where: { id }, include: voucherInclude });
    if (!row) throw notFound();
    return present(row);
  }

  async create(input: CreateInput, by: AuthUser): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const cash = await tx.ledgerAccount.findUnique({ where: { id: input.cashAccountId } });
      if (!cash || !cash.isCash || cash.isGroup || !cash.isActive) {
        throw accountingError(
          'account_not_postable',
          HttpStatus.UNPROCESSABLE_ENTITY,
          'cashAccountId',
        );
      }
      const amounts = input.lines.map((l) => cents(l.amount));
      const total = amounts.reduce((a, b) => a + b, 0);
      const receipt = input.type === 'receipt';
      const number = await this.ledger.nextNumber(
        tx,
        receipt ? 'RV' : 'PV',
        input.date.slice(0, 4),
      );
      const entryId = await this.ledger.post(tx, {
        date: input.date,
        currency: input.currency,
        memo: `${number} ${input.party}: ${input.description}`,
        source: 'voucher',
        sourceRef: `voucher:${number}`,
        createdById: by.id,
        lines: [
          {
            accountId: cash.id,
            debit: receipt ? total : 0,
            credit: receipt ? 0 : total,
            description: input.reference ?? input.chequeNumber ?? null,
          },
          ...input.lines.map((l, i) => ({
            accountId: l.accountId,
            debit: receipt ? 0 : amounts[i]!,
            credit: receipt ? amounts[i]! : 0,
            description: l.description,
          })),
        ],
      });
      const voucher = await tx.voucher.create({
        data: {
          number,
          type: input.type,
          voucherDate: toDbDate(input.date),
          currency: input.currency,
          amount: fromCents(total),
          cashAccountId: cash.id,
          party: input.party,
          description: input.description,
          reference: input.reference,
          chequeNumber: input.chequeNumber,
          journalEntryId: entryId,
          createdById: by.id,
          lines: {
            create: input.lines.map((l, i) => ({
              accountId: l.accountId,
              amount: fromCents(amounts[i]!),
              description: l.description,
              position: i,
            })),
          },
        },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'voucher_posted',
          subjectType: 'voucher',
          subjectId: voucher.id,
          after: { number, type: input.type, amount: fromCents(total), currency: input.currency },
        },
        tx,
      );
      return voucher.id;
    });
  }

  async void(id: number, reason: string, by: AuthUser): Promise<void> {
    const date = await this.journal.today();
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT id FROM vouchers WHERE id = ${id} FOR UPDATE`;
      if (locked.length === 0) throw notFound();
      const v = await tx.voucher.findUniqueOrThrow({ where: { id } });
      if (v.status === 'void') throw accountingError('voucher_void', HttpStatus.CONFLICT);
      const reversal = await this.ledger.reverse(tx, v.journalEntryId, {
        date,
        memo: `Void ${v.number}: ${reason}`,
        source: 'voucher',
        sourceRef: `voucher_void:${v.number}`,
        createdById: by.id,
      });
      await tx.voucher.update({
        where: { id },
        data: {
          status: 'void',
          voidEntryId: reversal,
          voidReason: reason,
          voidedAt: this.clock.now(),
          voidedById: by.id,
        },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'voucher_voided',
          subjectType: 'voucher',
          subjectId: id,
          after: { reversalId: reversal, date },
          reason,
        },
        tx,
      );
    });
  }
}

function present(r: VoucherRow): VoucherDto {
  return {
    id: r.id,
    number: r.number,
    type: r.type,
    status: r.status,
    date: fromDbDate(r.voucherDate),
    currency: r.currency,
    amount: r.amount.toFixed(2),
    party: r.party,
    description: r.description,
    reference: r.reference,
    chequeNumber: r.chequeNumber,
    cashAccount: r.cashAccount,
    lines: r.lines.map((l) => ({
      accountId: l.accountId,
      accountCode: l.account.code,
      accountNameAr: l.account.nameAr,
      accountNameEn: l.account.nameEn,
      amount: l.amount.toFixed(2),
      description: l.description,
    })),
    journalEntryId: r.journalEntryId,
    voidEntryId: r.voidEntryId,
    voidReason: r.voidReason,
    voidedAt: r.voidedAt?.toISOString() ?? null,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  };
}
