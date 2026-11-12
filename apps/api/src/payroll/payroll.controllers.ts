import { Controller, Get, HttpCode, Param, Post, Put, Res } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import {
  type AdjustmentDto,
  adjustmentListQuerySchema,
  approveDecisionSchema,
  type AttendanceDto,
  type AttendanceListDto,
  attendanceListQuerySchema,
  type AttendanceTodayDto,
  type CancelAdjustmentResultDto,
  createAdjustmentSchema,
  createLeaveSchema,
  createPayRuleSetSchema,
  createRunSchema,
  type LeaveRequestDto,
  leaveListQuerySchema,
  markAttendanceSchema,
  type MyWalletDto,
  type Paginated,
  type PayProfileDto,
  payProfileListQuerySchema,
  type PayrollPickerPersonDto,
  payrollPeopleQuerySchema,
  type PayrollRunDetailDto,
  type PayrollRunDto,
  type PayRuleSetDto,
  type PayslipDto,
  reasonDecisionSchema,
  recordPaymentSchema,
  runListQuerySchema,
  type RunPreviewDto,
  runPreviewQuerySchema,
  savePayProfileSchema,
  type WalletRowDto,
} from '@qarabic/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CanAny, CurrentUser } from '../auth/decorators.js';
import { RateLimit } from '../auth/rate-limit.guard.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody } from '../common/zod.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { AdjustmentsService } from './adjustments.service.js';
import { AttendanceService } from './attendance.service.js';
import { LeaveService } from './leave.service.js';
import { Period } from './period.js';
import { PayProfilesService } from './profiles.service.js';
import { PayrollRunsService } from './runs.service.js';
import { WalletService } from './wallet.service.js';

type Out<S extends z.ZodType> = z.output<S>;

/**
 * `/attendance` (D94; Laravel `AttendanceController`): own check-in / check-out with
 * `attendance.request`, marking others with `attendance.manage`. Without `attendance.manage` a
 * person only sees their own days.
 */
@ApiTags('payroll')
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Can('attendance.request')
  @Get('today')
  async today(@CurrentUser() viewer: AuthUser): Promise<{ data: AttendanceTodayDto }> {
    return { data: await this.attendance.today(viewer) };
  }

  @Can('attendance.request')
  @RateLimit('clock')
  @Post('check-in')
  @HttpCode(200)
  async checkIn(@CurrentUser() viewer: AuthUser): Promise<{ data: AttendanceDto }> {
    return { data: await this.attendance.checkIn(viewer) };
  }

  @Can('attendance.request')
  @RateLimit('clock')
  @Post('check-out')
  @HttpCode(200)
  async checkOut(@CurrentUser() viewer: AuthUser): Promise<{ data: AttendanceDto }> {
    return { data: await this.attendance.checkOut(viewer) };
  }

  @CanAny('attendance.request', 'attendance.view')
  @Get()
  list(
    @ZodQuery(attendanceListQuerySchema) q: Out<typeof attendanceListQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<AttendanceListDto> {
    return this.attendance.list(q, viewer);
  }

  /** Staff set or correct a day (reason required, audited); 409 `period_locked` once approved. */
  @Can('attendance.manage')
  @Put(':userId/:date')
  @ApiBody({ schema: jsonSchema(markAttendanceSchema) })
  async mark(
    @Param('userId', IdPipe) userId: number,
    @Param('date') date: string,
    @ZodBody(markAttendanceSchema) body: Out<typeof markAttendanceSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: AttendanceDto }> {
    return { data: await this.attendance.mark(userId, date, body, by) };
  }
}

/** `/leave-requests` (D94; Laravel `LeaveRequestController`). Out of scope = 404. */
@ApiTags('payroll')
@Controller('leave-requests')
export class LeaveRequestsController {
  constructor(private readonly leave: LeaveService) {}

  @CanAny('attendance.request', 'attendance.manage')
  @Get()
  list(
    @ZodQuery(leaveListQuerySchema) q: Out<typeof leaveListQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<LeaveRequestDto>> {
    return this.leave.list(q, viewer);
  }

  /** Own leave; for someone else (`userId`) `attendance.manage`. */
  @CanAny('attendance.request', 'attendance.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createLeaveSchema) })
  async create(
    @ZodBody(createLeaveSchema) body: Out<typeof createLeaveSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: LeaveRequestDto }> {
    const id = await this.leave.create(body, by);
    return { data: await this.leave.show(id, by, false) };
  }

  @CanAny('attendance.request', 'attendance.manage')
  @Get(':id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: LeaveRequestDto }> {
    return { data: await this.leave.show(id, viewer) };
  }

  @Can('attendance.manage')
  @Post(':id/approve')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(approveDecisionSchema) })
  async approve(
    @Param('id', IdPipe) id: number,
    @ZodBody(approveDecisionSchema) body: Out<typeof approveDecisionSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: LeaveRequestDto }> {
    await this.leave.approve(await this.leave.find(id, by, 'decide'), body.note ?? null, by);
    return { data: await this.leave.show(id, by) };
  }

  @Can('attendance.manage')
  @Post(':id/reject')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(reasonDecisionSchema) })
  async reject(
    @Param('id', IdPipe) id: number,
    @ZodBody(reasonDecisionSchema) body: Out<typeof reasonDecisionSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: LeaveRequestDto }> {
    await this.leave.reject(await this.leave.find(id, by, 'decide'), body.note, by);
    return { data: await this.leave.show(id, by, false) };
  }

  /** Own pending request, or any pending / approved one with `attendance.manage` (reason). */
  @CanAny('attendance.request', 'attendance.manage')
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(reasonDecisionSchema) })
  async cancel(
    @Param('id', IdPipe) id: number,
    @ZodBody(reasonDecisionSchema) body: Out<typeof reasonDecisionSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: LeaveRequestDto }> {
    await this.leave.cancel(await this.leave.find(id, by, 'cancel'), body.note, by);
    return { data: await this.leave.show(id, by, false) };
  }
}

/**
 * `/payroll/…` (D91, D92; Laravel `PayAdjustmentController`, `PayrollRunController`,
 * `SalaryProfileController::people`). The adjustment type decides who may create / decide it.
 */
@ApiTags('payroll')
@Controller('payroll')
export class PayrollController {
  constructor(
    private readonly adjustments: AdjustmentsService,
    private readonly runs: PayrollRunsService,
    private readonly profiles: PayProfilesService,
  ) {}

  // ------------------------------------------------------------------ adjustments

  @CanAny('fines.view', 'payroll.view')
  @Get('adjustments')
  list(
    @ZodQuery(adjustmentListQuerySchema) q: Out<typeof adjustmentListQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<AdjustmentDto>> {
    return this.adjustments.list(q, viewer);
  }

  @CanAny('fines.request', 'fines.manage', 'fines.approve', 'payroll.manage')
  @Post('adjustments')
  @ApiBody({ schema: jsonSchema(createAdjustmentSchema) })
  async create(
    @ZodBody(createAdjustmentSchema) body: Out<typeof createAdjustmentSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: AdjustmentDto }> {
    return { data: await this.adjustments.dto(await this.adjustments.create(body, by), by) };
  }

  @CanAny('fines.view', 'payroll.view')
  @Get('adjustments/:id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: AdjustmentDto }> {
    return { data: await this.adjustments.show(id, viewer) };
  }

  @CanAny('fines.approve', 'payroll.manage')
  @Post('adjustments/:id/approve')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(approveDecisionSchema) })
  async approve(
    @Param('id', IdPipe) id: number,
    @ZodBody(approveDecisionSchema) body: Out<typeof approveDecisionSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: AdjustmentDto }> {
    await this.adjustments.approve(
      await this.adjustments.find(id, by, 'decide'),
      body.note ?? null,
      by,
    );
    return { data: await this.adjustments.dto(id, by) };
  }

  @CanAny('fines.approve', 'payroll.manage')
  @Post('adjustments/:id/reject')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(reasonDecisionSchema) })
  async reject(
    @Param('id', IdPipe) id: number,
    @ZodBody(reasonDecisionSchema) body: Out<typeof reasonDecisionSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: AdjustmentDto }> {
    await this.adjustments.reject(await this.adjustments.find(id, by, 'decide'), body.note, by);
    return { data: await this.adjustments.dto(id, by) };
  }

  /** Cancel; a locked fine is waived with a fine reduction (201 + `data.reduction`). */
  @CanAny('fines.request', 'fines.manage', 'fines.approve', 'payroll.manage')
  @Post('adjustments/:id/cancel')
  @ApiBody({ schema: jsonSchema(reasonDecisionSchema) })
  async cancel(
    @Param('id', IdPipe) id: number,
    @ZodBody(reasonDecisionSchema) body: Out<typeof reasonDecisionSchema>,
    @CurrentUser() by: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: CancelAdjustmentResultDto }> {
    const result = await this.adjustments.cancel(
      await this.adjustments.find(id, by, 'cancel'),
      body.note,
      by,
    );
    res.status(result.reductionId ? 201 : 200);
    return { data: await this.adjustments.cancelResult(result, by) };
  }

  // ------------------------------------------------------------------ person picker

  @CanAny('fines.request', 'fines.manage', 'fines.approve', 'payroll.manage', 'attendance.manage')
  @Get('people')
  async people(
    @ZodQuery(payrollPeopleQuerySchema) q: Out<typeof payrollPeopleQuerySchema>,
  ): Promise<{ data: PayrollPickerPersonDto[] }> {
    return { data: await this.profiles.people(q.q) };
  }

  // ------------------------------------------------------------------ runs

  @CanAny('payroll.manage', 'payroll.review', 'payroll.approve')
  @Get('runs')
  runList(
    @ZodQuery(runListQuerySchema) q: Out<typeof runListQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<PayrollRunDto>> {
    return this.runs.list(q, viewer);
  }

  /** What a run of the month would hold, computed now; nothing stored. */
  @CanAny('payroll.manage', 'payroll.review', 'payroll.approve')
  @Get('runs/preview')
  async preview(
    @ZodQuery(runPreviewQuerySchema) q: Out<typeof runPreviewQuerySchema>,
  ): Promise<{ data: RunPreviewDto }> {
    return { data: await this.runs.preview(Period.parse(q.period), q.userId) };
  }

  @Can('payroll.manage')
  @Post('runs')
  @ApiBody({ schema: jsonSchema(createRunSchema) })
  async runCreate(
    @ZodBody(createRunSchema) body: Out<typeof createRunSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: PayrollRunDto }> {
    const id = await this.runs.create(Period.parse(body.period), by);
    return { data: await this.runs.runDto(id, by) };
  }

  @CanAny('payroll.manage', 'payroll.review', 'payroll.approve')
  @Get('runs/:id')
  async runShow(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: PayrollRunDetailDto }> {
    return { data: await this.runs.show(id, viewer) };
  }

  @Can('payroll.manage')
  @Post('runs/:id/recompute')
  @HttpCode(200)
  async recompute(
    @Param('id', IdPipe) id: number,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: PayrollRunDto }> {
    await this.runs.recompute(id);
    return { data: await this.runs.runDto(id, by) };
  }

  @Can('payroll.review')
  @Post('runs/:id/review')
  @HttpCode(200)
  async review(
    @Param('id', IdPipe) id: number,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: PayrollRunDto }> {
    await this.runs.review(id, by);
    return { data: await this.runs.runDto(id, by) };
  }

  @Can('payroll.approve')
  @Post('runs/:id/approve')
  @HttpCode(200)
  async runApprove(
    @Param('id', IdPipe) id: number,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: PayrollRunDto }> {
    await this.runs.approve(id, by);
    return { data: await this.runs.runDto(id, by) };
  }

  @Can('payroll.approve')
  @Post('runs/:id/reopen')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(reasonDecisionSchema) })
  async reopen(
    @Param('id', IdPipe) id: number,
    @ZodBody(reasonDecisionSchema) body: Out<typeof reasonDecisionSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: PayrollRunDto }> {
    await this.runs.reopen(id, body.note, by);
    return { data: await this.runs.runDto(id, by) };
  }
}

/** `/salary-profiles` (`payroll.manage`): how each person is paid (D89). */
@ApiTags('payroll')
@Controller('salary-profiles')
export class SalaryProfilesController {
  constructor(private readonly profiles: PayProfilesService) {}

  @Can('payroll.manage')
  @Get()
  list(
    @ZodQuery(payProfileListQuerySchema) q: Out<typeof payProfileListQuerySchema>,
  ): Promise<Paginated<PayProfileDto>> {
    return this.profiles.list(q);
  }

  /** `data: null` when the person has no profile yet; 404 for an unknown user. */
  @Can('payroll.manage')
  @Get(':userId')
  async show(@Param('userId', IdPipe) userId: number): Promise<{ data: PayProfileDto | null }> {
    return { data: await this.profiles.show(userId) };
  }

  @Can('payroll.manage')
  @Put(':userId')
  @ApiBody({ schema: jsonSchema(savePayProfileSchema) })
  async save(
    @Param('userId', IdPipe) userId: number,
    @ZodBody(savePayProfileSchema) body: Out<typeof savePayProfileSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: PayProfileDto }> {
    return { data: await this.profiles.save(userId, body, by) };
  }
}

/**
 * Payslips and the wallet (Laravel `PayslipController`): payroll staff see every payslip, anyone
 * else only their own approved ones (404 otherwise). A payment is recorded, never made (D140).
 */
@ApiTags('payroll')
@Controller()
export class PayslipsController {
  constructor(
    private readonly runs: PayrollRunsService,
    private readonly wallet: WalletService,
  ) {}

  @CanAny('payroll.view', 'payroll.manage', 'payroll.review', 'payroll.approve')
  @Get('payslips/:id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: PayslipDto }> {
    return { data: await this.runs.payslip(id, viewer) };
  }

  /** «تسجيل الصرف»: method, reference (not for cash), date. Records only; no transfer is made. */
  @Can('payroll.manage')
  @Post('payslips/:id/payments')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(recordPaymentSchema) })
  async pay(
    @Param('id', IdPipe) id: number,
    @ZodBody(recordPaymentSchema) body: Out<typeof recordPaymentSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: PayslipDto }> {
    await this.runs.recordPayment(id, body, by);
    return { data: await this.runs.payslip(id, by) };
  }

  @Can('payroll.view')
  @Get('me/payslips')
  async mine(@CurrentUser() viewer: AuthUser): Promise<{ data: PayslipDto[] }> {
    return { data: await this.runs.mine(viewer) };
  }

  @Can('wallet.view')
  @Get('me/wallet')
  async myWallet(@CurrentUser() viewer: AuthUser): Promise<{ data: MyWalletDto }> {
    return { data: await this.wallet.mine(viewer.id) };
  }

  @Can('wallet.manage')
  @Get('wallets')
  async wallets(): Promise<{ data: WalletRowDto[] }> {
    return { data: await this.wallet.all() };
  }
}

/** `/pay-rule-sets` (D41; Laravel `PayRuleSetController`): list, add a version (never edited). */
@ApiTags('payroll')
@Controller('pay-rule-sets')
export class PayRuleSetsController {
  constructor(private readonly profiles: PayProfilesService) {}

  @Can('settings.view')
  @Get()
  async list(): Promise<{ data: PayRuleSetDto[] }> {
    return { data: await this.profiles.ruleSets() };
  }

  @Can('settings.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createPayRuleSetSchema) })
  async create(
    @ZodBody(createPayRuleSetSchema) body: Out<typeof createPayRuleSetSchema>,
    @CurrentUser() by: AuthUser,
  ): Promise<{ data: PayRuleSetDto }> {
    return { data: await this.profiles.createRuleSet(body, by) };
  }
}
