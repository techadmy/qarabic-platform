import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  AccountListQuery,
  AccountType,
  LedgerAccountDto,
  SystemAccountKey,
} from '@qarabic/shared';
import { createAccountSchema, updateAccountSchema } from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { AuditService, diff } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { contains } from '../common/search.js';
import type { LedgerAccount, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { accountingError } from './errors.js';

type CreateInput = z.output<typeof createAccountSchema>;
type UpdateInput = z.output<typeof updateAccountSchema>;
type Tx = Prisma.TransactionClient;

/** The chart of accounts: a tree of group accounts (headings) and postable accounts. */
@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(q: AccountListQuery): Promise<LedgerAccountDto[]> {
    const where: Prisma.LedgerAccountWhereInput = {
      ...(q.type ? { type: q.type } : {}),
      ...(q.only === 'active' ? { isActive: true } : {}),
      ...(q.only === 'postable' ? { isActive: true, isGroup: false } : {}),
      ...(q.q
        ? {
            OR: [
              { code: { startsWith: q.q } },
              { nameAr: contains(q.q) },
              { nameEn: contains(q.q) },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.ledgerAccount.findMany({ where, orderBy: { code: 'asc' } });
    return rows.map(present);
  }

  async show(id: number): Promise<LedgerAccountDto> {
    const row = await this.prisma.ledgerAccount.findUnique({ where: { id } });
    if (!row) throw notFound();
    return present(row);
  }

  private async checkParent(
    tx: Tx,
    parentId: number | null | undefined,
    type: AccountType,
    selfId?: number,
  ): Promise<void> {
    if (parentId === null || parentId === undefined) return;
    const parent = await tx.ledgerAccount.findUnique({ where: { id: parentId } });
    if (!parent || !parent.isGroup || parent.type !== type || parent.id === selfId) {
      throw accountingError('parent_invalid', HttpStatus.UNPROCESSABLE_ENTITY, 'parentId');
    }
    // No cycles: the new parent may not sit under this account.
    let cursor: number | null = parent.parentId;
    for (let i = 0; cursor && i < 50; i++) {
      if (cursor === selfId) {
        throw accountingError('parent_invalid', HttpStatus.UNPROCESSABLE_ENTITY, 'parentId');
      }
      cursor =
        (await tx.ledgerAccount.findUnique({ where: { id: cursor }, select: { parentId: true } }))
          ?.parentId ?? null;
    }
  }

  async create(input: CreateInput, by: AuthUser): Promise<LedgerAccountDto> {
    return this.prisma.$transaction(async (tx) => {
      if (await tx.ledgerAccount.findUnique({ where: { code: input.code } })) {
        throw accountingError('code_taken', HttpStatus.UNPROCESSABLE_ENTITY, 'code');
      }
      await this.checkParent(tx, input.parentId, input.type);
      const row = await tx.ledgerAccount.create({
        data: {
          code: input.code,
          nameAr: input.nameAr,
          nameEn: input.nameEn,
          type: input.type,
          parentId: input.parentId ?? null,
          isGroup: input.isGroup,
          isCash: input.isGroup ? false : input.isCash,
          currency: input.currency ?? null,
          description: input.description,
        },
      });
      await this.audit.record(
        {
          actorId: by.id,
          action: 'ledger_account_created',
          subjectType: 'ledger_account',
          subjectId: row.id,
          after: { code: row.code, nameEn: row.nameEn, type: row.type },
        },
        tx,
      );
      return present(row);
    });
  }

  async update(id: number, input: UpdateInput, by: AuthUser): Promise<LedgerAccountDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.ledgerAccount.findUnique({ where: { id } });
      if (!before) throw notFound();
      if (input.parentId !== undefined) await this.checkParent(tx, input.parentId, before.type, id);
      if (input.isActive === false && before.isActive) {
        if (before.systemKey) throw accountingError('system_account', HttpStatus.CONFLICT);
        if (
          before.isGroup &&
          (await tx.ledgerAccount.count({ where: { parentId: id, isActive: true } }))
        ) {
          throw accountingError('group_has_children', HttpStatus.CONFLICT);
        }
      }
      const row = await tx.ledgerAccount.update({
        where: { id },
        data: {
          ...(input.nameAr !== undefined ? { nameAr: input.nameAr } : {}),
          ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          ...(input.isCash !== undefined && !before.isGroup ? { isCash: input.isCash } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          updatedAt: this.clock.now(),
        },
      });
      const changes = diff(present(before), present(row));
      if (changes) {
        await this.audit.record(
          {
            actorId: by.id,
            action: 'ledger_account_updated',
            subjectType: 'ledger_account',
            subjectId: id,
            before: changes[0],
            after: changes[1],
          },
          tx,
        );
      }
      return present(row);
    });
  }
}

export function present(r: LedgerAccount): LedgerAccountDto {
  return {
    id: r.id,
    code: r.code,
    nameAr: r.nameAr,
    nameEn: r.nameEn,
    type: r.type,
    parentId: r.parentId,
    isGroup: r.isGroup,
    isCash: r.isCash,
    currency: r.currency,
    systemKey: (r.systemKey as SystemAccountKey | null) ?? null,
    isActive: r.isActive,
    description: r.description,
  };
}
