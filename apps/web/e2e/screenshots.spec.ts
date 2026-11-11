import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * Review screenshots for the PR (docs/34 §3.4: desktop + mobile, light + dark).
 * Runs only when SHOTS_DIR is set: `SHOTS_DIR=/path pnpm test:e2e screenshots`.
 */
const dir = process.env.SHOTS_DIR;
test.skip(!dir, 'SHOTS_DIR not set');

const sizes = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 812 },
} as const;

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/${name}.png` });
}

for (const scheme of ['light', 'dark'] as const) {
  for (const [size, viewport] of Object.entries(sizes)) {
    test(`${size} ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(viewport);
      await page.goto('/login');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await shot(page, `login-${size}-${scheme}`);
      await login(page);
      await expect(page.getByRole('heading', { name: 'مرحبًا، مدير النظام' })).toBeVisible();
      await shot(page, `home-${size}-${scheme}`);
      await page.goto('/roles');
      await expect(page.getByRole('table', { name: 'الأدوار' })).toBeVisible();
      await shot(page, `roles-${size}-${scheme}`);
      if (size === 'mobile') {
        await page.getByRole('button', { name: 'إظهار القائمة الجانبية أو إخفاؤها' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await shot(page, `sidebar-${size}-${scheme}`);
      } else {
        await page.getByRole('button', { name: 'حسابي' }).click();
        await expect(page.getByRole('menu')).toBeVisible();
        await shot(page, `user-menu-${size}-${scheme}`);
      }
    });
  }
}
