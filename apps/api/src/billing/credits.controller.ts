import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import {
  familyCreditQuerySchema,
  reviewFamilyCreditSchema,
  type FamilyCreditDto,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CanAny, CurrentUser } from '../auth/decorators.js';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Out<S extends z.ZodType> = z.output<S>;

const include = {
  family: { select: { id: true, user: { select: { name: true } } } },
  sourcePayment: { select: { id: true, invoiceId: true, method: true } },
} satisfies Prisma.FamilyCreditInclude;
type Row = Prisma.FamilyCreditGetPayload<{ include: typeof include }>;

/**
 * P1-1 (docs/39 BIL-1, B115): family credits from overpayments. The review list is the open
 * credits nobody marked reviewed; the credit itself is used automatically on the next invoice.
 */
@ApiTags('billing')
@Controller('billing/credits')
export class FamilyCreditsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /** Staff only: parents hold `invoices.view` for their own invoices, not this list. */
  @CanAny('invoices.manage', 'reports.financial')
  @Get()
  async list(
    @ZodQuery(familyCreditQuerySchema) q: Out<typeof familyCreditQuerySchema>,
  ): Promise<{ data: FamilyCreditDto[] }> {
    const rows = await this.prisma.familyCredit.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.familyId ? { familyId: q.familyId } : {}),
        ...(q.needsReview === true ? { reviewedAt: null } : {}),
        ...(q.needsReview === false ? { reviewedAt: { not: null } } : {}),
      },
      include,
      orderBy: [{ id: 'desc' }],
      take: 500,
    });
    return { data: await this.dtos(rows) };
  }

  @Can('invoices.manage')
  @Post(':id/review')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(reviewFamilyCreditSchema) })
  async review(
    @Param('id', IdPipe) id: number,
    @ZodBody(reviewFamilyCreditSchema) body: Out<typeof reviewFamilyCreditSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: FamilyCreditDto }> {
    if (!(await this.prisma.familyCredit.findUnique({ where: { id } }))) throw notFound();
    const now = this.clock.now();
    const row = await this.prisma.familyCredit.update({
      where: { id },
      data: {
        reviewedAt: now,
        reviewedById: actor.id,
        ...(body.note !== undefined ? { note: body.note } : {}),
        updatedAt: now,
      },
      include,
    });
    if (row.sourcePaymentId) {
      await this.prisma.payment.update({
        where: { id: row.sourcePaymentId },
        data: { needsReview: false },
      });
    }
    await this.audit.record({
      actorId: actor.id,
      action: 'credit_reviewed',
      subjectType: 'family_credit',
      subjectId: id,
      after: { note: body.note ?? null },
    });
    return { data: (await this.dtos([row]))[0]! };
  }

  private async dtos(rows: Row[]): Promise<FamilyCreditDto[]> {
    const ids = [
      ...new Set(rows.map((r) => r.reviewedById).filter((x): x is number => x !== null)),
    ];
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        })
      : [];
    return rows.map((r) => ({
      id: r.id,
      family: { id: r.family.id, name: r.family.user.name },
      currency: r.currency,
      amount: r.amount.toFixed(2),
      remaining: r.remaining.toFixed(2),
      status: r.status,
      sourcePayment: r.sourcePayment,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      reviewedBy: users.find((u) => u.id === r.reviewedById) ?? null,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
