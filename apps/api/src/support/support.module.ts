import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { InboxService } from './inbox.service.js';
import { SupportRequestsService } from './requests.service.js';
import { SupportContext } from './policy.js';
import {
  FeedbackController,
  SupportController,
  SupportSettingsController,
} from './support.controllers.js';
import { TicketCli } from './ticket-cli.js';
import { TicketsService } from './tickets.service.js';
import { WhatsAppConfig, WhatsAppIntake, WhatsAppWebhookController } from './whatsapp.js';

/**
 * Support centre (N4, docs/22 + docs/32): «تواصل معنا» tickets, attachments, the staff inbox,
 * «طلباتي», the queue settings, the ticket CLI and the (flagged) WhatsApp intake.
 */
@Module({
  imports: [AuthModule, ScheduleModule],
  controllers: [
    FeedbackController,
    SupportController,
    SupportSettingsController,
    WhatsAppWebhookController,
  ],
  providers: [
    SupportContext,
    TicketsService,
    InboxService,
    SupportRequestsService,
    TicketCli,
    WhatsAppConfig,
    WhatsAppIntake,
  ],
  exports: [TicketsService, TicketCli, WhatsAppConfig],
})
export class SupportModule {}
