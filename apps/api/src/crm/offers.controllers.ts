import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  assignTrialOfferSchema,
  cancelTrialOfferSchema,
  createTrialOfferSchema,
  resendTrialOfferSchema,
  type MyTrialOfferDto,
  type TrialOfferDto,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CurrentUser } from '../auth/decorators.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { TrialOffers } from './offers.service.js';

type Out<S extends z.ZodType> = z.output<S>;

/** Open trial offers on a lead (T3, docs/33 §4.3): the CSR side. */
@ApiTags('leads')
@Controller('leads')
export class LeadTrialOffersController {
  constructor(private readonly offers: TrialOffers) {}

  @Can('leads.manage', 'schedule.manage')
  @Get(':id/trial-offers')
  async list(@Param('id', IdPipe) id: number): Promise<{ data: TrialOfferDto[] }> {
    return { data: await this.offers.listForLead(id) };
  }

  @Can('leads.manage', 'schedule.manage')
  @Post(':id/trial-offers')
  @ApiOperation({ summary: 'Offer a trial to the eligible teachers (or a shortlist)' })
  @ApiBody({ schema: jsonSchema(createTrialOfferSchema) })
  async create(
    @Param('id', IdPipe) id: number,
    @ZodBody(createTrialOfferSchema) body: Out<typeof createTrialOfferSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: TrialOfferDto }> {
    const offerId = await this.offers.create(id, body, actor);
    return { data: await this.offers.show(offerId) };
  }
}

/** One offer: assign a teacher, send again, cancel. */
@ApiTags('leads')
@Controller('trial-offers')
export class TrialOffersController {
  constructor(private readonly offers: TrialOffers) {}

  @Can('leads.manage', 'schedule.manage')
  @Get(':id')
  async show(@Param('id', IdPipe) id: number): Promise<{ data: TrialOfferDto }> {
    return { data: await this.offers.show(id) };
  }

  @Can('leads.manage', 'schedule.manage')
  @Post(':id/assign')
  @HttpCode(200)
  @ApiOperation({ summary: 'Book one of the offer’s teachers (e.g. a volunteer)' })
  @ApiBody({ schema: jsonSchema(assignTrialOfferSchema) })
  async assign(
    @Param('id', IdPipe) id: number,
    @ZodBody(assignTrialOfferSchema) body: Out<typeof assignTrialOfferSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: TrialOfferDto }> {
    await this.offers.assign(id, body, actor);
    return { data: await this.offers.show(id) };
  }

  @Can('leads.manage', 'schedule.manage')
  @Post(':id/resend')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(resendTrialOfferSchema) })
  async resend(
    @Param('id', IdPipe) id: number,
    @ZodBody(resendTrialOfferSchema) body: Out<typeof resendTrialOfferSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: TrialOfferDto }> {
    await this.offers.resend(id, body, actor);
    return { data: await this.offers.show(id) };
  }

  @Can('leads.manage', 'schedule.manage')
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(cancelTrialOfferSchema) })
  async cancel(
    @Param('id', IdPipe) id: number,
    @ZodBody(cancelTrialOfferSchema) body: Out<typeof cancelTrialOfferSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: TrialOfferDto }> {
    await this.offers.cancel(id, body, actor);
    return { data: await this.offers.show(id) };
  }
}

/**
 * The teacher's «عروض الحصص التجريبية»: open offers made to them, and the recent ones with how they
 * ended. A teacher only sees offers sent to them; no family name or contact ever.
 */
@ApiTags('teacher')
@Controller('me/trial-offers')
export class MyTrialOffersController {
  constructor(private readonly offers: TrialOffers) {}

  @Can('sessions.conduct')
  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<{ data: MyTrialOfferDto[] }> {
    return { data: await this.offers.mine(user) };
  }

  @Can('sessions.conduct')
  @Post(':id/accept')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept (first to accept wins) or volunteer, by the offer’s policy',
  })
  async accept(
    @Param('id', IdPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: MyTrialOfferDto | null }> {
    await this.offers.respond(id, 'accept', user);
    return { data: (await this.offers.mine(user)).find((o) => o.id === id) ?? null };
  }

  @Can('sessions.conduct')
  @Post(':id/decline')
  @HttpCode(200)
  async decline(
    @Param('id', IdPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): Promise<{ data: MyTrialOfferDto | null }> {
    await this.offers.respond(id, 'decline', user);
    return { data: (await this.offers.mine(user)).find((o) => o.id === id) ?? null };
  }
}
