import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * M7 review screenshots (Arabic, light; the journal in English too): journal, new entry, an entry,
 * vouchers with the new-voucher dialog, a voucher, the chart and a statement; desktop 1440×900 and
 * mobile 375×812. Runs only when M7_SHOTS_DIR is set: `M7_SHOTS_DIR=/path pnpm test:e2e m7-screenshots`.
 */
const dir = process.env.M7_SHOTS_DIR;
test.skip(!dir, 'M7_SHOTS_DIR not set');

const sizes = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 812 },
} as const;

async function shot(page: Page, name: string, size: string, fullPage = true) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/${name}-${size}.png`, fullPage });
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('main h1').first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

for (const [size, viewport] of Object.entries(sizes)) {
  test(`M7 accounting screens ${size}`, async ({ page }) => {
    test.slow();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(viewport);
    await page.goto('/login?next=%2Faccounting%2Fjournal');
    await login(page, 'accounts@qarabic.test');
    await expect(page.getByRole('heading', { level: 1, name: 'القيود اليومية' })).toBeVisible();
    await shot(page, 'journal', size);
    await open(page, '/accounting/journal/new');
    await shot(page, 'entry-new', size);
    await open(page, '/accounting/journal/1');
    await shot(page, 'entry', size);
    await open(page, '/accounting/vouchers');
    await shot(page, 'vouchers', size);
    await page.getByRole('button', { name: 'سند صرف' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, 'voucher-dialog', size, false);
    await page.keyboard.press('Escape');
    await open(page, '/accounting/vouchers/1');
    await shot(page, 'voucher', size);
    await open(page, '/accounting/accounts');
    await shot(page, 'accounts', size);
    await open(page, '/accounting/accounts/4');
    await shot(page, 'statement', size);
    await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
    await open(page, '/accounting/journal');
    await shot(page, 'journal-en', size);
  });
}
