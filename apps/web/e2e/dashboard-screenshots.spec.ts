import { expect, test } from '@playwright/test';
import { login } from './helpers';

/**
 * D2 review screenshots: the staff home's dashboard (range bar, KPI cards with compare, the four
 * charts) — Arabic at 375×812 and 1440×900, English at 1440 and 768. Runs only with DASH_SHOTS_DIR.
 */
const dir = process.env.DASH_SHOTS_DIR;
test.skip(!dir, 'DASH_SHOTS_DIR not set');

const RUNS = [
  { name: 'mobile-ar', width: 375, height: 812, en: false },
  { name: 'tablet-en', width: 768, height: 1024, en: true },
  { name: 'desktop-ar', width: 1440, height: 900, en: false },
  { name: 'desktop-en', width: 1440, height: 900, en: true },
] as const;

for (const run of RUNS) {
  test(`dashboard (${run.name})`, async ({ page }) => {
    await page.setViewportSize({ width: run.width, height: run.height });
    await page.goto('/login?next=%2F%3Frange%3Dlast_12_months%26compare%3D1');
    await login(page);
    await page.waitForURL((u) => u.pathname === '/');
    if (run.en) {
      await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    }
    await expect(page.locator('.recharts-surface').first()).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${dir}/dashboard-${run.name}.png`, fullPage: true });
  });
}
