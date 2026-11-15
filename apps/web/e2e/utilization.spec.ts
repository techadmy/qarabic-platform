import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * R1 teacher utilization (docs/42 §5) on the mock API: the report fits and passes axe at 375, 768
 * and 1440 in Arabic and English; sorting writes the URL; a teacher opens their week.
 */
async function open(page: Page, width: number, lang: 'ar' | 'en') {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/login?next=%2Freports%2Futilization');
  await login(page);
  await page.waitForURL((u) => u.pathname === '/reports/utilization');
  if (lang === 'en') {
    await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.reload();
  }
  await expect(page.locator('table').nth(1)).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

for (const width of [375, 768, 1440]) {
  for (const lang of ['ar', 'en'] as const) {
    test(`utilization ${width}px ${lang}: fits and passes axe`, async ({ page }) => {
      await open(page, width, lang);
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page);
    });
  }
}

test('sorting writes the URL; a teacher opens their week on the calendar', async ({ page }) => {
  await open(page, 1440, 'ar');
  const table = page.getByRole('table', { name: 'إشغال المعلمين في الفترة' });
  await table.getByRole('button', { name: /محجوزة/ }).click();
  await expect(page).toHaveURL(/sort=booked/);
  await table.getByRole('row').nth(1).getByRole('link').first().click();
  await expect(page).toHaveURL(/\/schedule\?view=week&teachers=\d+/);
});
