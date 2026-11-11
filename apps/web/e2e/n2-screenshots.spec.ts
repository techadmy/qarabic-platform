import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * N2 review screenshots (Arabic, light): Today board, class detail, enrollment detail, new
 * enrollment, requests inbox and the teacher's week, desktop 1440×900 and mobile 375×812.
 * Runs only when N2_SHOTS_DIR is set: `N2_SHOTS_DIR=/path pnpm test:e2e n2-screenshots`.
 */
const dir = process.env.N2_SHOTS_DIR;
test.skip(!dir, 'N2_SHOTS_DIR not set');

const sizes = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 812 },
} as const;

async function shot(page: Page, name: string, size: string) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/${name}-${size}.png` });
}

for (const [size, viewport] of Object.entries(sizes)) {
  test(`N2 screens ${size}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(viewport);
    await page.goto('/login?next=%2Ftoday');
    await login(page);
    await expect(page.getByRole('heading', { level: 1, name: 'حصص اليوم' })).toBeVisible();
    const label = size === 'mobile' ? 'list' : 'table';
    const board = page.getByRole(label, { name: 'حصص اليوم' });
    await expect(board.getByRole('button').first()).toBeVisible();
    await shot(page, 'today-board', size);

    await board.getByRole('button').first().click();
    await expect(
      page.getByRole('dialog', { name: 'تفاصيل الحصة' }).getByText('سجل الحصة'),
    ).toBeVisible();
    await shot(page, 'class-detail', size);
    await page.keyboard.press('Escape');

    await page.goto('/schedule/1');
    await expect(page.getByRole('list', { name: 'المواعيد الأسبوعية' })).toBeVisible();
    await shot(page, 'enrollment-detail', size);

    await page.goto('/schedule/new?studentId=1&teacherId=2');
    await expect(page.getByText('المواعيد بتوقيت العائلة: نيويورك')).toBeVisible();
    await shot(page, 'create-enrollment', size);

    await page.goto('/requests');
    await expect(page.getByRole('list', { name: 'طلبات الحصص' })).toBeVisible();
    await shot(page, 'requests-inbox', size);

    await page.getByRole('button', { name: 'حسابي' }).click();
    await page.getByRole('menuitem', { name: 'تسجيل الخروج' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await login(page, 'teacher@qarabic.test');
    await expect(page.getByRole('heading', { name: 'مرحبًا، معلم تجريبي' })).toBeVisible();
    await page.goto('/my-classes');
    await expect(page.getByRole('heading', { level: 1, name: 'حصصي' })).toBeVisible();
    await expect(page.locator('tr[data-session-id], ul[aria-label] li').first()).toBeVisible();
    await shot(page, 'teacher-week', size);
  });
}
