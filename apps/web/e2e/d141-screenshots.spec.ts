import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * D141 rollout screenshots (before / after per list): each list at 1440×900 and 375×812, and the
 * split view where the list has one (1440 only). Run on main for «before» and on the branch for
 * «after»: `D141_SHOTS_DIR=/path D141_LISTS=families,students pnpm test:e2e d141-screenshots`.
 */
const dir = process.env.D141_SHOTS_DIR;
test.skip(!dir, 'D141_SHOTS_DIR not set');

/** list path → record id opened in the split view (or null). */
const LISTS: Record<string, { path: string; open: number | null }> = {
  families: { path: '/families', open: 2 },
  students: { path: '/students', open: 1 },
  teachers: { path: '/teachers', open: 1 },
  staff: { path: '/staff', open: 12 },
  requests: { path: '/requests', open: null },
  support: { path: '/support', open: 1 },
  schedule: { path: '/schedule', open: 1 },
  invoices: { path: '/invoices', open: 1 },
  packages: { path: '/packages', open: null },
  payroll: { path: '/payroll', open: 1 },
  fines: { path: '/fines', open: null },
  leave: { path: '/attendance?tab=leave', open: null },
};
const only = (process.env.D141_LISTS ?? '').split(',').filter(Boolean);
const names = only.length ? only : Object.keys(LISTS);

async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: false });
}

for (const size of ['desktop', 'mobile'] as const) {
  test(`D141 lists ${size}`, async ({ page }) => {
    test.slow();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(
      size === 'desktop' ? { width: 1440, height: 900 } : { width: 375, height: 812 },
    );
    await page.goto('/login?next=%2Ffamilies');
    await login(page);
    await page.waitForURL((u) => !u.pathname.endsWith('/login'));
    await expect(page.locator('main h1').first()).toBeVisible();
    for (const name of names) {
      const l = LISTS[name]!;
      await page.goto(l.path);
      await expect(page.locator('main h1').first()).toBeVisible();
      await shot(page, `${name}-${size}`);
      if (size === 'desktop' && l.open) {
        const sep = l.path.includes('?') ? '&' : '?';
        await page.goto(`${l.path}${sep}id=${l.open}`);
        await expect(page.locator('main h1').first()).toBeVisible();
        await shot(page, `${name}-split-${size}`);
      }
    }
  });
}
