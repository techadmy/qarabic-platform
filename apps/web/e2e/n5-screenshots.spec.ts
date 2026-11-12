import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * N5 review screenshots (Arabic, light): leads list, a new lead, book trial, a booked lead, the
 * convert dialog, CRM settings, the public trial form and the parent referral card, desktop
 * 1440×900 and mobile 375×812. Runs only when N5_SHOTS_DIR is set:
 * `N5_SHOTS_DIR=/path pnpm test:e2e n5-screenshots`.
 */
const dir = process.env.N5_SHOTS_DIR;
test.skip(!dir, 'N5_SHOTS_DIR not set');

const sizes = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 812 },
} as const;

async function shot(page: Page, name: string, size: string) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/${name}-${size}.png` });
}

for (const [size, viewport] of Object.entries(sizes)) {
  test(`N5 screens ${size}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(viewport);
    await page.goto('/trial');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await shot(page, 'public-trial-form', size);

    await page.goto('/login?next=%2Fleads');
    await login(page);
    await expect(page.getByRole('heading', { level: 1, name: 'العملاء المحتملون' })).toBeVisible();
    await shot(page, 'leads-list', size);

    await page.goto('/leads/1');
    await expect(page.getByRole('heading', { level: 1, name: 'Amina Rahman' })).toBeVisible();
    await shot(page, 'lead-new', size);

    await page.goto('/leads/4');
    await expect(page.locator('#main h1').first()).toBeVisible();
    await page.getByRole('button', { name: 'احجز حصة تجريبية' }).first().click();
    await expect(page.getByRole('dialog', { name: 'حجز حصة تجريبية' })).toBeVisible();
    await shot(page, 'book-trial-account', size);
    await page.keyboard.press('Escape');

    await page.goto('/leads/7');
    await expect(page.locator('#main h1').first()).toBeVisible();
    await shot(page, 'lead-trial-done', size);
    await page.getByRole('button', { name: 'حوّل إلى منتظم' }).first().click();
    await expect(page.getByRole('dialog', { name: 'التحويل إلى منتظم' })).toBeVisible();
    await shot(page, 'convert', size);
    await page.keyboard.press('Escape');

    await page.goto('/settings/crm');
    await expect(page.locator('#main h1').first()).toBeVisible();
    await shot(page, 'crm-settings', size);

    await page.getByRole('button', { name: 'حسابي' }).click();
    await page.getByRole('menuitem', { name: 'تسجيل الخروج' }).click();
    await login(page, 'parent@qarabic.test');
    const card = page.getByRole('region', { name: 'رشّح صديقًا' });
    await card.scrollIntoViewIfNeeded();
    await card.getByRole('button', { name: 'رشّح صديقًا' }).click();
    await expect(page.getByRole('dialog', { name: 'ترشيح صديق' })).toBeVisible();
    await shot(page, 'parent-referral', size);
  });
}
