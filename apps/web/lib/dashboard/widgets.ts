import { visibleWidgets, type DashboardWidget, type UsdMoney } from '@qarabic/shared';

/**
 * The dashboard's layout over the shared widget list (docs/40 §2.1–2.2): which widgets are KPI
 * cards and which are charts, and the list each KPI opens (docs/40 §2.5). Who may see a widget
 * comes from `visibleWidgets()` in `@qarabic/shared`, the same rule the API applies; the endpoint
 * itself needs `reports.view`, so without it nothing is shown (no card would load).
 */
export const KPI_WIDGETS = [
  'active_students',
  'new_students',
  'teachers_on_duty',
  'trials',
  'attendance_rate',
  'collected',
  'outstanding',
  'gross_profit',
  'net_profit',
] as const satisfies readonly DashboardWidget[];
export type KpiWidget = (typeof KPI_WIDGETS)[number];

/** D2: the four main charts (the rest come in D3). */
export const MAIN_CHARTS = [
  'revenue_expenses',
  'collections',
  'students_trials',
  'class_outcomes',
] as const satisfies readonly DashboardWidget[];
export type MainChart = (typeof MAIN_CHARTS)[number];

export function dashboardLayout(permissions: readonly string[]) {
  if (!permissions.includes('reports.view')) return { kpis: [], charts: [] };
  const visible = visibleWidgets(new Set(permissions));
  return {
    kpis: KPI_WIDGETS.filter((w) => visible.includes(w)),
    charts: MAIN_CHARTS.filter((w) => visible.includes(w)),
  };
}

/**
 * The list behind a KPI, narrowed to the range where that list can be: the income statement and
 * the lead KPIs take from/to, the Today board and the trials checklist a single day, invoices a
 * month. Lists without a date filter (students, teachers) open whole for now (docs/31).
 */
export function kpiHref(widget: KpiWidget, range: { from: string; to: string }): string {
  const oneDay = range.from === range.to;
  const oneMonth = range.from.slice(0, 7) === range.to.slice(0, 7);
  const span = `from=${range.from}&to=${range.to}`;
  switch (widget) {
    case 'active_students':
      return '/students?status=active';
    case 'new_students':
      return '/students?sort=-created';
    case 'teachers_on_duty':
      return '/teachers';
    case 'trials':
      return oneDay ? `/trials?date=${range.from}` : `/leads/kpis?${span}`;
    case 'attendance_rate':
      return oneDay ? `/today?date=${range.from}` : '/today';
    case 'collected':
      return oneMonth
        ? `/invoices?status=paid&period=${range.from.slice(0, 7)}`
        : '/invoices?status=paid';
    case 'outstanding':
      return '/invoices?status=overdue';
    case 'gross_profit':
    case 'net_profit':
      return `/accounting/reports?report=profit-and-loss&${span}`;
  }
}

/** A USD total as a number, or null when a rate is missing (a gap, never a 0). */
export const usdOf = (m: UsdMoney | null | undefined): number | null =>
  m && m.usd !== null && !m.missingRate ? Number(m.usd) : null;
