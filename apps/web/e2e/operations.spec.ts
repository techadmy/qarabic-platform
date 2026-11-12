import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * M8 operations against the MSW mocks: tasks (boxes, detail, hand-in) and announcements (feed and
 * management), at phone, tablet and desktop widths in Arabic and English, with axe.
 */
const WIDTHS = { mobile: 375, tablet: 768, desktop: 1440 } as const;
const PAGES = [
  '/tasks',
  '/tasks?box=issued',
  '/tasks/1',
  '/announcements',
  '/announcements?tab=manage',
];

async function signIn(page: Page, email: string, path: string) {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page, email);
  await expect(page.locator('main h1').first()).toBeVisible();
}

for (const [name, width] of Object.entries(WIDTHS)) {
  for (const lang of ['ar', 'en'] as const) {
    test(`${name} ${width}px ${lang}: tasks and announcements fit and pass axe`, async ({
      page,
    }) => {
      test.slow();
      await page.setViewportSize({ width, height: 900 });
      await signIn(page, 'admin@qarabic.test', '/tasks');
      if (lang === 'en') {
        await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
        await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      }
      for (const path of PAGES) {
        await page.goto(path);
        await expect(page.locator('main h1').first()).toBeVisible();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page);
      }
    });
  }
}

test('monitor on a phone: opens a given task and hands it in', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, 'monitor@qarabic.test', '/tasks');
  await page
    .getByRole('link', { name: /اتصل بأسرة/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/tasks\/\d+$/);
  await page.getByRole('button', { name: 'تسليم للمراجعة' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'تسليم للمراجعة' }).click();
  await expect(page.getByText('بانتظار المراجعة').first()).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('teacher reads the announcements and marks one read', async ({ page }) => {
  await signIn(page, 'teacher@qarabic.test', '/announcements');
  const feed = page.getByRole('list', { name: 'الإعلانات' });
  await expect(feed.getByRole('heading', { level: 2 }).first()).toHaveText('تحديث سياسة الإجازات');
  const before = await feed.getByRole('button', { name: /تم الاطلاع/ }).count();
  await feed
    .getByRole('button', { name: /تم الاطلاع/ })
    .first()
    .click();
  await expect(feed.getByRole('button', { name: /تم الاطلاع/ })).toHaveCount(before - 1);
});
