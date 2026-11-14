import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FamilyCreditsController } from './credits.controller.js';
import { BillingConfig } from './billing.config.js';
import {
  BillingController,
  BillingSettingsController,
  FamilyBillingController,
  FeePackagesController,
  InvoiceRunsController,
  InvoicesController,
  PaymentsController,
  PaymentWebhooksController,
} from './billing.controllers.js';
import { BillingService } from './billing.service.js';
import { FamilyFeeCalculator } from './fees.js';
import { PaymentHttp, PayPalGateway, StripeGateway } from './gateways.js';
import { InvoiceService } from './invoices.service.js';
import { BillingJobs } from './jobs.js';
import { BillingNotifier } from './notifier.js';
import { PaymentService } from './payments.service.js';
import { InvoiceReminderService } from './reminders.service.js';
import { BillingThrottleGuard } from './throttle.js';
import { PackageUsageService } from './usage.js';
import { WebhookService } from './webhooks.service.js';

/**
 * Billing (N6; Laravel M5, docs/20, D83–D88, D140): fee packages, family billing profiles,
 * invoices, payments (manual; Stripe / PayPal in test / sandbox mode only), webhooks, reminders
 * and the ledger outbox.
 */
@Module({
  imports: [AuthModule],
  controllers: [
    BillingController,
    FeePackagesController,
    FamilyBillingController,
    InvoicesController,
    PaymentsController,
    InvoiceRunsController,
    BillingSettingsController,
    PaymentWebhooksController,
    FamilyCreditsController,
  ],
  providers: [
    BillingConfig,
    PaymentHttp,
    StripeGateway,
    PayPalGateway,
    FamilyFeeCalculator,
    BillingNotifier,
    InvoiceService,
    PaymentService,
    WebhookService,
    InvoiceReminderService,
    PackageUsageService,
    BillingService,
    BillingJobs,
    BillingThrottleGuard,
  ],
  exports: [BillingConfig, PaymentHttp, InvoiceService, InvoiceReminderService, BillingJobs],
})
export class BillingModule {}
