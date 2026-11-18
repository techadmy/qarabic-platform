import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * J4 on the mock API, in the UI: the parent takes a leave on a class next week (approved on its
 * own: enough notice; no «وقت الإبلاغ» for a parent), then asks for its make-up («حصة تعويضية»)
 * from the same class menu. The make-up dialog passes axe at 1440, 768 and 375.
 */
async function nextWeek(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const week = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await page.goto(`/login?next=${encodeURIComponent(`/my-classes?week=${week}`)}`);
  await login(page, 'parent@qarabic.test');
  await page.waitForURL((u) => u.pathname === '/my-classes');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(page.locator('tr[data-session-id]:visible').first()).toBeVisible();
}

/** Sends the open request dialog; warnings (e.g. outside work hours) are ticked, then resent. */
async function send(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'أرسل الطلب' }).click();
  // One outcome: the dialog closes (sent), or the server's warnings come back to tick.
  const warning = dialog.getByRole('checkbox').first();
  await Promise.race([dialog.waitFor({ state: 'hidden' }), warning.waitFor()]);
  if (await warning.isVisible()) {
    for (const box of await dialog.getByRole('checkbox').all()) await box.check();
    await dialog.getByRole('button', { name: 'أرسل الطلب' }).click();
  }
  await expect(dialog).toBeHidden();
}

test('parent: a leave next week, then its make-up from the class menu', async ({ page }) => {
  test.slow();
  await nextWeek(page);
  // A class with no request pending yet.
  const row = page
    .locator('tr[data-session-id]:visible')
    .filter({ hasNotText: 'طلب قيد المراجعة' })
    .first();
  const id = await row.getAttribute('data-session-id');
  const same = page.locator(`[data-session-id="${id}"]:visible`);
  await same.getByRole('button', { name: /^إجراءات أخرى/ }).click();
  await page.getByRole('menuitem', { name: 'طلب إجازة' }).click();
  const leave = page.getByRole('dialog');
  await expect(leave.getByLabel(/السبب/)).toBeVisible();
  await expect(leave.getByLabel('وقت الإبلاغ')).toHaveCount(0);
  await leave.getByLabel(/السبب/).fill('Family trip');
  await send(page);
  await expect(page.getByText('اعتُمد الطلب تلقائيًا')).toBeVisible();
  await expect(same.getByText('إجازة', { exact: true })).toBeVisible();

  // The make-up dialog at each width; below 768 the classes are cards (a new menu), so it opens
  // again from that layout's own menu.
  const makeUp = page.getByRole('dialog', { name: /^حصة تعويضية — / });
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const host = page.locator(`[data-session-id="${id}"]:visible`);
    await host.getByRole('button', { name: /^إجراءات أخرى/ }).click();
    await page.getByRole('menuitem', { name: 'حصة تعويضية' }).click();
    await expect(makeUp.getByText(/خلال المدة التي تسمح بها الأكاديمية/)).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(0);
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
    if (width !== 1440) {
      await page.keyboard.press('Escape');
      await expect(makeUp).toBeHidden();
    }
  }
  // A free time: the class's own time the next day is taken by another of the teacher's classes.
  await makeUp.getByRole('combobox', { name: 'الوقت المطلوب' }).click();
  await page.getByRole('option').nth(13).click(); // 03:15
  await makeUp.getByLabel(/السبب/).fill('Make-up after the trip');
  await send(page);
  await expect(page.getByText(/^أُرسل الطلب|^اعتُمد الطلب/).first()).toBeVisible();
});
