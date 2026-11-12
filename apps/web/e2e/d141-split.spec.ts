import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * D141 §1 split view on the lists that have a record view: from 1024 px the record name opens the
 * record beside the list (`?id=`), «إغلاق» returns to the full list, a missing record offers
 * «إغلاق» too; below 1024 px the same link opens the record's own page. Arabic + English, axe.
 */
const LISTS = [
  { path: '/families', full: /\/families\/\d+$/ },
  { path: '/students', full: /\/students\/\d+$/ },
  { path: '/teachers', full: /\/teachers\/\d+$/ },
  { path: '/staff', full: /\/staff\/\d+$/ },
] as const;

const CLOSE = { ar: 'إغلاق والعودة إلى القائمة', en: 'Close and go back to the list' } as const;

async function open(page: Page, path: string, width: number, lang: 'ar' | 'en' = 'ar') {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page);
  await page.waitForURL((u) => u.pathname === path);
  if (lang === 'en') {
    await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  }
  await expect(page.locator('#main h1')).toBeVisible();
}

/** The record-name link in the first table row. */
const firstNameLink = (page: Page) =>
  page.locator('#main table tbody tr').first().getByRole('link').first();

for (const list of LISTS) {
  for (const lang of ['ar', 'en'] as const) {
    test(`${list.path} 1440 ${lang}: the name opens the split view; «إغلاق» returns`, async ({
      page,
    }) => {
      await open(page, list.path, 1440, lang);
      const name = (await firstNameLink(page).textContent())!.trim();
      await firstNameLink(page).click();
      await expect(page).toHaveURL(new RegExp(`${list.path}\\?.*id=\\d+`));
      await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
      await expect(page.locator('#main h1')).toHaveCount(1);
      await expectNoHorizontalScroll(page);
      await expect(page).toHaveTitle(/\S/);
      await expectNoSeriousA11yViolations(page);
      await page.getByRole('button', { name: CLOSE[lang] }).first().click();
      await expect(page).not.toHaveURL(/[?&]id=/);
      await expect(page.locator('#main table')).toBeVisible();
    });
  }

  test(`${list.path} 768: the name opens the full page`, async ({ page }) => {
    await open(page, list.path, 768);
    await firstNameLink(page).click();
    await expect(page).toHaveURL(list.full);
    await expect(page.locator('#main h1')).toBeVisible();
  });
}

test('a missing record in the pane offers «إغلاق»', async ({ page }) => {
  await open(page, '/staff', 1440);
  await page.goto('/staff?id=9999');
  const alert = page.locator('#main [role="alert"]');
  await expect(alert).toBeVisible();
  await alert.getByRole('button', { name: CLOSE.ar }).click();
  await expect(page).toHaveURL(/\/staff$/);
});

test('split view: an active status shows as a chip with «مسح الكل»', async ({ page }) => {
  await open(page, '/students', 1440);
  await page
    .getByRole('radiogroup', { name: 'تصفية حسب الحالة' })
    .getByRole('radio')
    .nth(1)
    .click();
  await expect(page).toHaveURL(/status=/);
  await firstNameLink(page).click();
  await expect(page).toHaveURL(/id=\d+/);
  await expect(page.getByText('عوامل التصفية:')).toBeVisible();
  await page.getByRole('button', { name: 'مسح الكل' }).click();
  await expect(page).not.toHaveURL(/status=/);
  await expect(page).toHaveURL(/id=\d+/);
});
