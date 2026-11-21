import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * D155 review screenshots: the teacher home with the month tiles (hours, expected pay), the
 * «تبدأ بعد» column and the two-column layout at 1440, stacked at 768 and 375; Arabic and English.
 * Runs only when D155_SHOTS_DIR is set: `D155_SHOTS_DIR=/path pnpm test:e2e d155-screenshots`.
 */
const dir = process.env.D155_SHOTS_DIR;
test.skip(!dir, 'D155_SHOTS_DIR not set');

const sizes = { desktop: 1440, tablet: 768, mobile: 375 } as const;

async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

for (const [size, width] of Object.entries(sizes)) {
  test(`D155 teacher home ${size}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/login');
    await login(page, 'teacher@qarabic.test');
    await expect(page).not.toHaveURL(/\/login/);
    await page.goto('/');
    await expect(page.getByText('ساعاتي هذا الشهر')).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await shot(page, `teacher-home-ar-${size}`);
    await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.goto('/');
    await expect(page.getByText('My hours this month')).toBeVisible();
    await shot(page, `teacher-home-en-${size}`);
  });
}
