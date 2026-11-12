import { Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import {
  type AccountingPeriodDto,
  type AccountStatementDto,
  accountListQuerySchema,
  accountStatementQuerySchema,
  type BalanceSheetDto,
  cashReportQuerySchema,
  type CashReportDto,
  createAccountSchema,
  createJournalEntrySchema,
  createVoucherSchema,
  type JournalEntryDto,
  type JournalEntryRowDto,
  journalListQuerySchema,
  type LedgerAccountDto,
  monthSchema,
  type OutboxRunResultDto,
  type OutboxStatusDto,
  type Paginated,
  periodListQuerySchema,
  type ProfitAndLossDto,
  reopenPeriodSchema,
  reportAsOfQuerySchema,
  reportRangeQuerySchema,
  reverseEntrySchema,
  type TrialBalanceDto,
  updateAccountSchema,
  type VoucherDto,
  voucherListQuerySchema,
  type VoucherRowDto,
  voidVoucherSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CurrentUser } from '../auth/decorators.js';
import { notFound } from '../common/errors.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { AccountsService } from './accounts.service.js';
import { JournalService } from './journal.service.js';
import { OutboxService } from './outbox.service.js';
import { PeriodsService } from './periods.service.js';
import { ReportsService } from './reports.service.js';
import { VouchersService } from './vouchers.service.js';

type Out<S extends z.ZodType> = z.output<S>;

function period(value: string): string {
  if (!monthSchema.safeParse(value).success) throw notFound();
  return value;
}

/** `/accounting/accounts`: the chart of accounts (docs/07 §أ.2). */
@ApiTags('accounting')
@Controller('accounting/accounts')
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly reports: ReportsService,
  ) {}

  @Can('accounting.view')
  @Get()
  async list(
    @ZodQuery(accountListQuerySchema) q: Out<typeof accountListQuerySchema>,
  ): Promise<{ data: LedgerAccountDto[] }> {
    return { data: await this.accounts.list(q) };
  }

  @Can('accounting.view')
  @Get(':id')
  async show(@Param('id', IdPipe) id: number): Promise<{ data: LedgerAccountDto }> {
    return { data: await this.accounts.show(id) };
  }

  @Can('accounting.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createAccountSchema) })
  async create(
    @ZodBody(createAccountSchema) body: Out<typeof createAccountSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: LedgerAccountDto }> {
    return { data: await this.accounts.create(body, by) };
  }

  @Can('accounting.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateAccountSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateAccountSchema) body: Out<typeof updateAccountSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: LedgerAccountDto }> {
    return { data: await this.accounts.update(id, body, by) };
  }

  /** The account's lines in a currency with a running balance (cash book, a family's account …). */
  @Can('accounting.view')
  @Get(':id/statement')
  statement(
    @Param('id', IdPipe) id: number,
    @ZodQuery(accountStatementQuerySchema) q: Out<typeof accountStatementQuerySchema>,
  ): Promise<AccountStatementDto> {
    return this.reports.statement(id, q);
  }
}

/** `/accounting/journal`: entries (append-only), manual entries and reversals. */
@ApiTags('accounting')
@Controller('accounting/journal')
export class JournalController {
  constructor(private readonly journal: JournalService) {}

  @Can('accounting.view')
  @Get()
  list(
    @ZodQuery(journalListQuerySchema) q: Out<typeof journalListQuerySchema>,
  ): Promise<Paginated<JournalEntryRowDto>> {
    return this.journal.list(q);
  }

  @Can('accounting.view')
  @Get(':id')
  async show(@Param('id', IdPipe) id: number): Promise<{ data: JournalEntryDto }> {
    return { data: await this.journal.show(id) };
  }

  @Can('accounting.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createJournalEntrySchema) })
  async create(
    @ZodBody(createJournalEntrySchema) body: Out<typeof createJournalEntrySchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: JournalEntryDto }> {
    const id = await this.journal.create(body, by);
    return { data: await this.journal.show(id) };
  }

  /** A reversing entry (the original stays); voucher entries are voided from the voucher. */
  @Can('accounting.manage')
  @Post(':id/reverse')
  @ApiBody({ schema: jsonSchema(reverseEntrySchema) })
  async reverse(
    @Param('id', IdPipe) id: number,
    @ZodBody(reverseEntrySchema) body: Out<typeof reverseEntrySchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: JournalEntryDto }> {
    const reversal = await this.journal.reverse(id, body, by);
    return { data: await this.journal.show(reversal) };
  }
}

/** `/accounting/vouchers`: receipt and payment vouchers. */
@ApiTags('accounting')
@Controller('accounting/vouchers')
export class VouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  @Can('accounting.view')
  @Get()
  list(
    @ZodQuery(voucherListQuerySchema) q: Out<typeof voucherListQuerySchema>,
  ): Promise<Paginated<VoucherRowDto>> {
    return this.vouchers.list(q);
  }

  @Can('accounting.view')
  @Get(':id')
  async show(@Param('id', IdPipe) id: number): Promise<{ data: VoucherDto }> {
    return { data: await this.vouchers.show(id) };
  }

  @Can('accounting.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createVoucherSchema) })
  async create(
    @ZodBody(createVoucherSchema) body: Out<typeof createVoucherSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: VoucherDto }> {
    const id = await this.vouchers.create(body, by);
    return { data: await this.vouchers.show(id) };
  }

  @Can('accounting.manage')
  @Post(':id/void')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(voidVoucherSchema) })
  async void(
    @Param('id', IdPipe) id: number,
    @ZodBody(voidVoucherSchema) body: Out<typeof voidVoucherSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: VoucherDto }> {
    await this.vouchers.void(id, body.reason, by);
    return { data: await this.vouchers.show(id) };
  }
}

/** `/accounting/periods`: monthly close and reopen. */
@ApiTags('accounting')
@Controller('accounting/periods')
export class PeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Can('accounting.view')
  @Get()
  async list(
    @ZodQuery(periodListQuerySchema) q: Out<typeof periodListQuerySchema>,
  ): Promise<{ data: AccountingPeriodDto[] }> {
    return { data: await this.periods.list(q.year) };
  }

  @Can('accounting.manage')
  @Post(':period/close')
  @HttpCode(200)
  async close(
    @Param('period') value: string,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: AccountingPeriodDto[] }> {
    const p = period(value);
    await this.periods.close(p, by);
    return { data: await this.periods.list(Number(p.slice(0, 4))) };
  }

  @Can('accounting.manage')
  @Post(':period/reopen')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(reopenPeriodSchema) })
  async reopen(
    @Param('period') value: string,
    @ZodBody(reopenPeriodSchema) body: Out<typeof reopenPeriodSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: AccountingPeriodDto[] }> {
    const p = period(value);
    await this.periods.reopen(p, body.reason, by);
    return { data: await this.periods.list(Number(p.slice(0, 4))) };
  }
}

/** `/accounting/outbox`: automatic entries from billing and payroll (status, post now). */
@ApiTags('accounting')
@Controller('accounting/outbox')
export class OutboxController {
  constructor(private readonly outbox: OutboxService) {}

  @Can('accounting.view')
  @Get()
  async status(): Promise<{ data: OutboxStatusDto }> {
    return { data: await this.outbox.status() };
  }

  @Can('accounting.manage')
  @Post('process')
  @HttpCode(200)
  async process(): Promise<{ data: OutboxRunResultDto }> {
    return { data: await this.outbox.process() };
  }
}

/** `/accounting/reports/…`: trial balance, P&L, balance sheet, cash per currency. */
@ApiTags('accounting')
@Controller('accounting/reports')
export class AccountingReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Can('accounting.view')
  @Get('trial-balance')
  async trialBalance(
    @ZodQuery(reportRangeQuerySchema) q: Out<typeof reportRangeQuerySchema>,
  ): Promise<{ data: TrialBalanceDto }> {
    return { data: await this.reports.trialBalance(q.currency, q.from, q.to) };
  }

  @Can('accounting.view')
  @Get('profit-and-loss')
  async profitAndLoss(
    @ZodQuery(reportRangeQuerySchema) q: Out<typeof reportRangeQuerySchema>,
  ): Promise<{ data: ProfitAndLossDto }> {
    return { data: await this.reports.profitAndLoss(q.currency, q.from, q.to) };
  }

  @Can('accounting.view')
  @Get('balance-sheet')
  async balanceSheet(
    @ZodQuery(reportAsOfQuerySchema) q: Out<typeof reportAsOfQuerySchema>,
  ): Promise<{ data: BalanceSheetDto }> {
    return { data: await this.reports.balanceSheet(q.currency, q.asOf) };
  }

  @Can('accounting.view')
  @Get('cash')
  async cash(
    @ZodQuery(cashReportQuerySchema) q: Out<typeof cashReportQuerySchema>,
  ): Promise<{ data: CashReportDto }> {
    return { data: await this.reports.cash(q.currency, q.from, q.to) };
  }
}
