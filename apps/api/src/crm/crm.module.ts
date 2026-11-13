import { Module } from '@nestjs/common';
import { OperationsModule } from '../operations/operations.module.js';
import { PayrollModule } from '../payroll/payroll.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ScheduleModule } from '../schedule/schedule.module.js';
import { LeadAlerts } from './alerts.js';
import { LeadAssigner } from './assigner.js';
import { CaptchaVerifier } from './captcha.js';
import {
  CrmSettingsController,
  LeadsController,
  LegacyClassRequestController,
  PublicFormsController,
  ReferralsController,
} from './crm.controllers.js';
import { CrmConfig } from './crm.config.js';
import { TrialEligibility } from './eligibility.js';
import {
  LeadTrialReportsController,
  TrialReportsController,
  TrialsTodayController,
} from './followup.controllers.js';
import { TrialFollowUp } from './followup.service.js';
import {
  LeadTrialOffersController,
  MyTrialOffersController,
  TrialOffersController,
} from './offers.controllers.js';
import { TrialOffers } from './offers.service.js';
import { LeadService } from './lead.service.js';
import { LeadNotifier } from './notifier.js';
import { PublicIntake } from './public-intake.service.js';
import { LeadReports } from './reports.service.js';
import { CrmThrottleGuard } from './throttle.js';
import { LeadTrialService } from './trial.service.js';
import { WebLeadMapper } from './web-lead-mapper.js';

/**
 * CRM (N5): leads, trial, conversion, referrals, the public trial form and the website webhook
 * (docs/26, docs/33 §3). The class services it books with (`ConflictChecker`, `SessionsService`,
 * `SessionStateMachine`, `ZoomMeetings`, `EnrollmentsService`, `ZoomDriver`) are the schedule
 * module's own instances, exported from it.
 */
@Module({
  imports: [AuthModule, ScheduleModule, PayrollModule, OperationsModule],
  controllers: [
    LeadsController,
    ReferralsController,
    PublicFormsController,
    LegacyClassRequestController,
    CrmSettingsController,
    LeadTrialOffersController,
    TrialOffersController,
    MyTrialOffersController,
    TrialReportsController,
    LeadTrialReportsController,
    TrialsTodayController,
  ],
  providers: [
    CrmConfig,
    CaptchaVerifier,
    CrmThrottleGuard,
    LeadNotifier,
    LeadAssigner,
    LeadService,
    LeadReports,
    LeadTrialService,
    TrialEligibility,
    TrialOffers,
    TrialFollowUp,
    LeadAlerts,
    PublicIntake,
    WebLeadMapper,
  ],
  exports: [LeadAlerts, CrmConfig, CaptchaVerifier, TrialOffers, TrialFollowUp],
})
export class CrmModule {}
