import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * N7 review screenshots (Arabic, light; one English page): attendance (summary, a person's days,
 * mark-day dialog, leave queue), fines with the add dialog, the runs list and the new-run preview,
 * a run, a payslip with the payment dialog, salary profiles with the profile dialog, wallets, pay
 * rules, and the teacher's attendance, salary and payslip; desktop 1440×900 and mobile 375×812.
 * Runs only when N7_SHOTS_DIR is set: `N7_SHOTS_DIR=/path pnpm test:e2e n7-screenshots`.
 */
const dir = process.env.N7_SHOTS_DIR;
test.skip(!dir, 'N7_SHOTS_DIR not set');

const sizes = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 812 },
} as const;

async function shot(page: Page, name: string, size: string, fullPage = false) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/${name}-${size}.png`, fullPage });
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('#main h1').first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

for (const [size, viewport] of Object.entries(sizes)) {
  test(`N7 staff screens ${size}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(viewport);
    await page.goto('/login?next=%2Fattendance');
    await login(page);
    await expect(page.getByRole('heading', { level: 1, name: 'الحضور والإجازات' })).toBeVisible();
    await shot(page, 'attendance-summary', size, true);

    await open(page, '/attendance?user=102');
    await shot(page, 'attendance-person', size, true);
    await page
      .getByRole('button', { name: /^تسجيل يوم .* لـ Ahmed Fathy/ })
      .first()
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, 'mark-day-dialog', size);
    await page.keyboard.press('Escape');

    await open(page, '/attendance?tab=leave');
    await shot(page, 'leave-queue', size, true);

    await open(page, '/fines');
    await shot(page, 'fines', size, true);
    await page.getByRole('button', { name: 'أضف بندًا' }).click();
    await expect(page.getByRole('dialog', { name: 'بند جديد على الراتب' })).toBeVisible();
    await shot(page, 'adjustment-dialog', size);
    await page.keyboard.press('Escape');

    await open(page, '/payroll');
    await shot(page, 'runs', size, true);
    await page.getByRole('button', { name: 'أنشئ مسيّر الشهر' }).click();
    const create = page.getByRole('dialog', { name: 'مسيّر رواتب جديد' });
    await create.getByRole('button', { name: 'معاينة' }).click();
    await expect(create.getByRole('table', { name: 'معاينة القسائم' })).toBeVisible();
    await shot(page, 'new-run-preview', size);
    await create.getByRole('button', { name: 'أنشئ المسيّر' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /مسيّر رواتب/ })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await shot(page, 'run-draft', size, true);
    await page.getByRole('button', { name: 'اعتمد المراجعة' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'اعتمد المراجعة' }).click();
    await page.getByRole('button', { name: 'اعتمد المسيّر' }).click();
    await expect(page.getByRole('dialog', { name: 'اعتماد مسيّر الرواتب' })).toBeVisible();
    await shot(page, 'approve-dialog', size);
    await page.keyboard.press('Escape');

    await open(page, '/payroll/runs/2');
    await shot(page, 'run-approved', size, true);
    await open(page, '/payroll/payslips/11');
    await shot(page, 'payslip', size, true);
    await page.getByRole('button', { name: 'سجّل الصرف' }).click();
    await expect(page.getByRole('dialog', { name: 'تسجيل صرف الراتب' })).toBeVisible();
    await shot(page, 'payment-dialog', size);
    await page.keyboard.press('Escape');

    await open(page, '/payroll/profiles');
    await shot(page, 'profiles', size, true);
    await page.getByRole('button', { name: 'تعديل ملف Mostafa Kamal' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await shot(page, 'profile-dialog', size);
    await page.keyboard.press('Escape');

    await open(page, '/payroll/wallets');
    await shot(page, 'wallets', size, true);
    await open(page, '/settings/pay-rules');
    await shot(page, 'pay-rules', size, true);

    await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await open(page, '/payroll/payslips/11');
    await shot(page, 'payslip-en', size, true);
    await page
      .locator('header')
      .getByRole('button', { name: /العربية|Arabic/ })
      .click();
  });

  test(`N7 teacher screens ${size}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(viewport);
    await page.goto('/login?next=%2Fattendance');
    await login(page, 'teacher@qarabic.test');
    await expect(page.getByRole('heading', { level: 1, name: 'حضوري وإجازاتي' })).toBeVisible();
    await shot(page, 'my-attendance', size, true);
    await page.getByRole('button', { name: 'طلب إجازة' }).click();
    await expect(page.getByRole('dialog', { name: 'طلب إجازة' })).toBeVisible();
    await shot(page, 'leave-dialog', size);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'تسجيل الحضور' }).click();
    await expect(page.getByText(/سُجّل الحضور الساعة/)).toBeVisible();
    await shot(page, 'my-attendance-checked-in', size);

    await open(page, '/payroll');
    await shot(page, 'my-salary', size, true);
    await page.getByRole('list', { name: 'قسائم الراتب' }).getByRole('link').first().click();
    await expect(page.getByRole('heading', { level: 1, name: /قسيمة الراتب/ })).toBeVisible();
    await shot(page, 'my-payslip', size, true);
  });
}
