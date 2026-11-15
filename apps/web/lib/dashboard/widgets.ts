/**
 * The dashboard's widgets and the permission each needs (docs/40 §2.1–2.2). The page shows a
 * widget only to someone who may open its module; the API applies the same rule (a hidden widget's
 * data comes back `null`), so hiding it here is never the only protection.
 */
export const KPI_WIDGETS = [
  { key: 'activeStudents', permission: 'sessions.view', href: '/students?status=active' },
  { key: 'newStudents', permission: 'sessions.view', href: '/students?sort=-created' },
  { key: 'teachersOnDuty', permission: 'sessions.view', href: '/teachers' },
  { key: 'trials', permission: 'leads.view', href: '/trials' },
  { key: 'collected', permission: 'invoices.view', href: '/invoices?status=paid' },
  { key: 'outstanding', permission: 'invoices.view', href: '/invoices?status=overdue' },
  { key: 'grossProfit', permission: 'reports.financial', href: '/accounting/reports' },
  { key: 'attendanceRate', permission: 'sessions.view', href: '/today' },
] as const;
export type KpiKey = (typeof KPI_WIDGETS)[number]['key'];

export const CHART_WIDGETS = [
  { key: 'finance', permission: 'reports.financial' },
  { key: 'collections', permission: 'invoices.view' },
  { key: 'growth', permission: 'leads.view' },
  { key: 'outcomes', permission: 'sessions.view' },
] as const;
export type ChartKey = (typeof CHART_WIDGETS)[number]['key'];

export const visibleWidgets = <T extends { permission: string }>(
  widgets: readonly T[],
  permissions: readonly string[],
) => widgets.filter((w) => permissions.includes(w.permission));
