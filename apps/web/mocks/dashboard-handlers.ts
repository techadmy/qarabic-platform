import { http, HttpResponse, type HttpHandler } from 'msw';
import type { DashboardMetricsDto } from '@/lib/dashboard/metrics';
import { addDays } from '@/lib/schedule-time';
import { guardAny } from './session';
import type { MockUser } from './data';

/**
 * The mock `GET /dashboard/metrics` (D1 shape, docs/40 §5): deterministic numbers per bucket so
 * screenshots and tests are stable, each KPI and series `null` without its module permission
 * (as the API). The oldest finance month has no GBP rate, to show the `missingRate` warning.
 */
const API = '*/api/v1';
const has = (me: MockUser, p: string) => me.permissions.includes(p);

/** A stable pseudo-random 0–1 from a string. */
function noise(seed: string): number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}
const money = (n: number) => n.toFixed(2);
const days = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

function buckets(from: string, to: string, bucket: 'day' | 'week' | 'month'): string[] {
  const out: string[] = [];
  if (bucket === 'month') {
    let d = `${from.slice(0, 7)}-01`;
    while (d <= to) {
      out.push(d);
      const y = Number(d.slice(0, 4));
      const m = Number(d.slice(5, 7));
      d = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
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
  return {
    activeStudents: Math.max(1, Math.round(140 * (0.9 + noise('as' + from) * 0.2))),
    newStudents: f('ns', 18),
    teachersOnDuty: Math.round(22 * (0.9 + noise('td' + from) * 0.2)),
    booked: f('tb', 40),
    attended: f('ta', 31),
    converted: f('tc', 12),
    collected: f('co', 9800),
    outstanding: f('ou', 3100),
    overdue: f('ov', 1200),
    profit: f('gp', 4100),
    attendance: Math.round(82 + noise('at' + from) * 12),
  };
}

export const dashboardHandlers: HttpHandler[] = [
  http.get(`${API}/dashboard/metrics`, ({ request }) => {
    const g = guardAny(
      request,
      'sessions.view',
      'leads.view',
      'invoices.view',
      'reports.financial',
      'payroll.view',
    );
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
    const compare = q.get('compare') === '1';
    const length = days(from, to);
    const previous = compare ? { from: addDays(from, -length), to: addDays(from, -1) } : null;
    const now = totals(from, to);
    const before = previous ? totals(previous.from, previous.to) : null;
    const me = g.me;
    const sessions = has(me, 'sessions.view');
    const leads = has(me, 'leads.view');
    const invoices = has(me, 'invoices.view');
    const financial = has(me, 'reports.financial');
    const payroll = has(me, 'payroll.view');
    const kpi = (k: keyof ReturnType<typeof totals>) => ({
      value: now[k],
      previous: before ? before[k] : null,
    });
    const moneyKpi = (k: 'collected' | 'outstanding' | 'profit') => ({
      value: money(now[k]),
      previous: before ? money(before[k]) : null,
      missingRate: false,
    });
    const list = buckets(from, to, bucket);
    const scale = bucket === 'month' ? 1 : bucket === 'week' ? 0.25 : 1 / 30;
    const data: DashboardMetricsDto = {
      range: { from, to, bucket },
      previous,
      currency: 'USD',
      kpis: {
        activeStudents: sessions ? kpi('activeStudents') : null,
        newStudents: sessions ? kpi('newStudents') : null,
        teachersOnDuty: sessions ? kpi('teachersOnDuty') : null,
        trials: leads
          ? {
              booked: kpi('booked'),
              attended: kpi('attended'),
              converted: kpi('converted'),
              conversionPct: now.attended
                ? Math.round((now.converted / now.attended) * 1000) / 10
                : null,
            }
          : null,
        collected: invoices ? moneyKpi('collected') : null,
        outstanding: invoices ? { ...moneyKpi('outstanding'), overdue: money(now.overdue) } : null,
        grossProfit: financial ? moneyKpi('profit') : null,
        attendanceRate: sessions ? kpi('attendance') : null,
      },
      series: {
        finance: financial
          ? list.map((b, i) => {
              const revenue = 11000 * scale * (0.85 + noise('r' + b) * 0.3);
              const expenses = 6800 * scale * (0.85 + noise('e' + b) * 0.3);
              return {
                bucket: b,
                revenue: money(revenue),
                expenses: money(expenses),
                profit: money(revenue - expenses),
                missingRate: bucket === 'month' && i === 0 && list.length > 1,
              };
            })
          : null,
        collections: invoices
          ? list.map((b) => ({
              bucket: b,
              collected: money(9800 * scale * (0.8 + noise('c' + b) * 0.4)),
              invoiced: money(10400 * scale * (0.85 + noise('i' + b) * 0.3)),
              missingRate: false,
            }))
          : null,
        ageing: invoices
          ? { d0_30: money(1900), d31_60: money(640), d61_90: money(310), d90: money(250) }
          : null,
        growth: leads
          ? list.map((b) => ({
              bucket: b,
              newStudents: Math.round(18 * scale * (0.6 + noise('n' + b) * 0.8)),
              trials: Math.round(40 * scale * (0.6 + noise('t' + b) * 0.8)),
              converted: Math.round(12 * scale * (0.6 + noise('v' + b) * 0.8)),
            }))
          : null,
        leadSources: leads
          ? [
              { source: 'website', count: 41 },
              { source: 'whatsapp', count: 27 },
              { source: 'referral', count: 18 },
              { source: 'facebook', count: 12 },
            ]
          : null,
        lostReasons: leads
          ? [
              { reason: 'price', count: 9 },
              { reason: 'no_response', count: 7 },
              { reason: 'timing', count: 4 },
            ]
          : null,
        outcomes: sessions
          ? list.map((b) => {
              const n = Math.max(1, Math.round(900 * scale));
              return {
                bucket: b,
                taken: Math.round(n * (0.74 + noise('k' + b) * 0.08)),
                absent: Math.round(n * (0.06 + noise('a' + b) * 0.04)),
                leave: Math.round(n * 0.05),
                declined: Math.round(n * 0.03),
                cancelled: Math.round(n * 0.02),
              };
            })
          : null,
        teacherHours: payroll
          ? list.map((b) => ({
              bucket: b,
              hours: Math.round(620 * scale * (0.9 + noise('h' + b) * 0.2)),
              payroll: money(4300 * scale * (0.9 + noise('p' + b) * 0.2)),
            }))
          : null,
      },
    };
    return HttpResponse.json({ data });
  }),
];
