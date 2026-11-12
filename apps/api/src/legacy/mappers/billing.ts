import {
  bool,
  camelizeJson,
  dateOnly,
  int,
  json,
  minorToDecimal,
  oneOf,
  type Row,
  str,
  text,
} from '../convert.js';
import {
  batch,
  type MapContext,
  type ModuleMapper,
  type SelfRef,
  type TargetBatch,
} from '../plan.js';
import { fit, stamps, t } from './people.js';

const money = (r: Row, col: string): string => minorToDecimal(int(r, col) ?? 0)!;

export const billingMapper: ModuleMapper = {
  name: 'billing',
  sources: [
    'fee_packages',
    'fee_package_prices',
    'families',
    'students',
    'invoices',
    'invoice_lines',
    'invoice_sequences',
    'payments',
    'payment_webhook_events',
    'billing_events',
    'transactions',
    'transaction_class',
    'packages',
    'package_plans',
    'package_descriptions',
    'plans',
  ],
  dependsOn: ['people'],
  tables: [
    'fee_packages',
    'fee_package_prices',
    'family_billing_profiles',
    'student_fee_packages',
    'invoices',
    'invoice_lines',
    'invoice_sequences',
    'payments',
    'payment_webhook_events',
    'billing_events',
  ],
  clears: ['invoice_reminders'],
  map(ctx: MapContext): TargetBatch[] {
    const out: TargetBatch[] = [];

    const packages = ctx.rows('fee_packages').map((r) => {
      if (t(ctx, r.deleted_at))
        ctx.report.change('fee_packages', r.id, 'soft-deleted: imported inactive');
      return {
        id: int(r, 'id')!,
        name: fit(ctx, 'fee_packages', r.id, 'name', text(r, 'name') ?? '-', 120),
        classesPerWeek: Math.min(14, Math.max(1, int(r, 'classes_per_week') ?? 1)),
        sessionMinutes: int(r, 'session_minutes') ?? 30,
        description: fit(ctx, 'fee_packages', r.id, 'description', text(r, 'description'), 500),
        isActive: (bool(r, 'is_active') ?? true) && !t(ctx, r.deleted_at),
        createdById: ctx.has('users', int(r, 'created_by')) ? int(r, 'created_by') : null,
        ...stamps(ctx, r),
      };
    });
    ctx.remember(
      'fee_packages',
      packages.map((p) => p.id),
    );
    out.push(
      batch(
        'fee_packages',
        'feePackage',
        'fee_packages',
        ctx.rows('fee_packages').length,
        packages,
      ),
    );

    const prices = ctx.rows('fee_package_prices').flatMap((r) => {
      if (
        !ctx.has('fee_packages', int(r, 'fee_package_id')) ||
        (int(r, 'monthly_amount_minor') ?? 0) <= 0
      ) {
        ctx.report.skip('fee_package_prices', r.id, 'package not imported or price not above 0');
        return [];
      }
      return [
        {
          id: int(r, 'id')!,
          feePackageId: int(r, 'fee_package_id'),
          currency: str(r, 'currency')?.toUpperCase(),
          monthlyAmount: money(r, 'monthly_amount_minor'),
          ...stamps(ctx, r),
        },
      ];
    });
    out.push(
      batch(
        'fee_package_prices',
        'feePackagePrice',
        'fee_package_prices',
        ctx.rows('fee_package_prices').length,
        prices,
      ),
    );

    // Billing profile = the billing_* columns of `families` (D84). Only families with any billing data.
    const profiles: Row[] = [];
    for (const r of ctx.rows('families')) {
      const familyId = int(r, 'id')!;
      if (!ctx.has('families', familyId)) continue;
      const any =
        bool(r, 'billing_enabled') ||
        text(r, 'billing_currency') ||
        int(r, 'custom_fee_minor') !== null ||
        text(r, 'billing_starts_on') ||
        int(r, 'billing_day') !== null;
      if (!any) continue;
      let day = int(r, 'billing_day') ?? 1;
      if (day !== 1 && day !== 15) {
        ctx.report.change('families', familyId, `billing_day ${day} is not 1 or 15: 1`);
        day = 1;
      }
      const fee = int(r, 'custom_fee_minor');
      profiles.push({
        familyId,
        currency: text(r, 'billing_currency')?.toUpperCase() ?? null,
        billingDay: day,
        enabled: bool(r, 'billing_enabled') ?? false,
        customFee: fee !== null ? minorToDecimal(fee) : null,
        startsOn: dateOnly(r.billing_starts_on),
        updatedById: null,
        ...stamps(ctx, r),
      });
    }
    out.push(
      batch(
        'family_billing_profiles',
        'familyBillingProfile',
        'families',
        ctx.rows('families').length,
        profiles,
        false,
      ),
    );

    const studentPackages: Row[] = [];
    for (const r of ctx.rows('students')) {
      const studentId = int(r, 'id')!;
      const pkg = int(r, 'fee_package_id');
      if (pkg === null || !ctx.has('students', studentId)) continue;
      if (!ctx.has('fee_packages', pkg)) {
        ctx.report.change('students', studentId, `fee_package_id=${pkg} not imported: no package`);
        continue;
      }
      studentPackages.push({ studentId, feePackageId: pkg, updatedById: null, ...stamps(ctx, r) });
    }
    out.push(
      batch(
        'student_fee_packages',
        'studentFeePackage',
        'students',
        ctx.rows('students').length,
        studentPackages,
        false,
      ),
    );

    const invoices: Row[] = [];
    const split: SelfRef = { column: 'split_from_id', pairs: [] };
    for (const r of ctx.rows('invoices')) {
      const id = int(r, 'id')!;
      const kind = oneOf(str(r, 'kind'), ['monthly', 'manual', 'split'] as const);
      const status = oneOf(str(r, 'status'), [
        'draft',
        'issued',
        'partially_paid',
        'paid',
        'void',
        'split',
      ] as const);
      if ((int(r, 'total_minor') ?? 0) < 0 || (int(r, 'paid_minor') ?? 0) < 0) {
        ctx.report.skip(
          'invoices',
          id,
          'negative total or paid (the new schema has no credit notes)',
        );
        continue;
      }
      if (!ctx.has('families', int(r, 'family_id')) || !kind || !status) {
        ctx.report.skip(
          'invoices',
          id,
          `family ${str(r, 'family_id')} not imported or kind/status unknown`,
        );
        continue;
      }
      const from = int(r, 'split_from_id');
      if (from !== null) split.pairs.push([id, from]);
      invoices.push({
        id,
        number: text(r, 'number'),
        familyId: int(r, 'family_id'),
        kind,
        status,
        periodStart: dateOnly(r.period_start),
        periodEnd: dateOnly(r.period_end),
        periodKey: text(r, 'period_key'),
        currency: str(r, 'currency')?.toUpperCase(),
        subtotal: money(r, 'subtotal_minor'),
        adjustments: money(r, 'adjustments_minor'),
        discounts: money(r, 'discounts_minor'),
        total: money(r, 'total_minor'),
        paid: money(r, 'paid_minor'),
        issueDate: dateOnly(r.issue_date),
        dueDate: dateOnly(r.due_date),
        issuedAt: t(ctx, r.issued_at),
        issuedById: ctx.has('users', int(r, 'issued_by')) ? int(r, 'issued_by') : null,
        paidAt: t(ctx, r.paid_at),
        voidedAt: t(ctx, r.voided_at),
        voidedById: ctx.has('users', int(r, 'voided_by')) ? int(r, 'voided_by') : null,
        voidReason: fit(ctx, 'invoices', id, 'void_reason', text(r, 'void_reason'), 500),
        splitFromId: null,
        notes: fit(ctx, 'invoices', id, 'notes', text(r, 'notes'), 1000),
        createdById: ctx.has('users', int(r, 'created_by')) ? int(r, 'created_by') : null,
        lockVersion: int(r, 'lock_version') ?? 0,
        ...stamps(ctx, r),
      });
    }
    ctx.remember(
      'invoices',
      invoices.map((i) => i.id as number),
    );
    split.pairs = split.pairs.filter(([, ref]) => ctx.has('invoices', ref));
    out.push(
      batch('invoices', 'invoice', 'invoices', ctx.rows('invoices').length, invoices, true, [
        split,
      ]),
    );

    const lines: Row[] = [];
    for (const r of ctx.rows('invoice_lines')) {
      const id = int(r, 'id')!;
      const type = oneOf(str(r, 'type'), [
        'package',
        'manual',
        'adjustment',
        'discount',
        'split',
      ] as const);
      if (!ctx.has('invoices', int(r, 'invoice_id')) || !type) {
        ctx.report.skip('invoice_lines', id, 'invoice not imported or type unknown');
        continue;
      }
      lines.push({
        id,
        invoiceId: int(r, 'invoice_id'),
        type,
        studentId: ctx.has('students', int(r, 'student_id')) ? int(r, 'student_id') : null,
        feePackageId: ctx.has('fee_packages', int(r, 'fee_package_id'))
          ? int(r, 'fee_package_id')
          : null,
        description: fit(ctx, 'invoice_lines', id, 'description', str(r, 'description') ?? '', 500),
        amount: money(r, 'amount_minor'),
        meta: camelizeJson(json(r, 'meta')) ?? undefined,
        createdById: ctx.has('users', int(r, 'created_by')) ? int(r, 'created_by') : null,
        createdAt: stamps(ctx, r).createdAt,
      });
    }
    out.push(
      batch(
        'invoice_lines',
        'invoiceLine',
        'invoice_lines',
        ctx.rows('invoice_lines').length,
        lines,
      ),
    );

    const seqs = ctx
      .rows('invoice_sequences')
      .map((r) => ({ year: int(r, 'year'), lastNumber: int(r, 'last_number') ?? 0 }));
    out.push(
      batch(
        'invoice_sequences',
        'invoiceSequence',
        'invoice_sequences',
        ctx.rows('invoice_sequences').length,
        seqs,
        false,
      ),
    );

    const payments: Row[] = [];
    for (const r of ctx.rows('payments')) {
      const id = int(r, 'id')!;
      const method = oneOf(str(r, 'provider'), [
        'stripe',
        'paypal',
        'cash',
        'bank_transfer',
        'cheque',
        'other',
      ] as const);
      const status = oneOf(str(r, 'status'), [
        'pending',
        'succeeded',
        'failed',
        'cancelled',
        'refunded',
      ] as const);
      if ((int(r, 'amount_minor') ?? 0) <= 0) {
        ctx.report.skip('payments', id, 'amount not above 0');
        continue;
      }
      if (
        !ctx.has('invoices', int(r, 'invoice_id')) ||
        !ctx.has('families', int(r, 'family_id')) ||
        !method ||
        !status
      ) {
        ctx.report.skip('payments', id, 'invoice/family not imported or provider/status unknown');
        continue;
      }
      payments.push({
        id,
        invoiceId: int(r, 'invoice_id'),
        familyId: int(r, 'family_id'),
        method,
        status,
        amount: money(r, 'amount_minor'),
        currency: str(r, 'currency')?.toUpperCase(),
        providerRef: text(r, 'provider_ref'),
        providerPaymentId: text(r, 'provider_payment_id'),
        checkoutUrl: text(r, 'checkout_url'),
        reference: text(r, 'reference'),
        note: fit(ctx, 'payments', id, 'note', text(r, 'note'), 1000),
        receivedAt: t(ctx, r.received_at),
        refundedAt: t(ctx, r.refunded_at),
        failureReason: fit(ctx, 'payments', id, 'failure_reason', text(r, 'failure_reason'), 500),
        recordedById: ctx.has('users', int(r, 'recorded_by')) ? int(r, 'recorded_by') : null,
        initiatedById: ctx.has('users', int(r, 'initiated_by')) ? int(r, 'initiated_by') : null,
        idempotencyKey: text(r, 'idempotency_key'),
        ...stamps(ctx, r),
      });
    }
    out.push(batch('payments', 'payment', 'payments', ctx.rows('payments').length, payments));

    const hooks = ctx.rows('payment_webhook_events').map((r) => ({
      id: int(r, 'id')!,
      provider: str(r, 'provider'),
      eventId: str(r, 'event_id'),
      type: str(r, 'type'),
      payload: json(r, 'payload') ?? {},
      status:
        oneOf(str(r, 'status'), ['received', 'processed', 'ignored', 'failed'] as const) ??
        'received',
      error: fit(ctx, 'payment_webhook_events', r.id, 'error', text(r, 'error'), 1000),
      processedAt: t(ctx, r.processed_at),
      ...stamps(ctx, r),
    }));
    out.push(
      batch(
        'payment_webhook_events',
        'paymentWebhookEvent',
        'payment_webhook_events',
        ctx.rows('payment_webhook_events').length,
        hooks,
      ),
    );

    const events = ctx.rows('billing_events').map((r) => ({
      id: int(r, 'id')!,
      type: str(r, 'type'),
      subjectType: str(r, 'subject_type'),
      subjectId: int(r, 'subject_id'),
      familyId: int(r, 'family_id'),
      amount: money(r, 'amount_minor'),
      currency: str(r, 'currency')?.toUpperCase(),
      payload: camelizeJson(json(r, 'payload')) ?? undefined,
      occurredAt: t(ctx, r.occurred_at),
      consumedAt: t(ctx, r.consumed_at),
      createdAt: stamps(ctx, r).createdAt,
    }));
    out.push(
      batch(
        'billing_events',
        'billingEvent',
        'billing_events',
        ctx.rows('billing_events').length,
        events,
      ),
    );

    for (const [table, why] of [
      ['transactions', 'pre-M5 payment links (old Stripe checkout rows); M5 invoices replace them'],
      ['transaction_class', 'pre-M5 per-class charges'],
      ['packages', 'old price list (fee_packages replace it)'],
      ['package_plans', 'old price list'],
      ['package_descriptions', 'old price list texts'],
      ['plans', 'old plan names'],
    ] as const) {
      if (ctx.rows(table).length) ctx.report.noCounterpart(table, ctx.rows(table).length, why);
    }
    return out;
  },
};
