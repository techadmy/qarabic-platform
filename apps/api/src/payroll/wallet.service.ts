import { Injectable } from '@nestjs/common';
import type { MyWalletDto, WalletRowDto } from '@qarabic/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { isoZ } from '../schedule/time.js';
import { money, person, personSelect } from './presenter.js';

/**
 * The teacher wallet (D93; Laravel `PayslipController::myWallet`, `wallets`): an append-only ledger
 * of approved salaries (credit), recorded payments (debit) and reopen reversals. A balance is the
 * sum per currency. Withdrawal requests (B47) are not built.
 */
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  async mine(userId: number): Promise<MyWalletDto> {
    const [sums, rows] = await Promise.all([
      this.prisma.walletTransaction.groupBy({
        by: ['currency'],
        where: { userId },
        _sum: { amount: true },
        orderBy: { currency: 'asc' },
      }),
      this.prisma.walletTransaction.findMany({
        where: { userId },
        include: { payslip: { select: { run: { select: { period: true } } } } },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
    ]);
    return {
      balances: sums.map((s) => ({ currency: s.currency, balance: money(s._sum.amount) })),
      transactions: rows.map((t) => ({
        id: t.id,
        type: t.type,
        currency: t.currency,
        amount: money(t.amount),
        payslipId: t.payslipId,
        period: t.payslip?.run.period ?? null,
        reference: t.reference,
        occurredAt: isoZ(t.occurredAt)!,
      })),
    };
  }

  /** Balances of everyone with wallet activity (`wallet.manage`). */
  async all(): Promise<WalletRowDto[]> {
    const sums = await this.prisma.walletTransaction.groupBy({
      by: ['userId', 'currency'],
      _sum: { amount: true },
      _max: { occurredAt: true },
    });
    const users = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: [...new Set(sums.map((s) => s.userId))] } },
          ...personSelect,
        })
      ).map((u) => [u.id, u]),
    );
    return sums
      .map((s) => ({
        user: person(users.get(s.userId)!),
        currency: s.currency,
        balance: money(s._sum.amount),
        lastAt: isoZ(s._max.occurredAt),
      }))
      .sort(
        (a, b) => a.user.name.localeCompare(b.user.name) || a.currency.localeCompare(b.currency),
      );
  }
}
