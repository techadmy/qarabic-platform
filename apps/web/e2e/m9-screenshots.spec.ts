import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * M9 review screenshots (Arabic, light; the teacher home in English too): the teacher's «يومي»
 * with a day opened, and the parent home; desktop 1440×900 and mobile 375×812.
 * Runs only when M9_SHOTS_DIR is set: `M9_SHOTS_DIR=/path pnpm test:e2e m9-screenshots`.
 */
const dir = process.env.M9_SHOTS_DIR;
test.skip(!dir, 'M9_SHOTS_DIR not set');

const sizes = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 812 },
} as const;

async function shot(page: Page, name: string, size: string) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/${name}-${size}.png`, fullPage: true });
}

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await login(page, email);
  await expect(page.locator('main h1').first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

for (const [size, viewport] of Object.entries(sizes)) {
  test(`M9 teacher home ${size}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(viewport);
    await signIn(page, 'teacher@qarabic.test');
    await page
      .getByRole('region', { name: 'الأيام الخمسة القادمة' })
      .getByRole('button', { disabled: false })
      .first()
      .click();
    await shot(page, 'teacher-home', size);
    await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await shot(page, 'teacher-home-en', size);
  });

  test(`M9 parent home ${size}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(viewport);
    await signIn(page, 'parent@qarabic.test');
    await shot(page, 'parent-home', size);
  });
}
