import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * M8 review screenshots (Arabic, light; tasks in English too): tasks (given, issued), the new-task
 * dialog, a task, announcements (feed, manage, dialog); desktop 1440×900 and mobile 375×812.
 * Runs only when M8_SHOTS_DIR is set: `M8_SHOTS_DIR=/path pnpm test:e2e m8-screenshots`.
 */
const dir = process.env.M8_SHOTS_DIR;
test.skip(!dir, 'M8_SHOTS_DIR not set');

const sizes = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 812 },
} as const;

async function shot(page: Page, name: string, size: string, fullPage = true) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/${name}-${size}.png`, fullPage });
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('main h1').first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

for (const [size, viewport] of Object.entries(sizes)) {
  test(`M8 operations screens ${size}`, async ({ page }) => {
    test.slow();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(viewport);
    await page.goto('/login?next=%2Ftasks');
    await login(page, 'monitor@qarabic.test');
    await expect(page.getByRole('heading', { level: 1, name: 'المهام' })).toBeVisible();
    await shot(page, 'tasks-given', size);
    await open(page, '/tasks?box=issued&status=all');
    await shot(page, 'tasks-issued', size);
    await page.getByRole('button', { name: 'مهمة جديدة' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, 'task-dialog', size, false);
    await page.keyboard.press('Escape');
    await open(page, '/tasks/1');
    await shot(page, 'task', size);
    await open(page, '/announcements');
    await shot(page, 'announcements', size);
    await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
    await open(page, '/tasks');
    await shot(page, 'tasks-en', size);
  });

  test(`M8 announcements management ${size}`, async ({ page }) => {
    test.slow();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(viewport);
    await page.goto('/login?next=%2Fannouncements%3Ftab%3Dmanage');
    await login(page);
    await expect(page.getByRole('heading', { level: 1, name: 'الإعلانات' })).toBeVisible();
    await shot(page, 'announcements-manage', size);
    await open(page, '/');
    await shot(page, 'staff-home', size);
    await open(page, '/account');
    await shot(page, 'account-notifications', size);
    await open(page, '/announcements?tab=manage');
    await page.getByRole('button', { name: 'إعلان جديد' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, 'announcement-dialog', size, false);
  });
}
