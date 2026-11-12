import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * N6 review screenshots (Arabic, light): the invoices list, an invoice (open, split, draft), the
 * monthly run with its preview, record payment and split, fee packages, the family's billing
 * sections, billing settings, and the parent's invoices, pay dialog, paid return and receipt;
 * desktop 1440×900 and mobile 375×812 (long pages full height). Runs only when N6_SHOTS_DIR is
 * set: `N6_SHOTS_DIR=/path pnpm test:e2e n6-screenshots`.
 */
const dir = process.env.N6_SHOTS_DIR;
test.skip(!dir, 'N6_SHOTS_DIR not set');

const sizes = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 812 },
} as const;

async function shot(page: Page, name: string, size: string, fullPage = false) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/${name}-${size}.png`, fullPage });
}

for (const [size, viewport] of Object.entries(sizes)) {
  test(`N6 staff screens ${size}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(viewport);
    await page.goto('/login?next=%2Finvoices');
    await login(page);
    await expect(page.getByRole('heading', { level: 1, name: 'الفواتير' })).toBeVisible();
    await shot(page, 'invoices-list', size, true);

    await page.getByRole('button', { name: 'إصدار فواتير الشهر' }).click();
    const run = page.getByRole('dialog', { name: 'إصدار الفواتير الشهرية' });
    await run.getByRole('button', { name: 'معاينة' }).click();
    await expect(run.getByRole('status')).toBeVisible();
    await shot(page, 'invoice-run-preview', size);
    await page.keyboard.press('Escape');

    await page.goto('/invoices/4');
    await expect(page.locator('#main h1').first()).toBeVisible();
    await shot(page, 'invoice-partially-paid', size, true);
    await page.getByRole('button', { name: 'تسجيل دفعة' }).click();
    await expect(page.getByRole('dialog', { name: /تسجيل دفعة/ })).toBeVisible();
    await shot(page, 'record-payment', size);
    await page.keyboard.press('Escape');

    await page.goto('/invoices/11');
    await expect(page.locator('#main h1').first()).toBeVisible();
    await shot(page, 'invoice-discount', size, true);
    await page.getByRole('button', { name: 'إجراءات أخرى' }).click();
    await page.getByRole('menuitem', { name: 'تقسيم الفاتورة' }).click();
    await expect(page.getByRole('dialog', { name: /تقسيم الفاتورة/ })).toBeVisible();
    await shot(page, 'split-dialog', size);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'إجراءات أخرى' }).click();
    await page.getByRole('menuitem', { name: 'إضافة خصم' }).click();
    await expect(page.getByRole('dialog', { name: 'إضافة خصم' })).toBeVisible();
    await shot(page, 'discount-dialog', size);
    await page.keyboard.press('Escape');

    await page.goto('/invoices/7');
    await expect(page.locator('#main h1').first()).toBeVisible();
    await shot(page, 'invoice-split', size);

    await page.goto('/invoices/5');
    await expect(page.locator('#main h1').first()).toBeVisible();
    await shot(page, 'invoice-draft', size);

    await page.goto('/invoices/6');
    await expect(page.locator('#main h1').first()).toBeVisible();
    await shot(page, 'invoice-void', size);

    await page.goto('/packages');
    await expect(page.locator('#main h1').first()).toBeVisible();
    await shot(page, 'packages', size, true);
    await page
      .getByRole('button', { name: /^تعديل/ })
      .first()
      .click();
    await expect(page.getByRole('dialog', { name: 'تعديل الباقة' })).toBeVisible();
    await shot(page, 'package-dialog', size);
    await page.keyboard.press('Escape');

    await page.goto('/families/1');
    await expect(page.getByRole('heading', { name: 'الفوترة' })).toBeVisible();
    await page.getByRole('heading', { name: 'الفوترة' }).scrollIntoViewIfNeeded();
    await shot(page, 'family-billing', size, true);

    await page.goto('/families/4');
    await expect(page.getByRole('heading', { name: 'الفوترة' })).toBeVisible();
    await page.getByRole('heading', { name: 'الفوترة' }).scrollIntoViewIfNeeded();
    await shot(page, 'family-billing-warnings', size);

    await page.goto('/settings/billing');
    await expect(page.locator('#main h1').first()).toBeVisible();
    await shot(page, 'billing-settings', size, true);

    await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.goto('/invoices/4');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('#main h1').first()).toBeVisible();
    await shot(page, 'invoice-en', size, true);
    await page
      .locator('header')
      .getByRole('button', { name: /العربية|Arabic/ })
      .click();
  });

  test(`N6 parent screens ${size}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(viewport);
    await page.goto('/login?next=%2Finvoices');
    await login(page, 'parent@qarabic.test');
    await expect(page.getByRole('heading', { level: 1, name: 'فواتيري' })).toBeVisible();
    await shot(page, 'parent-invoices', size, true);

    await page.getByRole('link', { name: /^ادفع الآن/ }).click();
    await expect(page.getByRole('dialog', { name: 'اختر طريقة الدفع' })).toBeVisible();
    await shot(page, 'parent-pay-dialog', size);
    await page.keyboard.press('Escape');
    await shot(page, 'parent-invoice', size, true);

    await page.goto('/invoices/1?checkout=cancelled');
    await expect(page.getByText('أُلغيت عملية الدفع')).toBeVisible();
    await shot(page, 'parent-checkout-cancelled', size);

    await page.getByRole('button', { name: 'ادفع الآن' }).click();
    await page
      .getByRole('dialog', { name: 'اختر طريقة الدفع' })
      .getByRole('button', { name: 'بطاقة ائتمان أو خصم مباشر' })
      .click();
    await expect(page.getByText('تم الدفع بنجاح')).toBeVisible();
    await shot(page, 'parent-paid', size);

    await page
      .getByRole('link', { name: /الإيصال/ })
      .last()
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'إيصال دفع' })).toBeVisible();
    await shot(page, 'receipt', size);
  });
}
