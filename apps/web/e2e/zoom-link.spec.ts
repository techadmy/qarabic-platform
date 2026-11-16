import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * D151 on the mock API: every teacher has their own Zoom link, set by staff on the profile; their
 * classes use it. Teacher 2 has none in the mocks, so the profile and the Today board warn.
 */
async function signIn(page: Page, email: string, path: string, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page, email);
  await page.waitForURL((u) => u.pathname === path);
}

async function toEnglish(page: Page) {
  await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.reload();
}

test('staff add a missing link on the profile; a link another teacher uses is refused on the field', async ({
  page,
}) => {
  await signIn(page, 'admin@qarabic.test', '/teachers/2');
  const warning = page.getByRole('alert').filter({ hasText: 'لا يوجد رابط Zoom لهذا المعلم' });
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'أضف الرابط' }).click();

  const sheet = page.getByRole('dialog').first();
  const field = sheet.getByLabel('رابط Zoom', { exact: true });
  await expect(field).toBeVisible();
  // Teacher 1's meeting (the mocks give each teacher 81000000<id>): refused, on the field.
  await field.fill('https://zoom.us/j/8100000001');
  await sheet.getByRole('button', { name: 'حفظ' }).click();
  await expect(
    sheet.getByText('هذا الرابط مسجّل لمعلم آخر. لكل معلم رابط Zoom خاص به.'),
  ).toBeVisible();
  await expect(field).toBeFocused();

  // A link of their own: saved, shown with copy and open, the warning gone.
  await field.fill('https://us02web.zoom.us/j/81234567890?pwd=e2e');
  await sheet.getByRole('button', { name: 'حفظ' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText('https://us02web.zoom.us/j/81234567890?pwd=e2e')).toBeVisible();
  await expect(page.getByRole('button', { name: /^نسخ/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /^فتح/ })).toHaveAttribute(
    'href',
    'https://us02web.zoom.us/j/81234567890?pwd=e2e',
  );
  await expect(warning).toBeHidden();
});

test('a new enrollment uses the teacher’s link by default; a custom link is optional', async ({
  page,
}) => {
  await signIn(page, 'admin@qarabic.test', '/schedule/new');
  const meeting = page.getByRole('combobox', { name: 'الاجتماع' });
  await expect(meeting).toContainText('رابط زووم المعلّم');
  await expect(page.getByLabel(/رابط الاجتماع/)).toHaveCount(0);
  await meeting.click();
  await page.getByRole('option', { name: 'رابط خارجي ثابت' }).click();
  await expect(page.getByLabel(/رابط الاجتماع/)).toBeVisible();
});

test('the teacher reads their own link (read-only) on the home page', async ({ page }) => {
  await signIn(page, 'teacher@qarabic.test', '/');
  const card = page.getByText('رابط Zoom الخاص بك').locator('xpath=ancestor::*[@data-slot="card"]');
  await expect(card.getByText('https://us02web.zoom.us/j/8100000001?pwd=demo1')).toBeVisible();
  await expect(card.getByText('8100000001', { exact: true })).toBeVisible();
  await expect(card.getByRole('textbox')).toHaveCount(0);
  await expect(card.getByRole('button', { name: /نسخ/ })).toBeVisible();
});

for (const width of [375, 768, 1440]) {
  for (const lang of ['ar', 'en'] as const) {
    test(`D151 ${width}px ${lang}: the profile warning and the board badge pass axe`, async ({
      page,
    }) => {
      test.slow();
      await signIn(page, 'admin@qarabic.test', '/teachers/2', width);
      if (lang === 'en') await toEnglish(page);
      const missing =
        lang === 'ar' ? 'لا يوجد رابط Zoom لهذا المعلم' : 'This teacher has no Zoom link';
      await expect(page.getByRole('alert').filter({ hasText: missing })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page);

      // The board: teacher 2's classes on their own link carry the warning badge.
      await page.goto('/today');
      const badge = lang === 'ar' ? 'لا يوجد رابط زووم للمعلّم' : 'The teacher has no Zoom link';
      await expect(page.getByText(badge).first()).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page);
    });
  }
}
