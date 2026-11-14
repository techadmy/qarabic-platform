import {
  addInvoiceLineSchema,
  BILLING_ERROR_MESSAGES,
  billingReasonSchema,
  checkoutSchema,
  createFeePackageSchema,
  createInvoiceSchema,
  CURRENCIES,
  feePackageListQuerySchema,
  fromMinor,
  INVOICE_STATUSES,
  invoiceListQuerySchema,
  invoiceRunPreviewSchema,
  invoiceRunSchema,
  isEditableInvoice,
  isOnlineMethod,
  isOpenInvoice,
  MANUAL_PAYMENT_METHODS,
  manualPaymentSchema,
  paypalCaptureSchema,
  percentOf,
  splitInvoiceSchema,
  toMinor,
  updateBillingSettingsSchema,
  updateFamilyBillingSchema,
  updateFeePackageSchema,
  type BillingErrorCode,
  type Currency,
  type FamilyBillingDto,
  type FeePackageDto,
  type InvoiceDetailDto,
  type InvoiceDto,
  type PackageUsageDto,
  type PaymentDto,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { addDays } from '@/lib/schedule-time';
import {
  academyToday,
  bdb,
  childrenOf,
  feeFor,
  instantOf,
  isOverdue,
  isoNow,
  monthOf,
  nextNumber,
  nextReceipt,
  periodOf,
  recalculate,
  shiftMonth,
  totalsOf,
  type InvoiceRow,
  type PaymentRow,
} from './billing-db';
import type { MockUser } from './data';
import { db as people } from './people-db';
import { paginate, queryOf } from './schedule-handlers';
import { apiError, guard, guardAny, notFound, validationFailed } from './session';

/**
 * MSW handlers for N6 (apps/api README «Endpoints (N6: billing)»): packages, the family billing
 * profile, invoices and every action on them, manual payments, checkout (the mock's "provider"
 * page is the app's own return address; the next read of the invoice plays the signed webhook),
 * the monthly run and the billing settings. Same permissions, row scope (a parent: own family,
 * never a draft; anything else 404) and refusal codes as the API. Fake data, no real money.
 */
const API = '*/api/v1';
const has = (me: MockUser, p: string) => me.permissions.includes(p);
const isParent = (me: MockUser) => me.role?.kind === 'parent';
const ownFamilyId = (me: MockUser) =>
  people.families.find((f) => f.parentUserId === me.id)?.id ?? null;

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function billingError(code: BillingErrorCode, field: string | null, status = 422, data?: object) {
  const message = BILLING_ERROR_MESSAGES[code].en;
  return apiError(
    status,
    code,
    message,
    field ? { [field]: [message] } : undefined,
    data as Record<string, unknown> | undefined,
  );
}

const familyName = (id: number) => people.families.find((f) => f.id === id)?.parentName ?? `#${id}`;

/** Rows the viewer may see: staff every family; a parent their own, never a draft; else none. */
function visible(me: MockUser, inv: InvoiceRow): boolean {
  if (!isParent(me)) return me.role?.kind !== 'teacher';
  return inv.familyId === ownFamilyId(me) && inv.status !== 'draft';
}

function invoiceDto(inv: InvoiceRow, today = academyToday()): InvoiceDto {
  const t = totalsOf(bdb, inv);
  return {
    id: inv.id,
    number: inv.number,
    kind: inv.kind,
    status: inv.status,
    isOverdue: isOverdue(inv, today),
    family: { id: inv.familyId, name: familyName(inv.familyId) },
    currency: inv.currency,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    subtotal: fromMinor(t.subtotal),
    adjustments: fromMinor(t.adjustments),
    discounts: fromMinor(t.discounts),
    total: fromMinor(t.total),
    paid: fromMinor(t.paid),
    balance: fromMinor(t.balance),
    paidAt: inv.paidAt,
    createdAt: inv.createdAt,
  };
}

function paymentDto(p: PaymentRow, staff: boolean): PaymentDto {
  const base: PaymentDto = {
    id: p.id,
    invoiceId: p.invoiceId,
    method: p.method,
    status: p.status,
    amount: fromMinor(p.amountMinor),
    currency: p.currency,
    reference: p.reference,
    receivedAt: p.receivedAt,
    refundedAt: p.refundedAt,
    createdAt: p.createdAt,
    receiptNumber: p.receiptNumber,
    unapplied: '0.00',
    needsReview: false,
    reviewReason: null,
  };
  return staff
    ? {
        ...base,
        note: p.note,
        failureReason: p.failureReason,
        providerPaymentId: p.providerPaymentId,
        recordedBy: p.recordedBy,
      }
    : base;
}

/** B24: information only; counts derived from the student id so they never change. */
function usageOf(inv: InvoiceRow): PackageUsageDto[] {
  if (!inv.periodStart) return [];
  return inv.lines
    .filter((l) => l.type === 'package' && l.studentId)
    .map((l) => {
      const perWeek = Number(l.meta?.classesPerWeek ?? 2);
      const allowance = perWeek * 4;
      const id = l.studentId!;
      const taken = Math.min(allowance, 3 + (id % 4));
      const absent = id % 2;
      const leave = 1;
      const upcoming = Math.max(0, allowance - taken - absent - leave);
      return {
        studentId: id,
        studentName: people.students.find((s) => s.id === id)?.name ?? `#${id}`,
        allowance,
        counted: taken + absent,
        notCounted: leave,
        upcoming,
        byStage: { taken, absent, leave, scheduled: upcoming },
        countedStages: [...bdb.settings['billing.deducting_stages']],
      };
    });
}

function detailDto(inv: InvoiceRow, me: MockUser): InvoiceDetailDto {
  const staff = !isParent(me);
  const manage = staff && has(me, 'invoices.manage');
  const t = totalsOf(bdb, inv);
  const open = isOpenInvoice(inv.status);
  const from = inv.splitFromId ? bdb.invoices.find((i) => i.id === inv.splitFromId) : null;
  return {
    ...invoiceDto(inv),
    notes: inv.notes,
    voidReason: inv.voidReason,
    voidedAt: inv.voidedAt,
    lines: inv.lines.map((l) => ({
      id: l.id,
      type: l.type,
      student: l.studentId
        ? {
            id: l.studentId,
            name: people.students.find((s) => s.id === l.studentId)?.name ?? '',
          }
        : null,
      description: l.description,
      amount: fromMinor(l.amountMinor),
      meta: l.meta,
      createdAt: l.createdAt,
    })),
    payments: bdb.payments
      .filter(
        (p) =>
          p.invoiceId === inv.id &&
          (staff || ['succeeded', 'refunded', 'pending'].includes(p.status)),
      )
      .map((p) => paymentDto(p, staff)),
    splitFrom: from ? { id: from.id, number: from.number } : null,
    splits: bdb.invoices
      .filter((i) => i.splitFromId === inv.id)
      .map((i) => ({
        id: i.id,
        number: i.number,
        status: i.status,
        total: fromMinor(totalsOf(bdb, i).total),
        dueDate: i.dueDate,
      })),
    usage: usageOf(inv),
    can: {
      pay: !staff && open && t.balance > 0,
      issue: manage && inv.status === 'draft',
      edit: manage && isEditableInvoice(inv.status),
      recordPayment: manage && open,
      split: manage && open && t.paid === 0,
      void: manage && isEditableInvoice(inv.status) && t.paid === 0,
      remind: manage && open,
    },
  };
}

function packageDto(id: number): FeePackageDto | null {
  const p = bdb.packages.find((x) => x.id === id);
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    classesPerWeek: p.classesPerWeek,
    sessionMinutes: p.sessionMinutes,
    description: p.description,
    isActive: p.isActive,
    prices: (Object.entries(p.prices) as [Currency, number][])
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, minor]) => ({ currency, monthlyAmount: fromMinor(minor) })),
    studentsCount: [...bdb.studentPackages.values()].filter((v) => v === p.id).length,
  };
}

function familyBillingDto(familyId: number): FamilyBillingDto | null {
  const family = people.families.find((f) => f.id === familyId);
  const profile = bdb.profiles.get(familyId);
  if (!family || !profile) return null;
  const today = academyToday();
  const day = profile.billingDay;
  const month = Number(today.slice(8, 10)) >= day ? shiftMonth(monthOf(today), 1) : monthOf(today);
  const fee = feeFor(bdb, familyId, periodOf(month, day));
  const balance = new Map<string, { due: number; overdue: number; openInvoices: number }>();
  for (const inv of bdb.invoices.filter((i) => i.familyId === familyId)) {
    if (!isOpenInvoice(inv.status)) continue;
    const b = balance.get(inv.currency) ?? { due: 0, overdue: 0, openInvoices: 0 };
    const owed = Math.max(0, totalsOf(bdb, inv).balance);
    b.due += owed;
    b.openInvoices += 1;
    if (isOverdue(inv, today)) b.overdue += owed;
    balance.set(inv.currency, b);
  }
  return {
    familyId,
    familyName: family.parentName,
    billingCurrency: profile.currency,
    billingDay: day,
    billingEnabled: profile.enabled,
    customFee: profile.customFeeMinor === null ? null : fromMinor(profile.customFeeMinor),
    billingStartsOn: profile.startsOn,
    status: family.status.value,
    students: people.students
      .filter((s) => s.familyId === familyId)
      .map((s) => ({
        id: s.id,
        name: s.name,
        feePackageId: bdb.studentPackages.get(s.id) ?? null,
      })),
    nextInvoice: {
      periodStart: fee.periodStart,
      periodEnd: fee.periodEnd,
      currency: fee.currency,
      total: fee.total,
      lines: fee.lines,
      warnings: fee.warnings,
    },
    balance: [...balance.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, b]) => ({
        currency,
        due: fromMinor(b.due),
        overdue: fromMinor(b.overdue),
        openInvoices: b.openInvoices,
      })),
  };
}

function findInvoice(me: MockUser, id: number) {
  const inv = bdb.invoices.find((i) => i.id === id);
  return inv && visible(me, inv) ? inv : null;
}

/** The mock's stand-in for the signed provider webhook: the attempt succeeds on the next read. */
function settleCheckouts(inv: InvoiceRow) {
  for (const p of bdb.payments) {
    if (p.invoiceId !== inv.id || p.status !== 'pending' || p.method !== 'stripe') continue;
    p.status = 'succeeded';
    p.receivedAt = isoNow();
    p.receiptNumber = nextReceipt(bdb);
    p.providerPaymentId = `pi_mock_${p.id}`;
    recalculate(bdb, inv);
  }
}

function runRows(month: string, day: 1 | 15, familyIds?: number[]) {
  const period = periodOf(month, day);
  return people.families
    .filter((f) => {
      const p = bdb.profiles.get(f.id);
      return (
        p?.enabled &&
        p.billingDay === day &&
        f.status.value === 'regular' &&
        !f.archive &&
        (!familyIds || familyIds.includes(f.id))
      );
    })
    .map((f) => {
      const fee = feeFor(bdb, f.id, period);
      const existing = bdb.invoices.find(
        (i) =>
          i.familyId === f.id &&
          i.kind === 'monthly' &&
          i.periodStart === period.start &&
          i.status !== 'void',
      );
      return {
        fee,
        row: {
          periodStart: period.start,
          periodEnd: period.end,
          currency: fee.currency,
          total: fee.total,
          lines: fee.lines,
          warnings: fee.warnings,
          familyId: f.id,
          familyName: f.parentName,
          children: childrenOf(f.id).length,
          existingInvoiceId: existing?.id ?? null,
          willIssue: !existing && fee.lines.length > 0 && fee.totalMinor > 0,
        },
      };
    });
}

export const billingHandlers: HttpHandler[] = [
  http.get(`${API}/billing/providers`, ({ request }) => {
    const g = guard(request, 'invoices.view');
    if ('error' in g) return g.error;
    return HttpResponse.json({
      data: {
        online: [...bdb.online],
        manual: [...MANUAL_PAYMENT_METHODS],
        currencies: CURRENCIES,
      },
    });
  }),

  http.get(`${API}/billing/summary`, ({ request }) => {
    const g = guardAny(request, 'invoices.manage', 'reports.financial');
    if ('error' in g) return g.error;
    if (isParent(g.me)) return notFound();
    const today = academyToday();
    const month = monthOf(today);
    const by = new Map<
      string,
      { due: number; openCount: number; overdue: number; overdueCount: number; collected: number }
    >();
    const row = (c: string) => {
      const r = by.get(c) ?? { due: 0, openCount: 0, overdue: 0, overdueCount: 0, collected: 0 };
      by.set(c, r);
      return r;
    };
    const counts: Record<string, number> = { overdue: 0 };
    for (const inv of bdb.invoices) {
      counts[inv.status] = (counts[inv.status] ?? 0) + 1;
      if (!isOpenInvoice(inv.status)) continue;
      const r = row(inv.currency);
      const owed = totalsOf(bdb, inv).balance;
      r.due += owed;
      r.openCount += 1;
      if (isOverdue(inv, today)) {
        r.overdue += owed;
        r.overdueCount += 1;
        counts.overdue! += 1;
      }
    }
    for (const p of bdb.payments) {
      if (p.status === 'succeeded' && p.receivedAt?.slice(0, 7) === month) {
        row(p.currency).collected += p.amountMinor;
      }
    }
    return HttpResponse.json({
      data: {
        byCurrency: [...by.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, r]) => ({
            currency,
            due: fromMinor(r.due),
            openCount: r.openCount,
            overdue: fromMinor(r.overdue),
            overdueCount: r.overdueCount,
            collectedThisMonth: fromMinor(r.collected),
          })),
        counts,
        month,
      },
    });
  }),

  // ---------------------------------------------------------------- fee packages
  http.get(`${API}/fee-packages`, ({ request }) => {
    const g = guard(request, 'packages.view');
    if ('error' in g) return g.error;
    const parsed = feePackageListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const rows = bdb.packages
      .filter((p) => parsed.data.active === undefined || p.isActive === parsed.data.active)
      .sort(
        (a, b) => Number(b.isActive) - Number(a.isActive) || a.classesPerWeek - b.classesPerWeek,
      );
    return HttpResponse.json({ data: rows.map((p) => packageDto(p.id)) });
  }),

  http.post(`${API}/fee-packages`, async ({ request }) => {
    const g = guard(request, 'packages.manage');
    if ('error' in g) return g.error;
    const parsed = createFeePackageSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    const id = bdb.next.package++;
    bdb.packages.push({
      id,
      name: v.name,
      classesPerWeek: v.classesPerWeek,
      sessionMinutes: v.sessionMinutes,
      description: v.description ?? null,
      isActive: v.isActive,
      prices: Object.fromEntries(v.prices.map((p) => [p.currency, toMinor(p.monthlyAmount)])),
    });
    return HttpResponse.json({ data: packageDto(id) }, { status: 201 });
  }),

  http.patch(`${API}/fee-packages/:id`, async ({ request, params }) => {
    const g = guard(request, 'packages.manage');
    if ('error' in g) return g.error;
    const p = bdb.packages.find((x) => x.id === Number(params.id));
    if (!p) return notFound();
    const parsed = updateFeePackageSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    if (v.name !== undefined) p.name = v.name;
    if (v.classesPerWeek !== undefined) p.classesPerWeek = v.classesPerWeek;
    if (v.sessionMinutes !== undefined) p.sessionMinutes = v.sessionMinutes;
    if (v.description !== undefined) p.description = v.description ?? null;
    if (v.isActive !== undefined) p.isActive = v.isActive;
    if (v.prices) {
      p.prices = Object.fromEntries(v.prices.map((x) => [x.currency, toMinor(x.monthlyAmount)]));
    }
    return HttpResponse.json({ data: packageDto(p.id) });
  }),

  // ---------------------------------------------------------------- family billing profile
  http.get(`${API}/families/:id/billing`, ({ request, params }) => {
    const g = guard(request, 'invoices.view');
    if ('error' in g) return g.error;
    const id = Number(params.id);
    if (isParent(g.me) ? ownFamilyId(g.me) !== id : g.me.role?.kind === 'teacher') {
      return notFound();
    }
    const dto = familyBillingDto(id);
    return dto ? HttpResponse.json({ data: dto }) : notFound();
  }),

  http.put(`${API}/families/:id/billing`, async ({ request, params }) => {
    const g = guard(request, 'invoices.manage');
    if ('error' in g) return g.error;
    const id = Number(params.id);
    const profile = bdb.profiles.get(id);
    if (!profile || isParent(g.me)) return notFound();
    const parsed = updateFamilyBillingSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    const kids = people.students.filter((s) => s.familyId === id).map((s) => s.id);
    if (v.students?.some((s) => !kids.includes(s.id))) {
      return billingError('unknown_student', 'students');
    }
    profile.currency = v.billingCurrency;
    profile.billingDay = v.billingDay;
    profile.enabled = v.billingEnabled;
    if (v.customFee !== undefined) {
      profile.customFeeMinor = v.customFee === null ? null : toMinor(v.customFee);
    }
    if (v.billingStartsOn !== undefined) profile.startsOn = v.billingStartsOn;
    for (const s of v.students ?? []) bdb.studentPackages.set(s.id, s.feePackageId);
    return HttpResponse.json({ data: familyBillingDto(id) });
  }),

  // ---------------------------------------------------------------- invoices
  http.get(`${API}/invoices`, ({ request }) => {
    const g = guard(request, 'invoices.view');
    if ('error' in g) return g.error;
    const parsed = invoiceListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const today = academyToday();
    const term = q.q?.toLowerCase();
    const scoped = bdb.invoices
      .filter((i) => visible(g.me, i))
      .filter((i) => isParent(g.me) || !q.familyId || i.familyId === q.familyId)
      .filter((i) => {
        if (!q.period) return true;
        return i.periodStart
          ? i.periodStart.slice(0, 7) === q.period
          : i.issueDate?.slice(0, 7) === q.period;
      })
      .filter((i) => {
        if (!term) return true;
        const family = people.families.find((f) => f.id === i.familyId);
        return (
          (i.number ?? '').toLowerCase().includes(term) ||
          (family?.parentName ?? '').toLowerCase().includes(term) ||
          (family?.email ?? '').toLowerCase().includes(term)
        );
      });
    const counts: Record<string, number> = { all: scoped.length, open: 0, overdue: 0 };
    for (const s of INVOICE_STATUSES) counts[s] = 0;
    for (const i of scoped) {
      counts[i.status] = (counts[i.status] ?? 0) + 1;
      if (isOpenInvoice(i.status)) counts.open! += 1;
      if (isOverdue(i, today)) counts.overdue! += 1;
    }
    if (isParent(g.me)) delete counts.draft;
    const rows = scoped
      .filter((i) =>
        q.status === undefined
          ? true
          : q.status === 'open'
            ? isOpenInvoice(i.status)
            : q.status === 'overdue'
              ? isOverdue(i, today)
              : i.status === q.status,
      )
      .sort((a, b) => b.id - a.id)
      .map((i) => invoiceDto(i, today));
    return HttpResponse.json(paginate(rows, q.page, q.perPage, counts));
  }),

  http.post(`${API}/invoices`, async ({ request }) => {
    const g = guardAny(request, 'invoices.manage', 'invoices.request');
    if ('error' in g) return g.error;
    if (isParent(g.me)) return notFound();
    const parsed = createInvoiceSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    const profile = bdb.profiles.get(v.familyId);
    if (!profile) return notFound();
    if (!profile.currency) return billingError('missing_currency', 'familyId');
    const kids = people.students.filter((s) => s.familyId === v.familyId).map((s) => s.id);
    if (v.lines.some((l) => l.studentId && !kids.includes(l.studentId))) {
      return billingError('unknown_student', 'lines');
    }
    const issue = v.issue && has(g.me, 'invoices.manage');
    const today = academyToday();
    const inv: InvoiceRow = {
      id: bdb.next.invoice++,
      number: issue ? nextNumber(bdb, today) : null,
      kind: 'manual',
      status: issue ? 'issued' : 'draft',
      familyId: v.familyId,
      currency: profile.currency,
      periodStart: null,
      periodEnd: null,
      issueDate: issue ? today : null,
      dueDate:
        v.dueDate ?? (issue ? addDays(today, bdb.settings['billing.default_due_days']) : null),
      notes: v.notes ?? null,
      voidReason: null,
      voidedAt: null,
      splitFromId: null,
      paidAt: null,
      createdAt: isoNow(),
      lines: v.lines.map((l) => ({
        id: bdb.next.line++,
        type: 'manual',
        studentId: l.studentId ?? null,
        description: l.description,
        amountMinor: toMinor(l.amount),
        meta: null,
        createdAt: isoNow(),
      })),
    };
    bdb.invoices.push(inv);
    return HttpResponse.json({ data: detailDto(inv, g.me) }, { status: 201 });
  }),

  http.get(`${API}/invoices/:id`, ({ request, params }) => {
    const g = guard(request, 'invoices.view');
    if ('error' in g) return g.error;
    const inv = findInvoice(g.me, Number(params.id));
    if (!inv) return notFound();
    settleCheckouts(inv);
    return HttpResponse.json({ data: detailDto(inv, g.me) });
  }),

  http.post(`${API}/invoices/:id/issue`, ({ request, params }) => {
    const g = guard(request, 'invoices.manage');
    if ('error' in g) return g.error;
    const inv = findInvoice(g.me, Number(params.id));
    if (!inv || isParent(g.me)) return notFound();
    if (inv.status !== 'draft') return billingError('not_draft', 'status');
    if (!inv.lines.length) return billingError('empty_invoice', 'lines');
    const today = academyToday();
    inv.status = 'issued';
    inv.number = nextNumber(bdb, today);
    inv.issueDate = today;
    inv.dueDate ??= addDays(today, bdb.settings['billing.default_due_days']);
    return HttpResponse.json({ data: detailDto(inv, g.me) });
  }),

  http.post(`${API}/invoices/:id/lines`, async ({ request, params }) => {
    const g = guard(request, 'invoices.manage');
    if ('error' in g) return g.error;
    const inv = findInvoice(g.me, Number(params.id));
    if (!inv || isParent(g.me)) return notFound();
    const parsed = addInvoiceLineSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    if (!isEditableInvoice(inv.status)) return billingError('not_editable', 'status');
    const t = totalsOf(bdb, inv);
    const amount =
      v.type === 'discount'
        ? v.percent !== undefined
          ? -percentOf(t.total, v.percent)
          : -Math.abs(toMinor(v.amount ?? '0'))
        : toMinor(v.amount ?? '0');
    if (amount === 0) return billingError('zero_amount', 'amount');
    if (t.total + amount < t.paid || t.total + amount < 0) {
      return billingError('below_paid', 'amount');
    }
    inv.lines.push({
      id: bdb.next.line++,
      type: v.type,
      studentId: null,
      description: v.reason,
      amountMinor: amount,
      meta: v.percent !== undefined ? { percent: v.percent } : null,
      createdAt: isoNow(),
    });
    recalculate(bdb, inv);
    return HttpResponse.json({ data: detailDto(inv, g.me) });
  }),

  http.post(`${API}/invoices/:id/void`, async ({ request, params }) => {
    const g = guard(request, 'invoices.manage');
    if ('error' in g) return g.error;
    const inv = findInvoice(g.me, Number(params.id));
    if (!inv || isParent(g.me)) return notFound();
    const parsed = billingReasonSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    if (!isEditableInvoice(inv.status)) return billingError('not_editable', 'status');
    if (totalsOf(bdb, inv).paid > 0) return billingError('has_payments', 'status');
    inv.status = 'void';
    inv.voidReason = parsed.data.reason;
    inv.voidedAt = isoNow();
    return HttpResponse.json({ data: detailDto(inv, g.me) });
  }),

  http.post(`${API}/invoices/:id/split`, async ({ request, params }) => {
    const g = guard(request, 'invoices.manage');
    if ('error' in g) return g.error;
    const inv = findInvoice(g.me, Number(params.id));
    if (!inv || isParent(g.me)) return notFound();
    const parsed = splitInvoiceSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const t = totalsOf(bdb, inv);
    if (!isOpenInvoice(inv.status) || t.paid > 0) {
      return billingError('split_not_allowed', 'status');
    }
    const sum = parsed.data.parts.reduce((s, p) => s + toMinor(p.amount), 0);
    if (sum !== t.total) {
      return billingError('split_sum', 'parts', 422, { total: fromMinor(t.total) });
    }
    const today = academyToday();
    const n = parsed.data.parts.length;
    const parts = parsed.data.parts.map((p, i) => {
      const part: InvoiceRow = {
        ...inv,
        id: bdb.next.invoice++,
        number: nextNumber(bdb, today),
        kind: 'split',
        status: 'issued',
        periodStart: null,
        periodEnd: null,
        issueDate: today,
        dueDate: p.dueDate,
        notes: parsed.data.reason,
        splitFromId: inv.id,
        paidAt: null,
        createdAt: isoNow(),
        lines: [
          {
            id: bdb.next.line++,
            type: 'split',
            studentId: null,
            description: `Part ${i + 1} of ${n} of invoice ${inv.number ?? inv.id}`,
            amountMinor: toMinor(p.amount),
            meta: { splitFrom: inv.number, part: i + 1, parts: n },
            createdAt: isoNow(),
          },
        ],
      };
      bdb.invoices.push(part);
      return part;
    });
    inv.status = 'split';
    return HttpResponse.json(
      { data: { original: detailDto(inv, g.me), parts: parts.map((p) => invoiceDto(p)) } },
      { status: 201 },
    );
  }),

  http.post(`${API}/invoices/:id/remind`, ({ request, params }) => {
    const g = guard(request, 'invoices.manage');
    if ('error' in g) return g.error;
    const inv = findInvoice(g.me, Number(params.id));
    if (!inv || isParent(g.me)) return notFound();
    if (!isOpenInvoice(inv.status)) return billingError('not_open', 'invoice');
    const last = bdb.reminded.get(inv.id);
    if (last && Date.now() - last < 3_600_000) {
      return billingError('remind_throttled', null, 429);
    }
    if (!bdb.settings['billing.notify_parents']) {
      return apiError(
        422,
        'parent_mail_off',
        BILLING_ERROR_MESSAGES.parent_mail_off.en,
        undefined,
        {
          result: 'disabled',
        },
      );
    }
    bdb.reminded.set(inv.id, Date.now());
    return HttpResponse.json({ data: { result: 'sent' } });
  }),

  http.post(`${API}/invoices/:id/payments`, async ({ request, params }) => {
    const g = guard(request, 'invoices.manage');
    if ('error' in g) return g.error;
    const inv = findInvoice(g.me, Number(params.id));
    if (!inv || isParent(g.me)) return notFound();
    const parsed = manualPaymentSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    if (v.receivedOn > academyToday()) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        receivedOn: ['The date received cannot be in the future.'],
      });
    }
    if (!isOpenInvoice(inv.status)) return billingError('not_open', 'invoice');
    const amount = toMinor(v.amount);
    if (amount > totalsOf(bdb, inv).balance) return billingError('over_balance', 'amount');
    const row: PaymentRow = {
      id: bdb.next.payment++,
      invoiceId: inv.id,
      method: v.method,
      status: 'succeeded',
      amountMinor: amount,
      currency: inv.currency,
      reference: v.reference ?? null,
      note: v.note ?? null,
      receivedAt: instantOf(v.receivedOn, 10),
      refundedAt: null,
      createdAt: isoNow(),
      receiptNumber: nextReceipt(bdb),
      failureReason: null,
      providerPaymentId: null,
      providerRef: null,
      recordedBy: { id: g.me.id, name: g.me.name },
    };
    bdb.payments.push(row);
    recalculate(bdb, inv);
    return HttpResponse.json({ data: paymentDto(row, true) }, { status: 201 });
  }),

  http.post(`${API}/payments/:id/void`, async ({ request, params }) => {
    const g = guard(request, 'invoices.manage');
    if ('error' in g) return g.error;
    if (isParent(g.me)) return notFound();
    const p = bdb.payments.find((x) => x.id === Number(params.id));
    if (!p) return notFound();
    const parsed = billingReasonSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    if (isOnlineMethod(p.method) || p.status !== 'succeeded') {
      return billingError('payment_not_voidable', 'payment');
    }
    p.status = 'cancelled';
    p.note = parsed.data.reason;
    const inv = bdb.invoices.find((i) => i.id === p.invoiceId)!;
    recalculate(bdb, inv);
    return HttpResponse.json({ data: paymentDto(p, true) });
  }),

  http.post(`${API}/invoices/:id/checkout`, async ({ request, params }) => {
    const g = guard(request, 'invoices.pay');
    if ('error' in g) return g.error;
    const inv = findInvoice(g.me, Number(params.id));
    if (!inv) return notFound();
    const parsed = checkoutSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const provider = parsed.data.provider;
    if (!bdb.online.includes(provider)) return billingError('provider_unavailable', 'provider');
    const t = totalsOf(bdb, inv);
    if (!isOpenInvoice(inv.status) || t.balance <= 0) return billingError('not_open', 'invoice');
    const id = bdb.next.payment++;
    const order = `MOCK-ORDER-${id}`;
    bdb.payments.push({
      id,
      invoiceId: inv.id,
      method: provider,
      status: 'pending',
      amountMinor: t.balance,
      currency: inv.currency,
      reference: null,
      note: null,
      receivedAt: null,
      refundedAt: null,
      createdAt: isoNow(),
      receiptNumber: null,
      failureReason: null,
      providerPaymentId: null,
      providerRef: provider === 'paypal' ? order : `cs_test_mock_${id}`,
      recordedBy: null,
    });
    // The mock "provider page" is the app's own return address (the API's return URL shape).
    const back = `/invoices/${inv.id}?checkout=return&provider=${provider}`;
    return HttpResponse.json(
      {
        data: {
          paymentId: id,
          provider,
          amount: fromMinor(t.balance),
          currency: inv.currency,
          url: provider === 'paypal' ? `${back}&token=${order}&PayerID=MOCKPAYER` : back,
        },
      },
      { status: 201 },
    );
  }),

  http.post(`${API}/invoices/:id/paypal/capture`, async ({ request, params }) => {
    const g = guard(request, 'invoices.pay');
    if ('error' in g) return g.error;
    const inv = findInvoice(g.me, Number(params.id));
    if (!inv) return notFound();
    const parsed = paypalCaptureSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const p = bdb.payments.find(
      (x) =>
        x.invoiceId === inv.id && x.method === 'paypal' && x.providerRef === parsed.data.orderId,
    );
    if (!p) return billingError('not_open', 'orderId');
    if (p.status === 'pending') {
      p.status = 'succeeded';
      p.receivedAt = isoNow();
      p.receiptNumber = nextReceipt(bdb);
      p.providerPaymentId = `CAPTURE-${p.id}`;
      recalculate(bdb, inv);
    }
    return HttpResponse.json({ data: paymentDto(p, !isParent(g.me)) });
  }),

  // ---------------------------------------------------------------- monthly run
  http.post(`${API}/invoice-runs/preview`, async ({ request }) => {
    const g = guard(request, 'invoices.manage');
    if ('error' in g) return g.error;
    if (isParent(g.me)) return notFound();
    const parsed = invoiceRunPreviewSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const rows = runRows(parsed.data.period, parsed.data.billingDay, parsed.data.familyIds);
    const totals: Record<string, number> = {};
    for (const { fee, row } of rows) {
      if (row.willIssue && row.currency) {
        totals[row.currency] = (totals[row.currency] ?? 0) + fee.totalMinor;
      }
    }
    return HttpResponse.json({
      data: rows.map((r) => r.row),
      meta: {
        families: rows.length,
        willIssue: rows.filter((r) => r.row.willIssue).length,
        totals: Object.fromEntries(Object.entries(totals).map(([c, m]) => [c, fromMinor(m)])),
      },
    });
  }),

  http.post(`${API}/invoice-runs`, async ({ request }) => {
    const g = guard(request, 'invoices.manage');
    if ('error' in g) return g.error;
    if (isParent(g.me)) return notFound();
    const parsed = invoiceRunSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const v = parsed.data;
    const today = academyToday();
    const issued: number[] = [];
    const skipped: { familyId: number; reason: string }[] = [];
    for (const { fee, row } of runRows(v.period, v.billingDay, v.familyIds)) {
      if (!row.willIssue) {
        skipped.push({
          familyId: row.familyId,
          reason: row.existingInvoiceId ? 'exists' : (row.warnings[0] ?? 'no_fee'),
        });
        continue;
      }
      const inv: InvoiceRow = {
        id: bdb.next.invoice++,
        number: nextNumber(bdb, today),
        kind: 'monthly',
        status: 'issued',
        familyId: row.familyId,
        currency: row.currency!,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        issueDate: today,
        dueDate: v.dueDate,
        notes: null,
        voidReason: null,
        voidedAt: null,
        splitFromId: null,
        paidAt: null,
        createdAt: isoNow(),
        lines: fee.lineRows.map((l) => ({ ...l, id: bdb.next.line++, createdAt: isoNow() })),
      };
      bdb.invoices.push(inv);
      issued.push(inv.id);
    }
    return HttpResponse.json(
      { data: { issued, skipped, issuedCount: issued.length } },
      { status: 201 },
    );
  }),

  // ---------------------------------------------------------------- settings
  http.get(`${API}/settings/billing`, ({ request }) => {
    const g = guard(request, 'settings.view');
    if ('error' in g) return g.error;
    return HttpResponse.json({ data: bdb.settings });
  }),

  http.put(`${API}/settings/billing`, async ({ request }) => {
    const g = guard(request, 'settings.manage');
    if ('error' in g) return g.error;
    const parsed = updateBillingSettingsSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    bdb.settings = { ...bdb.settings, ...parsed.data } as typeof bdb.settings;
    return HttpResponse.json({ data: bdb.settings });
  }),
];
