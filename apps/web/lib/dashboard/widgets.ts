import { visibleWidgets, type DashboardWidget, type UsdMoney } from '@qarabic/shared';

/**
 * The dashboard's layout over the shared widget list (docs/40 §2.1–2.2): which widgets are KPI
 * cards and which are charts, and the list each KPI opens (docs/40 §2.5). Who may see a widget
 * comes from `visibleWidgets()` in `@qarabic/shared`, the same rule the API applies.
 */
export const KPI_HREF: Partial<Record<DashboardWidget, string>> = {
  active_students: '/students?status=active',
  new_students: '/students?sort=-created',
  teachers_on_duty: '/teachers',
  trials: '/trials',
  attendance_rate: '/today',
  collected: '/invoices?status=paid',
  outstanding: '/invoices?status=overdue',
  gross_profit: '/accounting/reports',
  net_profit: '/accounting/reports',
};

/** D2: the four main charts (the rest come in D3). */
export const MAIN_CHARTS = [
  'revenue_expenses',
  'collections',
  'students_trials',
  'class_outcomes',
] as const satisfies readonly DashboardWidget[];
export type MainChart = (typeof MAIN_CHARTS)[number];

export function dashboardLayout(permissions: readonly string[]) {
  const visible = visibleWidgets(new Set(permissions));
  return {
    kpis: visible.filter((w) => w in KPI_HREF),
    charts: MAIN_CHARTS.filter((w) => visible.includes(w)),
  };
}

/** A USD total as a number, or null when a rate is missing (a gap, never a 0). */
export const usdOf = (m: UsdMoney | null | undefined): number | null =>
  m && m.usd !== null && !m.missingRate ? Number(m.usd) : null;
