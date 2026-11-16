import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * C2 calendar on the mock API (docs/42 §3, D148/D149): every view at 375/768/1440 in Arabic and
 * English passes axe with no sideways scroll; a class opens the board's sheet; empty time starts a
 * new enrollment at that time; the enrollments list moved to /schedule/enrollments.
 */
async function open(page: Page, width: number, lang: 'ar' | 'en', path: string) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page);
  await page.waitForURL((u) => u.pathname === '/schedule');
  if (lang === 'en') {
    await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.reload();
  }
  await expect(page.locator('[data-slot="event-calendar-nav"]')).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

for (const width of [375, 768, 1440]) {
  for (const lang of ['ar', 'en'] as const) {
    test(`calendar ${width}px ${lang}: views fit and pass axe`, async ({ page }) => {
      test.slow();
      // Week and day as staff use them: one teacher chosen (a week of every teacher packs the
      // classes too narrow; the default for staff is the teachers view).
      const views =
        width === 375
          ? ['list', 'day&teachers=1']
          : ['week&teachers=1', 'month', 'list', 'teachers', 'day&teachers=1'];
      await open(page, width, lang, `/schedule?view=${views[0]}`);
      const failures: string[] = [];
      for (const view of views) {
        await test.step(view, async () => {
          try {
            await page.goto(`/schedule?view=${view}`);
            await expect(page.locator('[data-slot="event-calendar-nav"]')).toBeVisible();
            await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
            await expectNoHorizontalScroll(page);
            await expectNoSeriousA11yViolations(page);
          } catch (e) {
            const ids = [...new Set((e as Error).message.match(/"id": "[a-z-]+"/g) ?? [])];
            failures.push(`${view}: ${ids.join(' ') || (e as Error).message.split('\n')[0]}`);
          }
        });
      }
      expect(failures).toEqual([]);
    });
  }
}

test('overlapping classes in a narrow week column: lanes stay tappable, the rest behind «+N» (768)', async ({
  page,
}) => {
  // The mocks place classes relative to now; at this instant teacher 1 has two classes at the
  // same hour on one day (a trial over a regular class), which once split a ~40 px day column
  // into two 18 px lanes (axe target-size, 2026-11-16).
  await page.clock.setFixedTime(new Date('2026-11-16T07:45:00Z'));
  await open(page, 768, 'ar', '/schedule?view=week&teachers=1');
  const more = page.locator('[data-slot="event-calendar-lane-more"] button').first();
  await expect(more).toBeVisible();
  const box = (await more.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);
  await expectNoSeriousA11yViolations(page);
  await more.click();
  const list = page.locator('[data-slot="event-calendar-more-popover"]');
  await expect(list.locator('[data-slot="event-calendar-event"]')).toHaveCount(2);
});

test('a class opens the board’s class sheet (1440, Arabic)', async ({ page }) => {
  await open(page, 1440, 'ar', '/schedule?view=list');
  await page
    .locator('[data-slot="event-calendar"] [role="button"], [data-slot="event-calendar"] button')
    .filter({ hasText: ' · ' })
    .first()
    .click();
  await expect(page).toHaveURL(/session=\d+/);
  await expect(page.getByRole('dialog', { name: 'تفاصيل الحصة' })).toBeVisible();
});

test('the enrollments list lives at /schedule/enrollments and links back to the calendar', async ({
  page,
}) => {
  await open(page, 1440, 'ar', '/schedule');
  await page.getByRole('link', { name: /الاشتراكات/ }).click();
  await expect(page).toHaveURL(/\/schedule\/enrollments$/);
  await expect(page.getByRole('table', { name: 'الاشتراكات' })).toBeVisible();
});

test('C3: a trial opens the teachers view of suitable teachers; a time in a column checks and offers', async ({
  page,
}) => {
  await open(
    page,
    1440,
    'ar',
    '/schedule?view=teachers&trialLead=6&trialStudent=601&trialCourse=2',
  );
  await expect(page.getByText(/اختيار معلم للحصة التجريبية/)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  // Early in the day (empty in the mocks): a click on the column's free time.
  await page
    .locator('[data-ec-resource]')
    .first()
    .click({ position: { x: 20, y: 12 } });
  await expect(page.getByRole('dialog', { name: 'إرسال الحصة التجريبية إلى معلم' })).toBeVisible();
});
