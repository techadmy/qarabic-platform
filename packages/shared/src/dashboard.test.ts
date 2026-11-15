import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_WIDGET_PERMISSIONS,
  DASHBOARD_WIDGETS,
  dashboardMetricsSchema,
  dashboardQuerySchema,
  deleteExchangeRateSchema,
  upsertExchangeRateSchema,
  visibleWidgets,
} from './dashboard.js';
import {
  allPermissions,
  OWNER_ONLY_PERMISSIONS,
  permissionsFor,
  ROLES,
  type Role,
} from './permissions.js';
import { permissionListSchema } from './roles.js';

const widgetsOf = (role: Role) => visibleWidgets(new Set<string>(permissionsFor(role)));

describe('dashboard widgets by role (B121)', () => {
  it('the owner sees every widget', () => {
    expect(visibleWidgets(new Set<string>(allPermissions()))).toEqual([...DASHBOARD_WIDGETS]);
  });

  it('a manager sees operations and leads, no money', () => {
    const w = widgetsOf('manager');
    expect(w).toEqual(
      expect.arrayContaining(['active_students', 'attendance_rate', 'trials', 'leads_by_source']),
    );
    for (const money of ['collected', 'outstanding', 'gross_profit', 'net_profit', 'collections'])
      expect(w).not.toContain(money);
  });

  it('a monitor sees operations only', () => {
    expect(widgetsOf('monitor')).toEqual([
      'active_students',
      'new_students',
      'teachers_on_duty',
      'attendance_rate',
      'class_outcomes',
    ]);
  });

  it('billing sees collections, outstanding and the collection rate, not profit or operations', () => {
    expect(widgetsOf('billing')).toEqual([
      'collected',
      'outstanding',
      'collection_rate',
      'collections',
    ]);
  });

  it('accounts sees collections only: no expenses, teacher pay or profit (D146)', () => {
    expect(widgetsOf('accounts')).toEqual([
      'collected',
      'outstanding',
      'collection_rate',
      'collections',
    ]);
  });

  it('no preset other than the owner keeps the ledger (D146)', () => {
    for (const role of ['senior_manager', 'manager', 'billing', 'accounts'] as const) {
      expect(permissionsFor(role)).not.toContain('accounting.view');
      expect(permissionsFor(role)).not.toContain('accounting.manage');
    }
    expect(permissionsFor('accounts')).toContain('accounting.rates');
  });

  it('profit and loss is the owner’s only: no preset role has it', () => {
    for (const role of ['senior_manager', 'manager', 'accounts', 'billing'] as const) {
      const w = widgetsOf(role);
      for (const pl of ['gross_profit', 'net_profit', 'revenue_expenses', 'teacher_hours'])
        expect(w).not.toContain(pl);
    }
  });

  it('teachers and parents see nothing', () => {
    expect(widgetsOf('teacher')).toEqual([]);
    expect(widgetsOf('parent')).toEqual([]);
  });

  it('every widget lists only real permissions', () => {
    const all = new Set<string>(allPermissions());
    for (const perms of Object.values(DASHBOARD_WIDGET_PERMISSIONS))
      for (const p of perms) expect(all.has(p)).toBe(true);
  });
});

describe('dashboardQuerySchema', () => {
  it('defaults compare to prev and leaves the range to the server', () => {
    expect(dashboardQuerySchema.parse({})).toEqual({ compare: 'prev' });
  });

  it('needs both ends, in order, at most two years', () => {
    expect(dashboardQuerySchema.safeParse({ from: '2026-11-01' }).success).toBe(false);
    expect(dashboardQuerySchema.safeParse({ from: '2026-11-30', to: '2026-11-01' }).success).toBe(
      false,
    );
    expect(dashboardQuerySchema.safeParse({ from: '2024-01-01', to: '2026-11-30' }).success).toBe(
      false,
    );
    expect(
      dashboardQuerySchema.parse({ from: '2026-01-01', to: '2026-11-30', bucket: 'month' }),
    ).toMatchObject({ bucket: 'month' });
  });
});

describe('exchange rates', () => {
  it('accepts a positive rate for a non-USD currency and month', () => {
    expect(
      upsertExchangeRateSchema.parse({ currency: 'gbp', month: '2026-11', rateToUsd: '1.2712' }),
    ).toMatchObject({ currency: 'GBP', rateToUsd: '1.2712' });
  });

  it('refuses USD, zero, bad months and too many decimals', () => {
    const bad = [
      { currency: 'USD', month: '2026-11', rateToUsd: '1' },
      { currency: 'GBP', month: '2026-11', rateToUsd: '0' },
      { currency: 'GBP', month: '2026-13', rateToUsd: '1.2' },
      { currency: 'GBP', month: '2026-11', rateToUsd: '1.123456789' },
      { currency: 'XYZ', month: '2026-11', rateToUsd: '1.2' },
    ];
    for (const b of bad) expect(upsertExchangeRateSchema.safeParse(b).success).toBe(false);
  });

  it('needs a reason to delete', () => {
    expect(deleteExchangeRateSchema.safeParse({ reason: '' }).success).toBe(false);
  });
});

describe('dashboardMetricsSchema', () => {
  it('parses a response with only the widgets a role may see', () => {
    const money = (usd: string | null) => ({
      usd,
      missingRate: usd === null,
      byCurrency: [
        { currency: 'GBP', amount: '100.00', usd, missingMonths: usd ? [] : ['2026-11'] },
      ],
    });
    const parsed = dashboardMetricsSchema.parse({
      range: {
        from: '2026-11-01',
        to: '2026-11-30',
        bucket: 'day',
        previous: { from: '2026-10-02', to: '2026-10-31' },
        timezone: 'Africa/Cairo',
      },
      currency: 'USD',
      widgets: ['collected', 'outstanding', 'collections'],
      kpis: {
        collected: { value: money('127.12'), previous: money(null) },
        outstanding: {
          value: { total: money('127.12'), overdue: money('0.00') },
          previous: null,
        },
      },
      series: {
        collections: {
          points: [{ bucket: '2026-11-01', collected: money('127.12'), invoiced: money(null) }],
          ageing: {
            d0_30: money('0.00'),
            d31_60: money('0.00'),
            d61_90: money('0.00'),
            d90_plus: money('0.00'),
          },
        },
      },
      missingRates: [{ currency: 'GBP', month: '2026-10' }],
      generatedAt: '2026-11-15T10:00:00.000Z',
    });
    expect(parsed.kpis.gross_profit).toBeUndefined();
    expect(parsed.kpis.collected?.previous?.usd).toBeNull();
  });
});

describe('owner-only permissions (D145)', () => {
  it('no role preset holds reports.profit, and no role can be given it', () => {
    for (const role of ROLES.filter((r) => r !== 'admin'))
      for (const p of OWNER_ONLY_PERMISSIONS) expect(permissionsFor(role)).not.toContain(p);
    expect(permissionsFor('admin')).toContain('reports.profit');
    expect(permissionListSchema.safeParse(['reports.profit']).success).toBe(false);
    expect(permissionListSchema.safeParse(['reports.financial']).success).toBe(true);
  });
});
