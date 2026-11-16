import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * D151 (b) «حسابات Zoom» on the mock API: with the Zoom account connected, the licensed users and
 * their teachers, linking a free one to a teacher, «مزامنة الآن»; with it off, one clear empty
 * state. The mock account is off unless `qarabic.mock.zoomOn` is set before the page loads.
 */
async function openTab(page: Page, width: number, zoomOn: boolean, lang: 'ar' | 'en' = 'ar') {
  if (zoomOn) {
    await page.addInitScript(() => window.localStorage.setItem('qarabic.mock.zoomOn', '1'));
  }
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/login?next=${encodeURIComponent('/settings/sessions')}`);
  await login(page);
  await page.waitForURL((u) => u.pathname === '/settings/sessions');
  if (lang === 'en') {
    await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.reload();
  }
  await page.getByRole('tab', { name: lang === 'ar' ? 'حسابات Zoom' : 'Zoom accounts' }).click();
}

test('connected: link a free licensed user to a teacher, then sync', async ({ page }) => {
  await openTab(page, 1440, true);
  const table = page.getByRole('table', { name: 'حسابات Zoom' });
  await expect(table.getByRole('row')).toHaveCount(7);
  await table.getByRole('button', { name: /^ربط بمعلم.*Qarabic Zoom 4/ }).click();
  const dialog = page.getByRole('dialog', { name: /Qarabic Zoom 4/ });
  await dialog.getByRole('combobox', { name: 'المعلم' }).click();
  await page.getByRole('option', { name: /^Ahmed Fathy/ }).click();
  await dialog.getByRole('button', { name: 'ربط بمعلم' }).click();
  await expect(page.getByText('رُبط الحساب بالمعلم.')).toBeVisible();
  const row = table.getByRole('row').filter({ hasText: 'zoom4@qarabic.test' });
  await expect(row.getByRole('link', { name: 'Ahmed Fathy' })).toBeVisible();

  await page.getByRole('button', { name: 'مزامنة الآن' }).click();
  await expect(page.getByText(/^تمت المزامنة:/)).toBeVisible();
});

for (const width of [375, 768, 1440]) {
  for (const lang of ['ar', 'en'] as const) {
    test(`Zoom accounts ${width}px ${lang}: connected and not connected pass axe`, async ({
      page,
    }) => {
      test.slow();
      await openTab(page, width, false, lang);
      await expect(
        page.getByText(
          lang === 'ar' ? 'يُفعَّل بعد ربط حساب Zoom' : 'Available once Zoom is connected',
        ),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page);

      await page.evaluate(() => window.localStorage.setItem('qarabic.mock.zoomOn', '1'));
      await page.reload();
      await page
        .getByRole('tab', { name: lang === 'ar' ? 'حسابات Zoom' : 'Zoom accounts' })
        .click();
      await expect(
        page.getByRole('table', { name: lang === 'ar' ? 'حسابات Zoom' : 'Zoom accounts' }),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page);
    });
  }
}
