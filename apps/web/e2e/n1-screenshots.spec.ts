import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * N1 review screenshots (Arabic, light): families list, family profile, edit sheet, status
 * dialog, roles matrix and account page, desktop 1440×900 and mobile 375×812.
 * Runs only when N1_SHOTS_DIR is set: `N1_SHOTS_DIR=/path pnpm test:e2e n1-screenshots`.
 */
const dir = process.env.N1_SHOTS_DIR;
test.skip(!dir, 'N1_SHOTS_DIR not set');

const sizes = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 812 },
} as const;

async function shot(page: Page, name: string, size: string) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/${name}-${size}.png` });
}

for (const [size, viewport] of Object.entries(sizes)) {
  test(`N1 screens ${size}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(viewport);
    await page.goto('/login?next=%2Ffamilies');
    await login(page);
    await expect(page.getByRole('heading', { level: 1, name: 'العائلات' })).toBeVisible();
    await shot(page, 'families-list', size);

    await page.goto('/families/1');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('ولي أمر تجريبي');
    await shot(page, 'family-profile', size);

    await page.getByRole('button', { name: 'تعديل', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel(/اسم ولي الأمر/)).toBeVisible();
    await shot(page, 'edit-sheet', size);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'تغيير الحالة' }).click();
    await page.getByRole('dialog').getByRole('radio', { name: 'معلّقة' }).click();
    await shot(page, 'status-dialog', size);
    await page.keyboard.press('Escape');

    await page.goto('/roles/4');
    await expect(page.getByRole('group', { name: 'العائلات والطلاب' })).toBeVisible();
    // Show the matrix itself: scroll its first group to the top of the page.
    await page
      .locator('[data-slot="card-title"]', { hasText: /^الصلاحيات$/ })
      .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shot(page, 'roles-matrix', size);

    await page.goto('/account');
    await expect(page.getByRole('heading', { level: 1, name: 'حسابي' })).toBeVisible();
    await shot(page, 'account', size);
  });
}
