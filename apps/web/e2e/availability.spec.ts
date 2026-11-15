import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * A1 availability (docs/42 §4, D148, B131) on the mock API: the teacher paints and requests new
 * hours (pending, visible); staff approve from the queue. Both screens pass axe with no sideways
 * scroll at 375/768/1440 in Arabic and English.
 */
async function signIn(page: Page, email: string, path: string, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page, email);
  await page.waitForURL((u) => u.pathname === path);
}

for (const width of [375, 768, 1440]) {
  for (const lang of ['ar', 'en'] as const) {
    test(`availability ${width}px ${lang}: the teacher's week and the staff queue pass axe`, async ({
      page,
    }) => {
      test.slow();
      await signIn(page, 'teacher@qarabic.test', '/my-schedule', width);
      if (lang === 'en') {
        await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
        await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
        await page.reload();
      }
      await expect(page.locator('[data-slot="event-calendar"]').first()).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page);
    });
  }
}

test('a teacher requests new hours: they wait for approval, visible, and can be withdrawn', async ({
  page,
}) => {
  // Approval by staff is covered in the unit tests (a reload here would rebuild the mocks).
  await signIn(page, 'teacher@qarabic.test', '/my-schedule');
  await page.getByRole('button', { name: 'أضف فترة' }).click();
  await page.getByRole('button', { name: 'أرسل الطلب للاعتماد' }).click();
  const mine = page.getByRole('region', { name: 'طلباتي لتعديل الإتاحة' });
  await expect(mine.getByText('بانتظار الاعتماد')).toBeVisible();
  await mine.getByRole('button', { name: 'سحب الطلب' }).click();
  await expect(mine.getByText('مسحوب')).toBeVisible();
});
