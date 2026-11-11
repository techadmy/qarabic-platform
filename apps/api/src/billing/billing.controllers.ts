import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import {
  addInvoiceLineSchema,
  BILLING_ERROR_MESSAGES,
  BILLING_SETTING_RULES,
  type BillingProvidersDto,
  billingReasonSchema,
  type BillingSettingsDto,
  type BillingSummaryDto,
  type CheckoutResultDto,
  checkoutSchema,
  createFeePackageSchema,
  createInvoiceSchema,
  CURRENCIES,
  type FamilyBillingDto,
  type FeePackageDto,
  feePackageListQuerySchema,
  type InvoiceDetailDto,
  type InvoiceDto,
  invoiceListQuerySchema,
  invoiceRunPreviewSchema,
  type InvoiceRunResultDto,
  type InvoiceRunRowDto,
  invoiceRunSchema,
  isOpenInvoice,
  MANUAL_PAYMENT_METHODS,
  manualPaymentSchema,
  type Paginated,
  type PaymentDto,
  paypalCaptureSchema,
  type RemindResultDto,
  splitInvoiceSchema,
  type SplitResultDto,
  updateBillingSettingsSchema,
  updateFamilyBillingSchema,
  updateFeePackageSchema,
  fromMinor,
} from '@qarabic/shared';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Can, CanAny, CurrentUser, Public, SkipCsrf } from '../auth/decorators.js';
import { RateLimit } from '../auth/rate-limit.guard.js';
import { Clock } from '../common/clock.js';
import { ApiException, notFound, validationError } from '../common/errors.js';
import { IdPipe } from '../common/id.pipe.js';
import { jsonSchema } from '../common/openapi.js';
import { ZodBody, ZodPipe } from '../common/zod.pipe.js';
import { ZodQuery } from '../common/zod-query.pipe.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService, type SettingKey } from '../settings/settings.service.js';
import { BillingConfig } from './billing.config.js';
import { BillingService } from './billing.service.js';
import { billingError } from './errors.js';
import { GatewayError, type PayPalHeaders, PayPalGateway, StripeGateway } from './gateways.js';
import { InvoiceService } from './invoices.service.js';
import { PaymentService } from './payments.service.js';
import { feeDto, paymentDto } from './presenter.js';
import { invoiceHtml } from './print.js';
import { InvoiceReminderService } from './reminders.service.js';
import { BillingThrottle, BillingThrottleGuard } from './throttle.js';
import { WebhookService } from './webhooks.service.js';
import { BillingPeriod } from './period.js';
import { minor } from './money.js';

type Out<S extends z.ZodType> = z.output<S>;

/** `/billing/*`: online providers and the staff KPIs (Laravel `BillingController`). */
@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly payments: PaymentService,
  ) {}

  @Can('invoices.view')
  @Get('providers')
  providers(): { data: BillingProvidersDto } {
    return {
      data: {
        online: this.payments.enabledProviders(),
        manual: [...MANUAL_PAYMENT_METHODS],
        currencies: [...CURRENCIES],
      },
    };
  }

  @CanAny('invoices.manage', 'reports.financial')
  @Get('summary')
  async summary(@CurrentUser() viewer: AuthUser): Promise<{ data: BillingSummaryDto }> {
    return { data: await this.billing.summary(viewer) };
  }
}

/** `/fee-packages`: monthly fee per weekly plan and currency (docs/20 §3). Archive, never delete. */
@ApiTags('billing')
@Controller('fee-packages')
export class FeePackagesController {
  constructor(private readonly billing: BillingService) {}

  @Can('packages.view')
  @Get()
  async list(
    @ZodQuery(feePackageListQuerySchema) q: Out<typeof feePackageListQuerySchema>,
  ): Promise<{ data: FeePackageDto[] }> {
    return { data: await this.billing.packages(q.active) };
  }

  @Can('packages.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(createFeePackageSchema) })
  async create(
    @ZodBody(createFeePackageSchema) body: Out<typeof createFeePackageSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: FeePackageDto }> {
    return { data: await this.billing.package(await this.billing.createPackage(body, actor)) };
  }

  @Can('packages.manage')
  @Patch(':id')
  @ApiBody({ schema: jsonSchema(updateFeePackageSchema) })
  async update(
    @Param('id', IdPipe) id: number,
    @ZodBody(updateFeePackageSchema) body: Out<typeof updateFeePackageSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: FeePackageDto }> {
    await this.billing.updatePackage(id, body, actor);
    return { data: await this.billing.package(id) };
  }
}

/** `/families/:id/billing`: the billing profile and the next invoice preview (D84). */
@ApiTags('billing')
@Controller('families/:familyId/billing')
export class FamilyBillingController {
  constructor(private readonly billing: BillingService) {}

  /** Staff; a parent their own family only (else 404); a teacher 404. */
  @Can('invoices.view')
  @Get()
  async show(
    @Param('familyId', IdPipe) familyId: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: FamilyBillingDto }> {
    return { data: await this.billing.familyBilling(familyId, viewer) };
  }

  /** A package change applies from the next invoice (D85). */
  @Can('invoices.manage')
  @Put()
  @ApiBody({ schema: jsonSchema(updateFamilyBillingSchema) })
  async update(
    @Param('familyId', IdPipe) familyId: number,
    @ZodBody(updateFamilyBillingSchema) body: Out<typeof updateFamilyBillingSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: FamilyBillingDto }> {
    await this.billing.updateFamilyBilling(familyId, body, actor);
    return { data: await this.billing.familyBilling(familyId, actor) };
  }
}

/** `/invoices` (docs/20 §4, §11; Laravel `InvoiceController`, `InvoicePaymentController`). */
@ApiTags('billing')
@Controller('invoices')
@UseGuards(BillingThrottleGuard)
export class InvoicesController {
  constructor(
    private readonly billing: BillingService,
    private readonly invoices: InvoiceService,
    private readonly payments: PaymentService,
    private readonly webhooks: WebhookService,
    private readonly reminders: InvoiceReminderService,
    private readonly prisma: PrismaService,
  ) {}

  /** Status tabs (`meta.counts`: all, each status, `open`, `overdue`); a parent: own family, no drafts. */
  @Can('invoices.view')
  @RateLimit('search')
  @Get()
  list(
    @ZodQuery(invoiceListQuerySchema) q: Out<typeof invoiceListQuerySchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<Paginated<InvoiceDto>> {
    return this.billing.list(q, viewer);
  }

  /** Billing issues at once with `issue`; `invoices.request` alone makes a draft (D87). */
  @CanAny('invoices.manage', 'invoices.request')
  @Post()
  @ApiBody({ schema: jsonSchema(createInvoiceSchema) })
  async create(
    @ZodBody(createInvoiceSchema) body: Out<typeof createInvoiceSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: InvoiceDetailDto }> {
    if ((await this.billing.scope(actor)).kind !== 'staff') throw notFound();
    const id = await this.invoices.createManual(
      body.familyId,
      body.lines,
      body.dueDate ?? null,
      body.notes ?? null,
      actor,
      body.issue && actor.permissions.has('invoices.manage'),
    );
    return { data: await this.billing.show(id, actor) };
  }

  @Can('invoices.view')
  @Get(':id')
  async show(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: InvoiceDetailDto }> {
    return { data: await this.billing.show(id, viewer) };
  }

  /** The printable invoice (HTML; print or save as PDF in the browser). */
  @Can('invoices.view')
  @Get(':id/print')
  async print(
    @Param('id', IdPipe) id: number,
    @CurrentUser() viewer: AuthUser,
    @Res() res: Response,
  ): Promise<void> {
    const html = invoiceHtml(await this.billing.show(id, viewer), viewer.locale);
    res
      .status(200)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .setHeader('Cache-Control', 'private, no-store')
      .send(html);
  }

  @Can('invoices.manage')
  @Post(':id/issue')
  @HttpCode(200)
  async issue(
    @Param('id', IdPipe) id: number,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: InvoiceDetailDto }> {
    await this.billing.assertStaffInvoice(id, actor);
    await this.invoices.issue(id, actor);
    return { data: await this.billing.show(id, actor) };
  }

  /** Adjustment (±) or discount (amount or percent): a new line with a reason (D83). */
  @Can('invoices.manage')
  @Post(':id/lines')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(addInvoiceLineSchema) })
  async addLine(
    @Param('id', IdPipe) id: number,
    @ZodBody(addInvoiceLineSchema) body: Out<typeof addInvoiceLineSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: InvoiceDetailDto }> {
    await this.billing.assertStaffInvoice(id, actor);
    await this.invoices.addLine(id, body, actor);
    return { data: await this.billing.show(id, actor) };
  }

  @Can('invoices.manage')
  @Post(':id/void')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(billingReasonSchema) })
  async void(
    @Param('id', IdPipe) id: number,
    @ZodBody(billingReasonSchema) body: Out<typeof billingReasonSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: InvoiceDetailDto }> {
    await this.billing.assertStaffInvoice(id, actor);
    await this.invoices.void(id, body.reason, actor);
    return { data: await this.billing.show(id, actor) };
  }

  @Can('invoices.manage')
  @Post(':id/split')
  @ApiBody({ schema: jsonSchema(splitInvoiceSchema) })
  async split(
    @Param('id', IdPipe) id: number,
    @ZodBody(splitInvoiceSchema) body: Out<typeof splitInvoiceSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: SplitResultDto }> {
    await this.billing.assertStaffInvoice(id, actor);
    const ids = await this.invoices.split(id, body.parts, body.reason, actor);
    return {
      data: { original: await this.billing.show(id, actor), parts: await this.billing.rows(ids) },
    };
  }

  /** A reminder email now (one an hour; never while `billing.notify_parents` is off). */
  @Can('invoices.manage')
  @Post(':id/remind')
  @HttpCode(200)
  async remind(
    @Param('id', IdPipe) id: number,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: RemindResultDto }> {
    await this.billing.assertStaffInvoice(id, actor);
    const invoice = await this.prisma.invoice.findUniqueOrThrow({ where: { id } });
    if (!isOpenInvoice(invoice.status)) throw billingError('not_open', 'invoice');
    if (await this.reminders.lastManualWithinHour(id)) {
      throw billingError('remind_throttled', null, HttpStatus.TOO_MANY_REQUESTS);
    }
    const result = await this.reminders.sendNow(id);
    if (result !== 'sent') {
      throw new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, {
        message:
          result === 'disabled'
            ? BILLING_ERROR_MESSAGES.parent_mail_off.en
            : `The reminder was not sent (${result}).`,
        code: result === 'disabled' ? 'parent_mail_off' : 'reminder_not_sent',
        data: { result },
      });
    }
    return { data: { result } };
  }

  /** A manual payment (cash, bank transfer, cheque, other), partial allowed. */
  @Can('invoices.manage')
  @Post(':id/payments')
  @ApiBody({ schema: jsonSchema(manualPaymentSchema) })
  async recordPayment(
    @Param('id', IdPipe) id: number,
    @ZodBody(manualPaymentSchema) body: Out<typeof manualPaymentSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: PaymentDto }> {
    await this.billing.assertStaffInvoice(id, actor);
    const paymentId = await this.payments.recordManual(id, body, actor);
    return { data: await paymentView(this.prisma, paymentId, true) };
  }

  /** The parent pays the server's balance online: a Stripe Checkout session or a PayPal order. */
  @Can('invoices.pay')
  @BillingThrottle('checkout')
  @Post(':id/checkout')
  @ApiBody({ schema: jsonSchema(checkoutSchema) })
  async checkout(
    @Param('id', IdPipe) id: number,
    @ZodBody(checkoutSchema) body: Out<typeof checkoutSchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: CheckoutResultDto }> {
    await this.billing.findRow(id, viewer);
    const payment = await this.payments.startCheckout(id, body.provider, viewer);
    return {
      data: {
        paymentId: payment.id,
        provider: body.provider,
        amount: fromMinor(minor(payment.amount)),
        currency: payment.currency,
        url: payment.checkoutUrl ?? '',
      },
    };
  }

  /** The parent came back from PayPal: capture on the server; only PayPal's answer counts. */
  @Can('invoices.pay')
  @BillingThrottle('checkout')
  @Post(':id/paypal/capture')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(paypalCaptureSchema) })
  async capture(
    @Param('id', IdPipe) id: number,
    @ZodBody(paypalCaptureSchema) body: Out<typeof paypalCaptureSchema>,
    @CurrentUser() viewer: AuthUser,
  ): Promise<{ data: PaymentDto }> {
    await this.billing.findRow(id, viewer);
    const payment = await this.prisma.payment.findFirst({
      where: { invoiceId: id, method: 'paypal', providerRef: body.orderId },
    });
    if (!payment) throw billingError('not_open', 'orderId');
    try {
      await this.webhooks.capturePayPal(payment);
    } catch (error) {
      if (error instanceof GatewayError) throw billingError('provider_error', 'orderId');
      throw error;
    }
    const scope = await this.billing.scope(viewer);
    return { data: await paymentView(this.prisma, payment.id, scope.kind === 'staff') };
  }
}

async function paymentView(prisma: PrismaService, id: number, staff: boolean): Promise<PaymentDto> {
  const row = await prisma.payment.findUniqueOrThrow({
    where: { id },
    include: { recordedBy: { select: { id: true, name: true } } },
  });
  return paymentDto(row, staff);
}

/** `/payments/:id/void`: reverses a wrongly recorded manual payment (reason required). */
@ApiTags('billing')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly billing: BillingService,
    private readonly payments: PaymentService,
    private readonly prisma: PrismaService,
  ) {}

  @Can('invoices.manage')
  @Post(':id/void')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(billingReasonSchema) })
  async void(
    @Param('id', IdPipe) id: number,
    @ZodBody(billingReasonSchema) body: Out<typeof billingReasonSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: PaymentDto }> {
    if ((await this.billing.scope(actor)).kind !== 'staff') throw notFound();
    await this.payments.voidManual(id, body.reason, actor);
    return { data: await paymentView(this.prisma, id, true) };
  }
}

/** Monthly invoices: preview (no writes) then issue, idempotent per family and period (docs/20 §4.2). */
@ApiTags('billing')
@Controller('invoice-runs')
export class InvoiceRunsController {
  constructor(
    private readonly billing: BillingService,
    private readonly invoices: InvoiceService,
  ) {}

  @Can('invoices.manage')
  @Post('preview')
  @HttpCode(200)
  @ApiBody({ schema: jsonSchema(invoiceRunPreviewSchema) })
  async preview(
    @ZodBody(invoiceRunPreviewSchema) body: Out<typeof invoiceRunPreviewSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{
    data: InvoiceRunRowDto[];
    meta: { families: number; willIssue: number; totals: Record<string, string> };
  }> {
    if ((await this.billing.scope(actor)).kind !== 'staff') throw notFound();
    const period = BillingPeriod.of(body.period, body.billingDay);
    const rows = await this.invoices.preview(body.period, body.billingDay, body.familyIds);
    const totals: Record<string, number> = {};
    for (const r of rows) {
      if (r.willIssue && r.currency) totals[r.currency] = (totals[r.currency] ?? 0) + r.totalMinor;
    }
    return {
      data: rows.map((r) => ({
        ...feeDto(r, period),
        familyId: r.familyId,
        familyName: r.familyName,
        children: r.children,
        existingInvoiceId: r.existingInvoiceId,
        willIssue: r.willIssue,
      })),
      meta: {
        families: rows.length,
        willIssue: rows.filter((r) => r.willIssue).length,
        totals: Object.fromEntries(Object.entries(totals).map(([c, m]) => [c, fromMinor(m)])),
      },
    };
  }

  @Can('invoices.manage')
  @Post()
  @ApiBody({ schema: jsonSchema(invoiceRunSchema) })
  async run(
    @ZodBody(invoiceRunSchema) body: Out<typeof invoiceRunSchema>,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: InvoiceRunResultDto }> {
    if ((await this.billing.scope(actor)).kind !== 'staff') throw notFound();
    const result = await this.invoices.run(
      body.period,
      body.billingDay,
      body.dueDate,
      actor,
      body.familyIds,
    );
    return { data: { ...result, issuedCount: result.issued.length } };
  }
}

const SETTING_KEYS = Object.keys(BILLING_SETTING_RULES) as Array<
  keyof typeof BILLING_SETTING_RULES
>;

/** `GET/PUT /settings/billing`: flat keys, like `/settings/sessions`. */
@ApiTags('settings')
@Controller('settings/billing')
export class BillingSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Can('settings.view')
  @Get()
  async show(): Promise<{ data: BillingSettingsDto }> {
    return { data: await this.current() };
  }

  @Can('settings.manage')
  @Put()
  @ApiBody({ schema: jsonSchema(updateBillingSettingsSchema) })
  async update(
    @Body() raw: unknown,
    @CurrentUser() actor: AuthUser,
  ): Promise<{ data: BillingSettingsDto }> {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const unknown = Object.keys(input).filter((k) => !(SETTING_KEYS as string[]).includes(k));
    let body: Out<typeof updateBillingSettingsSchema> = {};
    let errors: Record<string, string[]> = {};
    try {
      const known = Object.fromEntries(Object.entries(input).filter(([k]) => !unknown.includes(k)));
      body = new ZodPipe(updateBillingSettingsSchema).transform(known);
    } catch (error) {
      const resp = (
        error as { getResponse?: () => { errors?: Record<string, string[]> } }
      ).getResponse?.();
      if (!resp?.errors) throw error;
      errors = resp.errors;
    }
    for (const key of unknown) errors[key] = ['This setting does not exist.'];
    if (Object.keys(errors).length) throw validationError(errors);
    const before = await this.current();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) await this.settings.set(key as SettingKey, value, actor.id);
    }
    await this.audit.record({
      actorId: actor.id,
      action: 'settings_updated',
      subjectType: 'settings',
      subjectId: null,
      before: Object.fromEntries(
        Object.keys(body).map((k) => [k, before[k as keyof BillingSettingsDto]]),
      ),
      after: body,
    });
    return { data: await this.current() };
  }

  private async current(): Promise<BillingSettingsDto> {
    const all = await this.settings.all();
    return Object.fromEntries(SETTING_KEYS.map((k) => [k, all[k]])) as BillingSettingsDto;
  }
}

type RawRequest = Request & { rawBody?: Buffer };

const badRequest = (code: string, message: string) =>
  new ApiException(HttpStatus.BAD_REQUEST, { message, code });

function parseJson(raw: Buffer | undefined): Record<string, unknown> | null {
  if (!raw?.length) return null;
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Payment webhooks (D88): no user auth, no CSRF (server to server), throttled; signed by Stripe
 * (raw body HMAC, 5 min tolerance) or verified by PayPal itself; idempotent by event id. 404 while
 * the provider is not configured. Live events are refused unless live money is allowed.
 */
@ApiExcludeController()
@Controller('webhooks')
@UseGuards(BillingThrottleGuard)
export class PaymentWebhooksController {
  constructor(
    private readonly config: BillingConfig,
    private readonly stripe: StripeGateway,
    private readonly paypal: PayPalGateway,
    private readonly webhooks: WebhookService,
    private readonly clock: Clock,
  ) {}

  @Public()
  @SkipCsrf()
  @BillingThrottle('payment-webhook')
  @Post('stripe')
  @HttpCode(200)
  async stripeEvent(@Req() req: RawRequest): Promise<{ received: true; result: string }> {
    if (!this.stripe.enabled()) throw notFound();
    const raw = req.rawBody ?? Buffer.alloc(0);
    const valid = StripeGateway.verifySignature(
      raw,
      req.get('stripe-signature') ?? '',
      this.config.stripeWebhookSecret ?? '',
      StripeGateway.TOLERANCE,
      Math.floor(this.clock.nowMs() / 1000),
    );
    if (!valid) throw badRequest('invalid_signature', 'Invalid signature.');
    const event = parseJson(raw);
    if (!event) throw badRequest('invalid_payload', 'Invalid payload.');
    // Test keys only (D88, D140): a live-mode event is refused unless live money is allowed.
    if (event.livemode === true && !this.config.liveAllowed()) {
      throw badRequest('live_event_refused', 'Live event refused.');
    }
    return { received: true, result: await this.webhooks.handle('stripe', event) };
  }

  @Public()
  @SkipCsrf()
  @BillingThrottle('payment-webhook')
  @Post('paypal')
  @HttpCode(200)
  async paypalEvent(@Req() req: RawRequest): Promise<{ received: true; result: string }> {
    if (!this.paypal.enabled()) throw notFound();
    const event = parseJson(req.rawBody);
    if (!event || typeof event.id !== 'string' || typeof event.event_type !== 'string') {
      throw badRequest('invalid_payload', 'Invalid payload.');
    }
    const headers: PayPalHeaders = {};
    for (const h of [
      'paypal-transmission-id',
      'paypal-transmission-time',
      'paypal-transmission-sig',
      'paypal-cert-url',
      'paypal-auth-algo',
    ] as const) {
      const v = req.get(h);
      if (v) headers[h] = v;
    }
    if (!(await this.paypal.verifyWebhook(headers, event))) {
      throw badRequest('invalid_signature', 'Invalid signature.');
    }
    return { received: true, result: await this.webhooks.handle('paypal', event) };
  }
}
