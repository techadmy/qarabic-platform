import { Injectable } from '@nestjs/common';
import {
  AGEING_BANDS,
  type AgeingBand,
  type DashboardBucket,
  type DashboardMetricsDto,
  type DashboardWidget,
  dashboardQuerySchema,
  type LEAD_SOURCES,
  type LOST_REASONS,
  type UsdMoney,
  visibleWidgets,
} from '@qarabic/shared';
import type { z } from 'zod';
import { ExchangeRatesService } from '../accounting/exchange-rates.js';
import { UsdTotal } from '../accounting/fx.js';
import { Clock } from '../common/clock.js';
import {
  notDemoFamilySql,
  notDemoSessionSql,
  notDemoStudentSql,
  notDemoTeacherSql,
} from '../common/demo.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, addMonths, dateMs, DAY, localDate, toUtc } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';

/*
| D1 (docs/40 §3, D144): the management dashboard's numbers. Every widget is computed only when the
| viewer may see it (DASHBOARD_WIDGET_PERMISSIONS). Day, week and month boundaries are in the
| academy's zone; timestamps are compared as UTC instants. Money comes from payments, invoices and
| the ledger in their own currency, converted to USD at the rate of each amount's month.
*/

type Query = z.output<typeof dashboardQuerySchema>;

interface Range {
  /** Academy-local dates, inclusive. */
  from: string;
  to: string;
  /** UTC instants: [start, end). */
  start: Date;
  end: Date;
}

interface Pending {
  kpis: Record<string, unknown>;
  series: Record<string, unknown>;
}

const LIVE_STAGES = Prisma.sql`stage NOT IN ('cancelled', 'moved_out')`;
/** Invoices that are a real claim on the family (a split parent is replaced by its parts). */
const BILLED = Prisma.sql`status NOT IN ('draft', 'void', 'split')`;
/** D153: the demo accounts are left out of every number. */
const NO_DEMO_SESSION = notDemoSessionSql();
const NO_DEMO_ENROLLMENT = notDemoStudentSql('enrollments.student_id');

const CACHE_MS = 5 * 60_000;

/** The cached, range-bound part; the controller adds the live `waiting` block. */
export type MetricsBody = Omit<DashboardMetricsDto, 'waiting'>;

@Injectable()
export class DashboardMetricsService {
  private readonly cache = new Map<string, { at: number; value: MetricsBody }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly rates: ExchangeRatesService,
    private readonly clock: Clock,
  ) {}

  /** Tests: drop cached results. */
  clearCache(): void {
    this.cache.clear();
  }

  async metrics(query: Query, permissions: ReadonlySet<string>): Promise<MetricsBody> {
    const widgets = visibleWidgets(permissions);
    const zone = await this.settings.get('academy.timezone');
    const today = localDate(this.clock.nowMs(), zone);
    // B122: the current month by default.
    const from = query.from ?? `${today.slice(0, 7)}-01`;
    const to = query.to ?? addDays(addMonths(from, 1), -1);
    const days = (dateMs(to) - dateMs(from)) / DAY + 1;
    const bucket: DashboardBucket =
      query.bucket ?? (days <= 31 ? 'day' : days <= 92 ? 'week' : 'month');
    const range = this.range(from, to, zone);
    const previous =
      query.compare === 'prev' ? this.range(addDays(from, -days), addDays(from, -1), zone) : null;

    // A rate set or changed by accounts shows at once: the rate table is part of the key.
    const [fx] = await this.prisma.$queryRaw<Array<{ n: bigint; at: Date | null }>>`
      SELECT count(*) AS n, max(updated_at) AS at FROM exchange_rates`;
    const key = JSON.stringify([
      widgets,
      from,
      to,
      bucket,
      query.compare,
      zone,
      Number(fx!.n),
      fx!.at?.toISOString() ?? null,
    ]);
    const hit = this.cache.get(key);
    const now = this.clock.nowMs();
    if (hit && now - hit.at < CACHE_MS) return hit.value;

    const has = (w: DashboardWidget) => widgets.includes(w);
    const current = await this.kpis(range, zone, has);
    const before = previous ? await this.kpis(previous, zone, has) : null;
    const pending: Pending = {
      kpis: Object.fromEntries(
        Object.entries(current).map(([k, value]) => [
          k,
          { value, previous: before ? (before[k] ?? null) : null },
        ]),
      ),
      series: await this.series(range, zone, bucket, has),
    };

    // One rate lookup for every money figure, then UsdTotal → UsdMoney everywhere.
    const totals: UsdTotal[] = [];
    collect(pending, totals);
    const book = await this.rates.bookFor(...totals);
    const missing = new Map<string, { currency: string; month: string }>();
    const converted = convert(pending, (t) => {
      const money = t.toMoney(book);
      for (const part of money.byCurrency)
        for (const month of part.missingMonths)
          missing.set(`${part.currency}:${month}`, { currency: part.currency, month });
      return money;
    }) as Pending;

    const value: MetricsBody = {
      range: {
        from,
        to,
        bucket,
        previous: previous ? { from: previous.from, to: previous.to } : null,
        timezone: zone,
      },
      currency: 'USD',
      widgets,
      kpis: converted.kpis,
      series: converted.series,
      missingRates: [...missing.values()].sort(
        (a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency),
      ),
      generatedAt: new Date(now).toISOString(),
    };
    this.cache.set(key, { at: now, value });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  private range(from: string, to: string, zone: string): Range {
    return {
      from,
      to,
      start: new Date(toUtc(from, '00:00', zone)),
      end: new Date(toUtc(addDays(to, 1), '00:00', zone)),
    };
  }

  // ---------------------------------------------------------------- KPIs

  private async kpis(
    r: Range,
    zone: string,
    has: (w: DashboardWidget) => boolean,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (
      has('active_students') ||
      has('teachers_on_duty') ||
      has('attendance_rate') ||
      has('trials')
    ) {
      const [s] = await this.prisma.$queryRaw<
        Array<{
          students: bigint;
          teachers: bigint;
          taken: bigint;
          absent: bigint;
          booked: bigint;
          attended: bigint;
        }>
      >`
        SELECT count(DISTINCT student_id) FILTER (WHERE ${LIVE_STAGES}) AS students,
               count(DISTINCT teacher_id) FILTER (WHERE ${LIVE_STAGES}) AS teachers,
               count(*) FILTER (WHERE stage = 'taken') AS taken,
               count(*) FILTER (WHERE stage = 'absent') AS absent,
               count(*) FILTER (WHERE kind = 'trial' AND ${LIVE_STAGES}) AS booked,
               count(*) FILTER (WHERE kind = 'trial' AND stage = 'taken') AS attended
          FROM class_sessions
         WHERE deleted_at IS NULL AND starts_at >= ${r.start} AND starts_at < ${r.end}
           AND ${NO_DEMO_SESSION}`;
      if (has('active_students')) out.active_students = Number(s!.students);
      if (has('teachers_on_duty')) out.teachers_on_duty = Number(s!.teachers);
      if (has('attendance_rate')) {
        const marked = Number(s!.taken) + Number(s!.absent);
        out.attendance_rate = marked ? round4(Number(s!.taken) / marked) : null;
      }
      if (has('trials')) {
        const [c] = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM leads
           WHERE converted_at >= ${r.start} AND converted_at < ${r.end}`;
        const attended = Number(s!.attended);
        const converted = Number(c!.n);
        out.trials = {
          booked: Number(s!.booked),
          attended,
          converted,
          conversionRate: attended ? round4(converted / attended) : null,
        };
      }
    }
    if (has('new_students')) {
      const [n] = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM (
          SELECT min(starts_on) AS first FROM enrollments WHERE kind = 'regular' AND ${NO_DEMO_ENROLLMENT} GROUP BY student_id
        ) f WHERE f.first BETWEEN ${r.from}::date AND ${r.to}::date`;
      out.new_students = Number(n!.n);
    }
    if (has('collected')) {
      const total = new UsdTotal();
      for (const row of await this.collected(r, zone, 'month'))
        total.add(row.currency, row.month, row.amount);
      out.collected = total;
    }
    if (has('outstanding')) {
      const { total, overdue } = await this.outstanding(r.to, r.end);
      out.outstanding = { total, overdue };
    }
    if (has('collection_rate')) out.collection_rate = await this.collectionRate(r);
    if (has('gross_profit') || has('net_profit')) {
      const gross = new UsdTotal();
      const net = new UsdTotal();
      for (const row of await this.ledger(r, 'month')) addLedger(row, gross, net);
      if (has('gross_profit')) out.gross_profit = gross;
      if (has('net_profit')) out.net_profit = net;
    }
    return out;
  }

  // ---------------------------------------------------------------- series

  private async series(
    r: Range,
    zone: string,
    bucket: DashboardBucket,
    has: (w: DashboardWidget) => boolean,
  ): Promise<Record<string, unknown>> {
    const keys = bucketKeys(r.from, r.to, bucket);
    const out: Record<string, unknown> = {};

    if (has('revenue_expenses')) {
      const points = new Map(
        keys.map((k) => [
          k,
          {
            revenue: new UsdTotal(),
            teacherPay: new UsdTotal(),
            otherExpenses: new UsdTotal(),
            grossProfit: new UsdTotal(),
            netProfit: new UsdTotal(),
          },
        ]),
      );
      for (const row of await this.ledger(r, bucket)) {
        const p = points.get(row.bucket);
        if (!p) continue;
        const amount = new Prisma.Decimal(row.net);
        if (row.type === 'income') p.revenue.add(row.currency, row.month, amount);
        else
          (row.teacher ? p.teacherPay : p.otherExpenses).add(row.currency, row.month, amount.neg());
        addLedger(row, p.grossProfit, p.netProfit);
      }
      out.revenue_expenses = keys.map((k) => ({ bucket: k, ...points.get(k)! }));
    }

    if (has('collections')) {
      const points = new Map(
        keys.map((k) => [k, { collected: new UsdTotal(), invoiced: new UsdTotal() }]),
      );
      for (const row of await this.collected(r, zone, bucket))
        points.get(row.bucket)?.collected.add(row.currency, row.month, row.amount);
      const invoiced = await this.prisma.$queryRaw<
        Array<{ bucket: string; currency: string; month: string; amount: Prisma.Decimal }>
      >`
        SELECT to_char(${trunc(bucket, Prisma.sql`issue_date::timestamp`)}, 'YYYY-MM-DD') AS bucket, currency,
               to_char(issue_date, 'YYYY-MM') AS month, sum(total) AS amount
          FROM invoices
         WHERE ${BILLED} AND issue_date BETWEEN ${r.from}::date AND ${r.to}::date
           AND ${notDemoFamilySql('invoices.family_id')}
         GROUP BY 1, 2, 3`;
      for (const row of invoiced)
        points.get(row.bucket)?.invoiced.add(row.currency, row.month, row.amount);
      const ageing = (await this.outstanding(r.to, r.end)).ageing;
      out.collections = {
        points: keys.map((k) => ({ bucket: k, ...points.get(k)! })),
        ageing,
      };
    }

    if (has('students_trials')) {
      const points = new Map(
        keys.map((k) => [
          k,
          { newStudents: 0, trialsBooked: 0, trialsAttended: 0, trialsConverted: 0 },
        ]),
      );
      const firsts = await this.prisma.$queryRaw<Array<{ bucket: string; n: bigint }>>`
        SELECT to_char(${trunc(bucket, Prisma.sql`f.first::timestamp`)}, 'YYYY-MM-DD') AS bucket, count(*) AS n
          FROM (SELECT min(starts_on) AS first FROM enrollments WHERE kind = 'regular' AND ${NO_DEMO_ENROLLMENT} GROUP BY student_id) f
         WHERE f.first BETWEEN ${r.from}::date AND ${r.to}::date
         GROUP BY 1`;
      for (const row of firsts) {
        const p = points.get(row.bucket);
        if (p) p.newStudents = Number(row.n);
      }
      const trials = await this.prisma.$queryRaw<
        Array<{ bucket: string; booked: bigint; attended: bigint }>
      >`
        SELECT to_char(${trunc(bucket, Prisma.sql`starts_at AT TIME ZONE ${zone}`)}, 'YYYY-MM-DD') AS bucket,
               count(*) FILTER (WHERE ${LIVE_STAGES}) AS booked,
               count(*) FILTER (WHERE stage = 'taken') AS attended
          FROM class_sessions
         WHERE deleted_at IS NULL AND kind = 'trial' AND starts_at >= ${r.start} AND starts_at < ${r.end}
           AND ${NO_DEMO_SESSION}
         GROUP BY 1`;
      for (const row of trials) {
        const p = points.get(row.bucket);
        if (!p) continue;
        p.trialsBooked = Number(row.booked);
        p.trialsAttended = Number(row.attended);
      }
      const converted = await this.prisma.$queryRaw<Array<{ bucket: string; n: bigint }>>`
        SELECT to_char(${trunc(bucket, Prisma.sql`converted_at AT TIME ZONE ${zone}`)}, 'YYYY-MM-DD') AS bucket,
               count(*) AS n
          FROM leads WHERE converted_at >= ${r.start} AND converted_at < ${r.end}
         GROUP BY 1`;
      for (const row of converted) {
        const p = points.get(row.bucket);
        if (p) p.trialsConverted = Number(row.n);
      }
      out.students_trials = keys.map((k) => ({ bucket: k, ...points.get(k)! }));
    }

    if (has('leads_by_source')) {
      const rows = await this.prisma.$queryRaw<
        Array<{ source: (typeof LEAD_SOURCES)[number]; n: bigint }>
      >`
        SELECT source::text AS source, count(*) AS n FROM leads
         WHERE status NOT IN ('spam', 'job_applicant')
           AND created_at >= ${r.start} AND created_at < ${r.end}
         GROUP BY 1 ORDER BY 2 DESC, 1`;
      out.leads_by_source = rows.map((x) => ({ source: x.source, count: Number(x.n) }));
    }

    if (has('lost_reasons')) {
      const rows = await this.prisma.$queryRaw<
        Array<{ reason: (typeof LOST_REASONS)[number]; n: bigint }>
      >`
        SELECT lost_reason::text AS reason, count(*) AS n FROM leads
         WHERE status = 'lost' AND lost_reason IS NOT NULL
           AND status_changed_at >= ${r.start} AND status_changed_at < ${r.end}
         GROUP BY 1 ORDER BY 2 DESC, 1`;
      out.lost_reasons = rows.map((x) => ({ reason: x.reason, count: Number(x.n) }));
    }

    if (has('class_outcomes')) {
      const zero = () => ({ taken: 0, absent: 0, leave: 0, declined: 0, cancelled: 0 });
      const points = new Map(keys.map((k) => [k, zero()]));
      const rows = await this.prisma.$queryRaw<Array<{ bucket: string; stage: string; n: bigint }>>`
        SELECT to_char(${trunc(bucket, Prisma.sql`starts_at AT TIME ZONE ${zone}`)}, 'YYYY-MM-DD') AS bucket,
               stage::text AS stage, count(*) AS n
          FROM class_sessions
         WHERE deleted_at IS NULL AND stage IN ('taken', 'absent', 'leave', 'declined', 'cancelled')
           AND starts_at >= ${r.start} AND starts_at < ${r.end}
           AND ${NO_DEMO_SESSION}
         GROUP BY 1, 2`;
      for (const row of rows) {
        const p = points.get(row.bucket);
        if (p) p[row.stage as keyof ReturnType<typeof zero>] = Number(row.n);
      }
      out.class_outcomes = keys.map((k) => ({ bucket: k, ...points.get(k)! }));
    }

    if (has('teacher_hours')) {
      // Payroll is monthly: one point per payroll period in the range, whatever the bucket.
      const rows = await this.prisma.$queryRaw<
        Array<{ period: string; currency: string; hours: Prisma.Decimal; net: Prisma.Decimal }>
      >`
        SELECT r.period, s.currency, sum(s.paid_hours) AS hours, sum(s.net) AS net
          FROM payslips s JOIN payroll_runs r ON r.id = s.payroll_run_id
         WHERE s.teacher_id IS NOT NULL AND ${notDemoTeacherSql('s.teacher_id')}
           AND r.period BETWEEN ${r.from.slice(0, 7)} AND ${r.to.slice(0, 7)}
         GROUP BY 1, 2 ORDER BY 1`;
      const points = new Map<string, { hours: number; payroll: UsdTotal }>();
      for (const row of rows) {
        const p = points.get(row.period) ?? { hours: 0, payroll: new UsdTotal() };
        p.hours = round2(p.hours + Number(row.hours));
        p.payroll.add(row.currency, row.period, row.net);
        points.set(row.period, p);
      }
      out.teacher_hours = [...points.entries()].map(([period, p]) => ({
        bucket: `${period}-01`,
        ...p,
      }));
    }
    return out;
  }

  // ---------------------------------------------------------------- money sources

  /** Succeeded payments received in the range (credit use is not new money), by bucket. */
  private collected(r: Range, zone: string, bucket: DashboardBucket) {
    return this.prisma.$queryRaw<
      Array<{ bucket: string; currency: string; month: string; amount: Prisma.Decimal }>
    >`
      SELECT to_char(${trunc(bucket, Prisma.sql`received_at AT TIME ZONE ${zone}`)}, 'YYYY-MM-DD') AS bucket,
             currency, to_char(received_at AT TIME ZONE ${zone}, 'YYYY-MM') AS month,
             sum(amount) AS amount
        FROM payments
       WHERE status = 'succeeded' AND method <> 'credit'
         AND received_at >= ${r.start} AND received_at < ${r.end}
         AND ${notDemoFamilySql('payments.family_id')}
       GROUP BY 1, 2, 3`;
  }

  /**
   * Open balance at the end of `to`: billed invoices issued by then, minus what was applied from
   * payments received by then. Overdue = due before `to`; ageing by days past due.
   */
  private async outstanding(to: string, end: Date) {
    const rows = await this.prisma.$queryRaw<
      Array<{ currency: string; month: string; balance: Prisma.Decimal; days: number | null }>
    >`
      SELECT i.currency, to_char(i.issue_date, 'YYYY-MM') AS month,
             i.total - coalesce(p.applied, 0) AS balance,
             CASE WHEN i.due_date < ${to}::date THEN (${to}::date - i.due_date) END AS days
        FROM invoices i
        LEFT JOIN (
          SELECT invoice_id, sum(amount - unapplied) AS applied FROM payments
           WHERE status = 'succeeded' AND received_at < ${end}
           GROUP BY invoice_id
        ) p ON p.invoice_id = i.id
       WHERE i.status NOT IN ('draft', 'void', 'split') AND i.issue_date <= ${to}::date
         AND i.total - coalesce(p.applied, 0) > 0
         AND ${notDemoFamilySql('i.family_id')}`;
    const total = new UsdTotal();
    const overdue = new UsdTotal();
    const ageing = Object.fromEntries(AGEING_BANDS.map((b) => [b, new UsdTotal()])) as Record<
      AgeingBand,
      UsdTotal
    >;
    for (const row of rows) {
      total.add(row.currency, row.month, row.balance);
      if (row.days === null) continue;
      overdue.add(row.currency, row.month, row.balance);
      const band: AgeingBand =
        row.days <= 30
          ? 'd0_30'
          : row.days <= 60
            ? 'd31_60'
            : row.days <= 90
              ? 'd61_90'
              : 'd90_plus';
      ageing[band].add(row.currency, row.month, row.balance);
    }
    return { total, overdue, ageing };
  }

  /**
   * D146: of the billed invoices due in the range, the share paid by its end (USD, at each
   * invoice's issue-month rate). Resolved to a ratio after conversion.
   */
  private async collectionRate(r: Range): Promise<UsdRatio> {
    const rows = await this.prisma.$queryRaw<
      Array<{ currency: string; month: string; total: Prisma.Decimal; paid: Prisma.Decimal }>
    >`
      SELECT i.currency, to_char(i.issue_date, 'YYYY-MM') AS month, i.total,
             least(i.total, coalesce(p.applied, 0)) AS paid
        FROM invoices i
        LEFT JOIN (
          SELECT invoice_id, sum(amount - unapplied) AS applied FROM payments
           WHERE status = 'succeeded' AND received_at < ${r.end}
           GROUP BY invoice_id
        ) p ON p.invoice_id = i.id
       WHERE i.status NOT IN ('draft', 'void', 'split')
         AND i.due_date BETWEEN ${r.from}::date AND ${r.to}::date
         AND ${notDemoFamilySql('i.family_id')}`;
    const ratio = new UsdRatio();
    for (const row of rows) {
      ratio.due.add(row.currency, row.month, row.total);
      ratio.paid.add(row.currency, row.month, row.paid);
    }
    return ratio;
  }

  /** Income and expense lines (credit − debit) by bucket, currency, month and teacher pay. */
  private ledger(r: Range, bucket: DashboardBucket) {
    return this.prisma.$queryRaw<
      Array<{
        bucket: string;
        currency: string;
        month: string;
        type: 'income' | 'expense';
        teacher: boolean;
        net: Prisma.Decimal;
      }>
    >`
      SELECT to_char(${trunc(bucket, Prisma.sql`l.entry_date::timestamp`)}, 'YYYY-MM-DD') AS bucket, l.currency,
             to_char(l.entry_date, 'YYYY-MM') AS month, a.type::text AS type,
             coalesce(a.system_key = 'salaries_expense', false) AS teacher,
             sum(l.credit - l.debit) AS net
        FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
       WHERE a.type IN ('income', 'expense')
         AND l.entry_date BETWEEN ${r.from}::date AND ${r.to}::date
       GROUP BY 1, 2, 3, 4, 5`;
  }
}

// ------------------------------------------------------------------ helpers

/** B123: gross = revenue − teacher pay; net = revenue − every expense. Lines are credit − debit. */
function addLedger(
  row: {
    currency: string;
    month: string;
    type: 'income' | 'expense';
    teacher: boolean;
    net: Prisma.Decimal;
  },
  gross: UsdTotal,
  net: UsdTotal,
): void {
  net.add(row.currency, row.month, row.net);
  if (row.type === 'income' || row.teacher) gross.add(row.currency, row.month, row.net);
}

/**
 * The bucket start of a local timestamp or date. The academy's week starts on Saturday (docs/15
 * §5.12): Postgres weeks start on Monday, so shift by two days, truncate, and shift back.
 */
function trunc(bucket: DashboardBucket, value: Prisma.Sql): Prisma.Sql {
  return bucket === 'week'
    ? Prisma.sql`(date_trunc('week', ${value} + interval '2 days') - interval '2 days')`
    : Prisma.sql`date_trunc(${bucket}, ${value})`;
}

/** First academy-local day of every bucket that overlaps [from, to] (weeks start on Saturday). */
export function bucketKeys(from: string, to: string, bucket: DashboardBucket): string[] {
  const start =
    bucket === 'day'
      ? from
      : bucket === 'month'
        ? `${from.slice(0, 7)}-01`
        : addDays(from, -((new Date(`${from}T00:00:00Z`).getUTCDay() + 1) % 7));
  const keys: string[] = [];
  for (let k = start; k <= to;) {
    keys.push(k);
    k = bucket === 'day' ? addDays(k, 1) : bucket === 'week' ? addDays(k, 7) : addMonths(k, 1);
  }
  return keys;
}

/** paid ÷ due, both in USD; null when nothing was due or a rate is missing. */
class UsdRatio {
  readonly paid = new UsdTotal();
  readonly due = new UsdTotal();

  resolve(money: (t: UsdTotal) => UsdMoney): number | null {
    const paid = money(this.paid);
    const due = money(this.due);
    if (paid.usd === null || due.usd === null || Number(due.usd) === 0) return null;
    return round4(Number(paid.usd) / Number(due.usd));
  }
}

function collect(value: unknown, into: UsdTotal[]): void {
  if (value instanceof UsdRatio) into.push(value.paid, value.due);
  else if (value instanceof UsdTotal) into.push(value);
  else if (Array.isArray(value)) for (const v of value) collect(v, into);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) collect(v, into);
}

function convert(value: unknown, money: (t: UsdTotal) => UsdMoney): unknown {
  if (value instanceof UsdRatio) return value.resolve(money);
  if (value instanceof UsdTotal) return money(value);
  if (Array.isArray(value)) return value.map((v) => convert(v, money));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v, money)]));
  return value;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
