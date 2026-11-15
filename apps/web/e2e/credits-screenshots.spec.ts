import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * P1-1 review screenshots: the family credits list (needs review) and its «تمت المراجعة» dialog,
 * an invoice with a payment kept as credit, and the family's billing tab with its open credit —
 * Arabic at 375×812 and 1440×900, English at 1440. Runs only when CREDITS_SHOTS_DIR is set.
 */
const dir = process.env.CREDITS_SHOTS_DIR;
test.skip(!dir, 'CREDITS_SHOTS_DIR not set');

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
  test(`credits screens (${run.name})`, async ({ page }) => {
    await page.setViewportSize({ width: run.width, height: run.height });
    await page.goto('/login?next=%2Fbilling%2Fcredits');
    await login(page);
    await page.waitForURL((u) => u.pathname === '/billing/credits');
    if (run.en) {
      await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
      await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    }
    await expect(page.locator('main h1')).toBeVisible();
    await shot(page, `credits-list-${run.name}`);
    await page
      .getByRole('button', { name: run.en ? /^Mark reviewed/ : /^تمت المراجعة/ })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, `credits-review-dialog-${run.name}`, false);
    await page.keyboard.press('Escape');
    // The source invoice of the credit, then the family's billing tab.
    const source = page.locator('main a[href^="/invoices/"]').first();
    const invoice = await source.getAttribute('href');
    const family = await page.locator('main a[href^="/families/"]').first().getAttribute('href');
    await page.goto(invoice!);
    await expect(
      page.getByText(run.en ? /kept as the family/ : /أُضيفت إلى رصيد الأسرة الدائن/).first(),
    ).toBeVisible();
    await shot(page, `credits-invoice-${run.name}`);
    await page.goto(family!);
    await page
      .getByRole('tab', { name: run.en ? /Billing/ : /الفواتير|الحسابات|الفوترة/ })
      .first()
      .click();
    await expect(page.getByText(run.en ? 'Credit' : 'رصيد دائن').first()).toBeVisible();
    await shot(page, `credits-family-${run.name}`);
  });
}
