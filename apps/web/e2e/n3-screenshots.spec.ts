import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * N3 review screenshots (Arabic, light): report form, report view, reports list, student
 * progress, tests list, test record and the teacher's week, desktop 1440×900 and mobile 375×812.
 * Runs only when N3_SHOTS_DIR is set: `N3_SHOTS_DIR=/path pnpm test:e2e n3-screenshots`.
 */
const dir = process.env.N3_SHOTS_DIR;
test.skip(!dir, 'N3_SHOTS_DIR not set');

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
  test(`N3 screens ${size}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(viewport);
    await page.goto('/login?next=%2Flesson-reports%3Fstate%3Dmissing');
    await login(page);
    await expect(page.getByRole('heading', { level: 1, name: 'تقارير الحصص' })).toBeVisible();
    const list = page.getByRole(size === 'mobile' ? 'list' : 'table', { name: 'تقارير الحصص' });
    await expect(list.getByText('بلا تقرير').first()).toBeVisible();
    await page.goto('/lesson-reports');
    await expect(list.getByText(/سُلّم/).first()).toBeVisible();
    await shot(page, 'reports-list', size);

    // A sent report in the class sheet.
    await page.getByRole('radio', { name: /^سُلّم في موعده/ }).click();
    await expect(page).toHaveURL(/state=on_time/);
    if (size === 'mobile') await list.getByRole('link').first().click();
    else await list.locator('tbody tr').first().getByRole('button').first().click();
    const sheet = page.getByRole('dialog', { name: 'تفاصيل الحصة' });
    await expect(sheet.getByText('ملخص الحصة')).toBeVisible();
    await sheet.getByText('تقرير الحصة', { exact: true }).scrollIntoViewIfNeeded();
    await shot(page, 'report-view', size);

    // The form (staff may write a missing one).
    await page.goto('/lesson-reports?state=missing');
    if (size === 'mobile') await list.getByRole('link').first().click();
    else await list.locator('tbody tr').first().getByRole('button').first().click();
    await sheet.getByRole('button', { name: 'اكتب التقرير' }).click();
    const form = sheet.getByRole('form', { name: 'تقرير الحصة' });
    await form.getByLabel(/ملخص الحصة/).fill('Memorised the new ayahs and revised the last page.');
    const cont = form.getByRole('button', { name: /تابع من آخر موضع/ });
    if (await cont.count()) await cont.first().click();
    await shot(page, 'report-form', size);

    await page.goto('/students/1');
    await expect(page.getByRole('region', { name: /التقدم وسجل الدروس/ })).toBeVisible();
    await page.getByText('آخر موضع').scrollIntoViewIfNeeded();
    await shot(page, 'student-progress', size);

    await page.goto('/tests');
    await expect(page.getByRole('navigation', { name: 'عدادات الشهر' })).toBeVisible();
    await shot(page, 'tests-list', size);
    await page.getByRole('radio', { name: /^مجدول/ }).click();
    await page.locator('a[href^="/tests/"]').first().click();
    await expect(page.getByText('تسجيل النتيجة')).toBeVisible();
    await page.getByLabel('نطق الحروف غير سليم').click();
    await shot(page, 'test-record', size);

    await page.getByRole('button', { name: 'حسابي' }).click();
    await page.getByRole('menuitem', { name: 'تسجيل الخروج' }).click();
    await login(page, 'teacher@qarabic.test');
    await expect(page.getByRole('heading', { name: 'مرحبًا، معلم تجريبي' })).toBeVisible();
    await page.goto('/my-classes');
    await expect(page.getByRole('heading', { level: 1, name: 'حصصي' })).toBeVisible();
    await expect(page.locator('tr[data-session-id], ul[aria-label] li').first()).toBeVisible();
    await shot(page, 'teacher-week', size);
  });
}
