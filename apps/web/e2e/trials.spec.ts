import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * T4 on the mock API: «الحصص التجريبية اليوم» (filter, day navigation, a row opened by keyboard)
 * at 1440 in English, and the CRM settings' trial card at 375 (an out-of-range number is said and
 * focused), with axe.
 */
async function open(page: Page, path: string, width: number, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page);
  await page.waitForURL((u) => u.pathname === path);
}

test('today’s trial classes (1440, English): filter, days, a row by keyboard', async ({ page }) => {
  await open(page, '/trials', 1440);
  await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Today’s trial classes' }),
  ).toBeVisible();
  await expect(page.getByText(/Times in your zone/)).toBeVisible();
  await page.getByRole('radio', { name: /^All/ }).click();
  await expect(page).toHaveURL(/view=all/);
  await page.getByRole('button', { name: 'Next day' }).click();
  await expect(page).toHaveURL(/date=\d{4}-\d{2}-\d{2}/);
  await page.getByRole('button', { name: 'Previous day' }).click();
  await expect(page).not.toHaveURL(/date=/);
  await expectNoSeriousA11yViolations(page);
  // A row's link, by keyboard: the class opens in the sheet.
  const link = page.locator('main a[href*="session="]').first();
  if (await link.count()) {
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/session=\d+/);
    await expect(page.getByRole('dialog', { name: 'Class details' })).toBeVisible();
  }
});

test('CRM settings (375): the trial card, an out-of-range number is said and focused', async ({
  page,
}) => {
  await open(page, '/settings/crm', 375, 900);
  const expiry = page.getByRole('spinbutton', { name: 'مهلة الرد على العرض (بالدقائق)' });
  await expiry.fill('5');
  await page.getByRole('button', { name: 'احفظ الإعدادات' }).click();
  await expect(expiry).toBeFocused();
  await expect(page.getByText('أدخل رقمًا بين 15 و1440.')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);
});
