import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * P1-3 review screenshots: «مدفوعات تحتاج مراجعة» with a held capture in another currency and an
 * overpayment, and the «تمت المراجعة» dialog — Arabic at 375×812 and 1440×900, English at 1440.
 * Runs only when PAYREV_SHOTS_DIR is set.
 */
const dir = process.env.PAYREV_SHOTS_DIR;
test.skip(!dir, 'PAYREV_SHOTS_DIR not set');

const RUNS = [
  { name: 'mobile-ar', width: 375, height: 812, en: false },
  { name: 'desktop-ar', width: 1440, height: 900, en: false },
  { name: 'desktop-en', width: 1440, height: 900, en: true },
] as const;

async function shot(page: Page, name: string, full = true) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: full });
}

for (const run of RUNS) {
  test(`payments review (${run.name})`, async ({ page }) => {
    await page.setViewportSize({ width: run.width, height: run.height });
    await page.goto('/login?next=%2Fbilling%2Fpayments-review');
    await login(page);
    await page.waitForURL((u) => u.pathname === '/billing/payments-review');
    if (run.en) {
      await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    }
    await expect(page.locator('main h1')).toBeVisible();
    await expect(
      page.getByRole('button', { name: run.en ? /^Mark reviewed/ : /^تمت المراجعة/ }).first(),
    ).toBeVisible();
    await shot(page, `payrev-list-${run.name}`);
    await page
      .getByRole('button', { name: run.en ? /^Mark reviewed/ : /^تمت المراجعة/ })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, `payrev-dialog-${run.name}`, false);
  });
}
