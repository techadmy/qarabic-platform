import { expect, test, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * N4 review screenshots (Arabic, light): «تواصل معنا», «طلباتي», a ticket, the support inbox, the
 * parent home and the support settings, desktop 1440×900 and mobile 375×812.
 * Runs only when N4_SHOTS_DIR is set: `N4_SHOTS_DIR=/path pnpm test:e2e n4-screenshots`.
 */
const dir = process.env.N4_SHOTS_DIR;
test.skip(!dir, 'N4_SHOTS_DIR not set');

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
  test(`N4 screens ${size}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize(viewport);
    await page.goto('/login');
    await login(page, 'parent@qarabic.test');
    await expect(page.getByRole('heading', { name: 'آخر تقارير الحصص' })).toBeVisible();
    await shot(page, 'parent-home', size);

    await page
      .getByRole('button', { name: 'تواصل معنا' })
      .filter({ visible: true })
      .first()
      .click();
    const hub = page.getByRole('dialog', { name: 'تواصل معنا' });
    await expect(hub.getByRole('link', { name: /#1 · / })).toBeVisible();
    await shot(page, 'contact-hub', size);
    await hub.getByRole('button', { name: /^الحصص والمواعيد/ }).click();
    await expect(
      page.getByRole('button', { name: /^مشكلة في هذه الحصة · / }).first(),
    ).toBeVisible();
    await shot(page, 'contact-hub-classes', size);
    await page.keyboard.press('Escape');

    await page.goto('/my-requests');
    await expect(page.getByRole('list', { name: 'طلباتي' })).toBeVisible();
    await shot(page, 'my-requests', size);
    await page.goto('/tickets/1');
    await expect(page.getByText('هل حُلّت المشكلة؟')).toBeVisible();
    await shot(page, 'ticket-detail', size);

    await page.getByRole('button', { name: 'حسابي' }).click();
    await page.getByRole('menuitem', { name: 'تسجيل الخروج' }).click();
    await login(page, 'admin@qarabic.test');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goto('/support');
    await expect(page.getByRole('list', { name: 'صندوق الطلبات' })).toBeVisible();
    await shot(page, 'support-inbox', size);
    await page.goto('/tickets/4');
    await expect(page.getByText('معالجة الطلب')).toBeVisible();
    await shot(page, 'ticket-detail-staff', size);
    await page.goto('/feedback');
    await expect(page.getByRole('heading', { level: 1, name: 'فرز البلاغات' })).toBeVisible();
    await shot(page, 'feedback-triage', size);
    await page.goto('/settings/support');
    await expect(page.getByRole('table', { name: 'الأقسام' })).toBeVisible();
    await shot(page, 'support-settings', size);
  });
}
