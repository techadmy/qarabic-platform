import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AdjustmentsService } from './adjustments.service.js';
import { AttendanceService } from './attendance.service.js';
import { PayrollCalculator } from './calculator.js';
import { LeaveService } from './leave.service.js';
import {
  AttendanceController,
  LeaveRequestsController,
  PayRuleSetsController,
  PayrollController,
  PayslipsController,
  SalaryProfilesController,
} from './payroll.controllers.js';
import { PayProfilesService } from './profiles.service.js';
import { PayrollRunsService } from './runs.service.js';
import { WalletService } from './wallet.service.js';

/**
 * Payroll (N7; Laravel M6, docs/21): attendance and leave, fines and adjustments, salary profiles,
 * pay rules, payroll runs, payslips and the wallet. The pay rule engine that snapshots class pay is
 * global (`PayRulesModule`) because the class state machine uses it. `AttendanceService.isOnShift`
 * is exported for the CRM shift check (N5, `crm.shift_source=attendance`).
 */
@Module({
  imports: [AuthModule],
  controllers: [
    AttendanceController,
    LeaveRequestsController,
    PayrollController,
    SalaryProfilesController,
    PayslipsController,
    PayRuleSetsController,
  ],
  providers: [
    PayrollCalculator,
    PayrollRunsService,
    AttendanceService,
    LeaveService,
    AdjustmentsService,
    PayProfilesService,
    WalletService,
  ],
  exports: [AttendanceService, PayrollRunsService],
})
export class PayrollModule {}
