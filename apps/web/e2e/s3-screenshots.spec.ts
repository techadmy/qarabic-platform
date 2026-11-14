import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * S3 review screenshots (Arabic): the parent's teacher-change form, and the staff ticket with its
 * request card; desktop 1440×900 and mobile 375×812.
 * Runs only when S3_SHOTS_DIR is set: `S3_SHOTS_DIR=/path pnpm test:e2e s3-screenshots`.
 */
const dir = process.env.S3_SHOTS_DIR;
test.skip(!dir, 'S3_SHOTS_DIR not set');

const sizes = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 812 },
} as const;

async function shot(page: Page, name: string, size: string) {
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/${name}-${size}.png`, fullPage: true });
}

for (const [size, viewport] of Object.entries(sizes)) {
  test(`S3 request form and card (${size})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/login');
    await login(page, 'parent@qarabic.test');
    await page
      .getByRole('button', { name: 'تواصل معنا' })
      .filter({ visible: true })
      .first()
      .click();
    const hub = page.getByRole('dialog', { name: 'تواصل معنا' });
    await hub.getByRole('button', { name: /^المعلم والمستوى الدراسي/ }).click();
    await page.getByRole('button', { name: /^طلب تغيير المعلم/ }).click();
    const form = page.getByRole('dialog', { name: 'طلب تغيير المعلم' });
    await form.getByRole('combobox', { name: 'سبب طلب تغيير المعلم' }).click();
    await page.getByRole('option', { name: 'اللغة' }).click();
    await form.getByRole('textbox').last().fill('We would like a teacher who explains in English.');
    await shot(page, 's3-teacher-change-form', size);
    await form.getByRole('button', { name: 'أرسل' }).click();
    const sent = await page
      .getByText(/أُرسل طلبك رقم #\d+/)
      .first()
      .textContent();
    const number = /#(\d+)/.exec(sent ?? '')![1]!;
    await page.getByRole('button', { name: 'حسابي' }).click();
    await page.getByRole('menuitem', { name: 'تسجيل الخروج' }).click();
    await login(page, 'admin@qarabic.test');
    // Client navigation: a reload would rebuild the mocks without the new request.
    await page
      .getByRole('link', { name: /^صندوق الطلبات/ })
      .filter({ visible: true })
      .first()
      .click()
      .catch(async () => {
        await page
          .getByRole('button', { name: /القائمة|فتح القائمة/ })
          .first()
          .click();
        await page
          .getByRole('link', { name: /^صندوق الطلبات/ })
          .first()
          .click();
      });
    await page
      .getByRole('link', { name: new RegExp(`#${number}\\b`) })
      .first()
      .click();
    await expect(page.getByRole('region', { name: /طلب تغيير المعلم/ })).toBeVisible();
    await shot(page, 's3-request-card', size);
  });
}
