import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import {
  AccountingReportsController,
  AccountsController,
  JournalController,
  OutboxController,
  PeriodsController,
  VouchersController,
} from './accounting.controllers.js';
import { AccountsService } from './accounts.service.js';
import { AccountingJobs } from './jobs.js';
import { JournalService } from './journal.service.js';
import { LedgerService } from './ledger.service.js';
import { OutboxService } from './outbox.service.js';
import { PeriodsService } from './periods.service.js';
import { ReportsService } from './reports.service.js';
import { VouchersService } from './vouchers.service.js';

/**
 * Accounting (M7; docs/09 M14, docs/07 §أ, D2): chart of accounts, the double-entry journal per
 * currency, automatic entries from the billing and payroll outboxes (D86, D95), receipt and payment
 * vouchers, period close and the financial reports. `OutboxService` is exported for the CLI.
 */
@Module({
  imports: [AuthModule],
  controllers: [
    AccountsController,
    JournalController,
    VouchersController,
    PeriodsController,
    OutboxController,
    AccountingReportsController,
  ],
  providers: [
    LedgerService,
    AccountsService,
    JournalService,
    VouchersService,
    PeriodsService,
    OutboxService,
    ReportsService,
    AccountingJobs,
  ],
  exports: [OutboxService],
})
export class AccountingModule {}
