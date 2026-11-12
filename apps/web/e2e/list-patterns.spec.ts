import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * D141 list patterns on the reference list («العملاء المحتملون»): views menu on the title, column
 * chooser (remembered), collapsible summary (remembered), split view from 1024 px (phones and
 * tablets open the full page), keyboard use, Arabic RTL + English LTR, axe.
 */
async function open(page: Page, lang: 'ar' | 'en') {
  await page.goto('/login?next=%2Fleads');
  await login(page);
  await expect(page).toHaveURL(/\/leads$/);
  if (lang === 'en') {
    await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  }
  await expect(page.locator('#main h1')).toBeVisible();
}

const L = {
  ar: {
    views: /تغيير العرض$/,
    newView: /^جديد\s*\d+$/,
    summary: /ملخص.*إظهار التفاصيل/,
    tiles: 'ملخص اليوم',
    columns: 'اختيار الأعمدة',
    source: 'المصدر',
    close: 'إغلاق والعودة إلى القائمة',
    full: 'فتح في صفحة كاملة',
    detail: 'ملف الطلب',
    list: 'العملاء المحتملون',
  },
  en: {
    views: /Change view$/,
    newView: /^New\s*\d+$/,
    summary: /Summary.*Show details/,
    tiles: 'Today',
    columns: 'Choose columns',
    source: 'Source',
    close: 'Close and go back to the list',
    full: 'Open in full page',
    detail: 'Lead',
    list: 'Leads',
  },
} as const;

for (const lang of ['ar', 'en'] as const) {
  const l = L[lang];
  test.describe(`${lang}`, () => {
    test(`1440 px: views menu, columns, summary and split view by keyboard and mouse`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, lang);

      // Views menu (keyboard): Enter opens, pick «جديد».
      const views = page.getByRole('heading', { level: 1 }).getByRole('button', { name: l.views });
      await views.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('menuitemradio', { name: l.newView }).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/status=new/);
      await expect(views).toBeFocused();

      // Summary: closed by default, remembered after a reload.
      await expect(page.getByRole('navigation', { name: l.tiles })).toHaveCount(0);
      await page.getByRole('button', { name: l.summary }).click();
      await expect(page.getByRole('navigation', { name: l.tiles })).toBeVisible();

      // Column chooser: hide «المصدر», remembered after a reload.
      const table = page.getByRole('table', { name: l.list });
      await expect(table.getByRole('columnheader', { name: l.source })).toBeVisible();
      await page.getByRole('button', { name: l.columns }).click();
      await page.getByRole('menuitemcheckbox', { name: l.source }).click();
      await page.keyboard.press('Escape');
      await expect(table.getByRole('columnheader', { name: l.source })).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole('navigation', { name: l.tiles })).toBeVisible();
      await expect(
        page.getByRole('table', { name: l.list }).getByRole('columnheader').first(),
      ).toBeVisible();
      await expect(
        page.getByRole('table', { name: l.list }).getByRole('columnheader', { name: l.source }),
      ).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page);

      // Split view: a row opens the lead beside the narrowed list, the URL keeps the id.
      const first = page
        .getByRole('table', { name: l.list })
        .getByRole('row')
        .nth(1)
        .getByRole('link')
        .first();
      const name = (await first.textContent())!.trim();
      await first.click();
      await expect(page).toHaveURL(/[?&]id=\d+/);
      await expect(page).toHaveURL(/status=new/);
      const detail = page.getByRole('region', { name: l.detail });
      await expect(detail.getByRole('heading', { level: 2, name })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      const list = page.getByRole('list', { name: l.list });
      await expect(list.getByRole('link', { name: new RegExp(name) })).toHaveAttribute(
        'aria-current',
        'true',
      );
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page);

      // Switch records without leaving; Back returns to the previous one.
      const links = list.getByRole('link');
      if ((await links.count()) > 1) {
        const second = links.nth(1);
        const id = (await second.getAttribute('href'))!.match(/id=(\d+)/)![1];
        await second.click();
        await expect(page).toHaveURL(new RegExp(`id=${id}`));
        await expect(second).toHaveAttribute('aria-current', 'true');
        await page.goBack();
        await expect(list.getByRole('link', { name: new RegExp(name) })).toHaveAttribute(
          'aria-current',
          'true',
        );
      }
      await expect(detail.getByRole('link', { name: l.full })).toHaveAttribute(
        'href',
        /\/leads\/\d+$/,
      );

      // Close (keyboard) returns to the full list with the filters kept.
      await detail.getByRole('button', { name: l.close }).focus();
      await page.keyboard.press('Enter');
      await expect(page).not.toHaveURL(/[?&]id=/);
      await expect(page).toHaveURL(/status=new/);
      await expect(page.getByRole('table', { name: l.list })).toBeVisible();
    });

    for (const width of [375, 768]) {
      test(`${width} px: a lead opens its own page; menus fit; axe`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await open(page, lang);
        await expectNoHorizontalScroll(page);
        await page.getByRole('button', { name: l.views }).click();
        await expect(page.getByRole('menuitemradio', { name: l.newView })).toBeVisible();
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: l.summary }).click();
        await expect(page.getByRole('navigation', { name: l.tiles })).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page);
        const row =
          width < 768
            ? page
                .getByRole('list')
                .filter({ has: page.locator('li a[href^="/leads/"]') })
                .locator('a')
                .first()
            : page
                .getByRole('table', { name: l.list })
                .getByRole('row')
                .nth(1)
                .getByRole('link')
                .first();
        await row.click();
        await expect(page).toHaveURL(/\/leads\/\d+$/);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      });
    }
  });
}
