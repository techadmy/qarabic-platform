import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * S4 review screenshots: the support inbox with its «الآن» tiles and «تقرير تواصل معنا», in
 * Arabic and English, desktop 1440×900 and mobile 375×812 (8 shots).
 * Runs only when S4_SHOTS_DIR is set: `S4_SHOTS_DIR=/path pnpm test:e2e s4-screenshots`.
 */
const dir = process.env.S4_SHOTS_DIR;
test.skip(!dir, 'S4_SHOTS_DIR not set');

const sizes = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 812 },
} as const;

async function shot(page: Page, name: string) {
  await expect(page.locator('main h1').first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

for (const [size, viewport] of Object.entries(sizes)) {
  for (const lang of ['ar', 'en'] as const) {
    test(`S4 inbox tiles and report (${size}, ${lang})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/login?next=${encodeURIComponent('/support')}`);
      await login(page, 'admin@qarabic.test');
      await page.waitForURL((u) => u.pathname === '/support');
      if (lang === 'en') {
        await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
        await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      }
      await expect(
        page.getByRole('navigation', { name: lang === 'ar' ? 'الآن' : 'Now' }),
      ).toBeVisible();
      await shot(page, `s4-inbox-tiles-${size}-${lang}`);
      await page.goto('/support/reports');
      await expect(page.getByRole('table').first()).toBeVisible();
      await shot(page, `s4-support-report-${size}-${lang}`);
    });
  }
}
