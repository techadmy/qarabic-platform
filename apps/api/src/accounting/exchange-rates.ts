import { Controller, Delete, Get, HttpStatus, Injectable, Param, Put } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import {
  deleteExchangeRateSchema,
  type ExchangeRateDto,
  exchangeRateQuerySchema,
  upsertExchangeRateSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { CanAny, CurrentUser } from '../auth/decorators.js';
import { Clock } from '../common/clock.js';
import { ApiException, notFound } from '../common/errors.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { type ExchangeRate, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RateBook, type UsdTotal } from './fx.js';

type Out<S extends z.ZodType> = z.output<S>;

/** Loads the rates reports need (D144). */
@Injectable()
export class ExchangeRatesService {
  constructor(private readonly prisma: PrismaService) {}

  /** One query for every `currency × month` the totals touch. */
  async bookFor(...totals: UsdTotal[]): Promise<RateBook> {
    const currencies = new Set<string>();
    const months = new Set<string>();
    for (const t of totals)
      for (const k of t.keys()) {
        currencies.add(k.currency);
        months.add(k.month);
      }
    if (!currencies.size) return new RateBook([]);
    const rows = await this.prisma.exchangeRate.findMany({
      where: { currency: { in: [...currencies] }, month: { in: [...months] } },
      select: { currency: true, month: true, rateToUsd: true },
    });
    return new RateBook(rows);
  }
}

/**
 * `/accounting/exchange-rates` (D144, B124): the monthly rate of each billing currency to USD.
 * Accounts maintain it (`accounting.rates`, D146: without the ledger); billing and the owner read it
 * (`reports.financial`).
 */
@ApiTags('accounting')
@Controller('accounting/exchange-rates')
export class ExchangeRatesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  @CanAny('accounting.view', 'reports.financial')
  @Get()
  async list(
    @ZodQuery(exchangeRateQuerySchema) q: Out<typeof exchangeRateQuerySchema>,
  ): Promise<{ data: ExchangeRateDto[] }> {
    const rows = await this.prisma.exchangeRate.findMany({
      where: {
        ...(q.currency ? { currency: q.currency } : {}),
        ...(q.from || q.to
          ? { month: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
          : {}),
      },
      orderBy: [{ month: 'desc' }, { currency: 'asc' }],
      take: 1000,
    });
    return { data: await this.dtos(rows) };
  }

  /** Sets (or changes) the rate of a currency for a month; audited with the old value. */
  @CanAny('accounting.manage', 'accounting.rates')
  @Put()
  @ApiBody({ schema: jsonSchema(upsertExchangeRateSchema) })
  async upsert(
    @ZodBody(upsertExchangeRateSchema) body: Out<typeof upsertExchangeRateSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: ExchangeRateDto }> {
    const now = this.clock.now();
    const key = { currency: body.currency, month: body.month };
    const after = { ...key, rateToUsd: body.rateToUsd };

    if (!body.replace) {
      // A plain insert: the (currency, month) key also stops two first writes racing.
      try {
        const row = await this.prisma.$transaction(async (tx) => {
          const created = await tx.exchangeRate.create({
            data: {
              ...key,
              rateToUsd: body.rateToUsd,
              note: body.note ?? null,
              updatedById: actor.id,
              createdAt: now,
              updatedAt: now,
            },
          });
          await this.audit.record(
            {
              actorId: actor.id,
              action: 'exchange_rate_set',
              subjectType: 'exchange_rate',
              subjectId: created.id,
              after,
            },
            tx,
          );
          return created;
        });
        return { data: (await this.dtos([row]))[0]! };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
          throw error;
        }
        const current = await this.prisma.exchangeRate.findUniqueOrThrow({
          where: { currency_month: key },
        });
        throw new ApiException(HttpStatus.CONFLICT, {
          message: 'This month already has a rate. Send replace with a reason to change it.',
          code: 'rate_exists',
          data: (await this.dtos([current]))[0],
        });
      }
    }

    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "exchange_rates" WHERE currency = ${key.currency} AND month = ${key.month} FOR UPDATE`;
      const before = await tx.exchangeRate.findUnique({ where: { currency_month: key } });
      const saved = await tx.exchangeRate.upsert({
        where: { currency_month: key },
        create: {
          ...key,
          rateToUsd: body.rateToUsd,
          note: body.note ?? null,
          updatedById: actor.id,
          createdAt: now,
          updatedAt: now,
        },
        update: {
          rateToUsd: body.rateToUsd,
          ...(body.note !== undefined ? { note: body.note } : {}),
          updatedById: actor.id,
          updatedAt: now,
        },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: before ? 'exchange_rate_replaced' : 'exchange_rate_set',
          subjectType: 'exchange_rate',
          subjectId: saved.id,
          before: before ? { ...key, rateToUsd: before.rateToUsd.toString() } : null,
          after,
          reason: body.reason ?? null,
        },
        tx,
      );
      return saved;
    });
    return { data: (await this.dtos([row]))[0]! };
  }

  /** Removes a wrong rate (reason required: every report of that month changes). */
  @CanAny('accounting.manage', 'accounting.rates')
  @Delete(':id')
  @ApiBody({ schema: jsonSchema(deleteExchangeRateSchema) })
  async remove(
    @Param('id', IdPipe) id: number,
    @ZodBody(deleteExchangeRateSchema) body: Out<typeof deleteExchangeRateSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: { id: number } }> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.exchangeRate.findUnique({ where: { id } });
      if (!row) throw notFound();
      await tx.exchangeRate.delete({ where: { id } });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'exchange_rate_deleted',
          subjectType: 'exchange_rate',
          subjectId: id,
          before: { currency: row.currency, month: row.month, rateToUsd: row.rateToUsd.toString() },
          reason: body.reason,
        },
        tx,
      );
    });
    return { data: { id } };
  }

  private async dtos(rows: ExchangeRate[]): Promise<ExchangeRateDto[]> {
    const ids = [...new Set(rows.map((r) => r.updatedById).filter((x): x is number => !!x))];
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        })
      : [];
    return rows.map((r) => ({
      id: r.id,
      currency: r.currency,
      month: r.month,
      rateToUsd: r.rateToUsd.toFixed(8).replace(/\.?0+$/, ''),
      note: r.note,
      updatedAt: r.updatedAt.toISOString(),
      updatedBy: users.find((u) => u.id === r.updatedById) ?? null,
    }));
  }
}
