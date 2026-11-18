import {
  DASHBOARD_WAITING_LINKS,
  visibleWaiting,
  visibleWidgets,
  type DashboardMetricsDto,
  type DashboardWidget,
  type UsdMoney,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { addDays } from '@/lib/schedule-time';
import { guard } from './session';

/**
 * The mock `GET /dashboard/metrics` (docs/40 D1, `dashboardMetricsSchema` in `@qarabic/shared`):
 * deterministic numbers per bucket so screenshots and tests are stable; only the widgets
 * `visibleWidgets()` allows (every other key absent, as the API). The oldest month of a long range
 * has GBP payments with no exchange rate: those amounts carry `missingRate` and no USD total.
 * `waiting` (D3) has fixed counts for the items `visibleWaiting()` allows.
 */
const API = '*/api/v1';

/** A stable pseudo-random 0–1 from a string. */
function noise(seed: string): number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}
const days = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

/** USD money; with `gbpMissing`, part of it is in GBP with no rate for `month`. */
function usd(n: number, gbpMissing?: string): UsdMoney {
  if (gbpMissing) {
    return {
      usd: null,
      missingRate: true,
      byCurrency: [
        {
          currency: 'USD',
          amount: (n * 0.8).toFixed(2),
          usd: (n * 0.8).toFixed(2),
          missingMonths: [],
        },
        { currency: 'GBP', amount: (n * 0.16).toFixed(2), usd: null, missingMonths: [gbpMissing] },
      ],
    };
  }
  return {
    usd: n.toFixed(2),
    missingRate: false,
    byCurrency: [{ currency: 'USD', amount: n.toFixed(2), usd: n.toFixed(2), missingMonths: [] }],
  };
}

function buckets(from: string, to: string, bucket: 'day' | 'week' | 'month'): string[] {
  const out: string[] = [];
  if (bucket === 'month') {
    let d = `${from.slice(0, 7)}-01`;
    while (d <= to) {
      out.push(d);
      d = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 1))
        .toISOString()
        .slice(0, 10);
    }
    return out;
  }
  const step = bucket === 'week' ? 7 : 1;
  for (let d = from; d <= to; d = addDays(d, step)) out.push(d);
  return out;
}

/** Totals of a period, scaled by its length (so compare shows a real change). */
function totals(from: string, to: string) {
  const n = days(from, to);
  const f = (k: string, base: number) =>
    Math.round(base * (n / 30) * (0.85 + noise(k + from) * 0.3));
  const booked = f('tb', 40);
  const attended = Math.round(booked * 0.78);
  const converted = Math.round(attended * 0.38);
  return {
    activeStudents: Math.round(140 * (0.9 + noise('as' + from) * 0.2)),
    newStudents: f('ns', 18),
    teachersOnDuty: Math.round(22 * (0.9 + noise('td' + from) * 0.2)),
    trials: {
      booked,
      attended,
      converted,
      conversionRate: attended ? Math.round((converted / attended) * 1000) / 1000 : null,
    },
    attendance: Math.round((0.82 + noise('at' + from) * 0.12) * 1000) / 1000,
    collected: f('co', 9800),
    outstanding: f('ou', 3100),
    overdue: f('ov', 1200),
    gross: f('gp', 5200),
    net: f('np', 4100),
  };
}

export const dashboardHandlers: HttpHandler[] = [
  http.get(`${API}/dashboard/metrics`, ({ request }) => {
    const g = guard(request, 'reports.view');
    if ('error' in g) return g.error;
    const q = new URL(request.url).searchParams;
    const from = q.get('from') ?? '';
    const to = q.get('to') ?? '';
    const bucket = (q.get('bucket') ?? 'day') as 'day' | 'week' | 'month';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
      return HttpResponse.json(
        {
          message: 'The given data was invalid.',
          code: 'validation_failed',
          errors: { to: ['Bad range.'] },
        },
        { status: 422 },
      );
    }
    const length = days(from, to);
    const previous =
      q.get('compare') === 'none' ? null : { from: addDays(from, -length), to: addDays(from, -1) };
    const now = totals(from, to);
    const before = previous ? totals(previous.from, previous.to) : null;
    const widgets = visibleWidgets(new Set(g.me.permissions));
    const has = (w: DashboardWidget) => widgets.includes(w);
    const list = buckets(from, to, bucket);
    const scale = bucket === 'month' ? 1 : bucket === 'week' ? 0.25 : 1 / 30;
    // The first month of a long range has GBP with no rate (D144: said, never 0).
    const noRate = bucket === 'month' && list.length > 1 ? list[0]!.slice(0, 7) : null;
    const pointMoney = (b: string, n: number) =>
      usd(n, noRate && b.startsWith(noRate) ? noRate : undefined);

    const kpis: DashboardMetricsDto['kpis'] = {};
    const count = (k: 'activeStudents' | 'newStudents' | 'teachersOnDuty') => ({
      value: now[k],
      previous: before ? before[k] : null,
    });
    if (has('active_students')) kpis.active_students = count('activeStudents');
    if (has('new_students')) kpis.new_students = count('newStudents');
    if (has('teachers_on_duty')) kpis.teachers_on_duty = count('teachersOnDuty');
    if (has('trials')) kpis.trials = { value: now.trials, previous: before?.trials ?? null };
    if (has('attendance_rate')) {
      kpis.attendance_rate = { value: now.attendance, previous: before?.attendance ?? null };
    }
    if (has('collected')) {
      kpis.collected = {
        value: usd(now.collected, noRate ?? undefined),
        previous: before ? usd(before.collected) : null,
      };
    }
    if (has('outstanding')) {
      kpis.outstanding = {
        value: { total: usd(now.outstanding), overdue: usd(now.overdue) },
        previous: before ? { total: usd(before.outstanding), overdue: usd(before.overdue) } : null,
      };
    }
    if (has('collection_rate')) {
      // D146: unknown (null) when a month of the period has no rate.
      const rate = (seed: string) => Math.round((0.78 + noise(seed) * 0.17) * 1000) / 1000;
      kpis.collection_rate = {
        value: noRate ? null : rate('cr' + from),
        previous: previous ? rate('cr' + previous.from) : null,
      };
    }
    if (has('gross_profit')) {
      kpis.gross_profit = { value: usd(now.gross), previous: before ? usd(before.gross) : null };
    }
    if (has('net_profit')) {
      kpis.net_profit = { value: usd(now.net), previous: before ? usd(before.net) : null };
    }

    const series: DashboardMetricsDto['series'] = {};
    if (has('revenue_expenses')) {
      series.revenue_expenses = list.map((b) => {
        const revenue = 11000 * scale * (0.85 + noise('r' + b) * 0.3);
        const pay = 4600 * scale * (0.85 + noise('p' + b) * 0.3);
        const other = 2100 * scale * (0.85 + noise('o' + b) * 0.3);
        return {
          bucket: b,
          revenue: pointMoney(b, revenue),
          teacherPay: usd(pay),
          otherExpenses: usd(other),
          grossProfit: pointMoney(b, revenue - pay),
          netProfit: pointMoney(b, revenue - pay - other),
        };
      });
    }
    if (has('collections')) {
      series.collections = {
        points: list.map((b) => ({
          bucket: b,
          collected: pointMoney(b, 9800 * scale * (0.8 + noise('c' + b) * 0.4)),
          invoiced: usd(10400 * scale * (0.85 + noise('i' + b) * 0.3)),
        })),
        ageing: { d0_30: usd(1900), d31_60: usd(640), d61_90: usd(310), d90_plus: usd(250) },
      };
    }
    if (has('students_trials')) {
      series.students_trials = list.map((b) => {
        const booked = Math.round(40 * scale * (0.6 + noise('t' + b) * 0.8));
        const attended = Math.round(booked * 0.78);
        return {
          bucket: b,
          newStudents: Math.round(18 * scale * (0.6 + noise('n' + b) * 0.8)),
          trialsBooked: booked,
          trialsAttended: attended,
          trialsConverted: Math.round(attended * 0.38),
        };
      });
    }
    if (has('leads_by_source')) {
      series.leads_by_source = [
        { source: 'web_form', count: 41 },
        { source: 'whatsapp', count: 27 },
        { source: 'referral', count: 18 },
      ];
    }
    if (has('lost_reasons')) {
      series.lost_reasons = [
        { reason: 'no_response', count: 14 },
        { reason: 'price', count: 9 },
        { reason: 'schedule', count: 6 },
        { reason: 'not_interested', count: 4 },
      ];
    }
    if (has('class_outcomes')) {
      series.class_outcomes = list.map((b) => {
        const n = Math.max(1, Math.round(900 * scale));
        return {
          bucket: b,
          taken: Math.round(n * (0.74 + noise('k' + b) * 0.08)),
          absent: Math.round(n * (0.06 + noise('a' + b) * 0.04)),
          leave: Math.round(n * 0.05),
          declined: Math.round(n * 0.03),
          cancelled: Math.round(n * 0.02),
        };
      });
    }
    if (has('teacher_hours')) {
      series.teacher_hours = list.map((b) => ({
        bucket: b,
        hours: Math.round(620 * scale * (0.9 + noise('h' + b) * 0.2)),
        payroll: usd(4300 * scale * (0.9 + noise('p' + b) * 0.2)),
      }));
    }

    const data: DashboardMetricsDto = {
      range: { from, to, bucket, previous, timezone: 'Africa/Cairo' },
      currency: 'USD',
      widgets,
      kpis,
      series,
      missingRates:
        noRate && widgets.some((w) => ['collected', 'revenue_expenses', 'collections'].includes(w))
          ? [{ currency: 'GBP', month: noRate }]
          : [],
      // D3 «waiting for action»: fixed counts, only the items this viewer may open.
      waiting: visibleWaiting(new Set(g.me.permissions)).map((key, i) => ({
        key,
        count: [4, 1, 2, 3, 0][i % 5]!,
        href: DASHBOARD_WAITING_LINKS[key],
      })),
      generatedAt: new Date().toISOString(),
    };
    return HttpResponse.json({ data });
  }),
];
