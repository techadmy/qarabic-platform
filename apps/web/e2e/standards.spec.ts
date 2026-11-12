import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * Cross-cutting UI standards (docs/standards/ui-ux.md): every main screen at phone, tablet and
 * desktop widths, in Arabic RTL and English LTR, has no horizontal scroll and no serious axe
 * violations; keyboard focus is visible; the warning surface comes from the design tokens.
 */
const WIDTHS = { mobile: 375, tablet: 768, desktop: 1440 } as const;
const PAGES = [
  '/',
  '/today',
  '/families',
  '/schedule',
  '/leads',
  '/invoices',
  '/payroll',
  '/attendance',
  '/accounting/journal',
  // Profiles with the «الحصص القادمة» table: it widened the page by ~500 px at 768 (audit 2026-11-12).
  '/students/1',
  '/teachers/1',
] as const;

async function switchToEnglish(page: Page) {
  await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
}

// One test per page × width × language: all pages in one test outgrew the 30 s budget on the CI
// runner (axe takes seconds per page), and a failure now names the page.
for (const [name, width] of Object.entries(WIDTHS)) {
  for (const lang of ['ar', 'en'] as const) {
    test.describe(`${name} ${width}px ${lang}`, () => {
      test.use({ viewport: { width, height: 900 } });

      test('the login page fits the screen', async ({ page }) => {
        await page.goto('/login');
        await expect(page.locator('#password')).toBeVisible();
        await expectNoHorizontalScroll(page);
      });

      for (const path of PAGES) {
        test(`${path} fits the screen and passes axe`, async ({ page }) => {
          await page.goto('/login');
          await login(page);
          await expect(page.locator('main h1').first()).toBeVisible();
          if (lang === 'en') await switchToEnglish(page);
          // Then a fresh load of the page: a client-side navigation or the language switch re-streams
          // the metadata and briefly leaves <title> empty, which axe reports.
          await page.goto(path);
          await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
          await expect(page.locator('main h1').first()).toBeVisible();
          await expectNoHorizontalScroll(page);
          // Next streams <title> with the page metadata; axe needs it in place.
          await expect(page).toHaveTitle(/\S/);
          await expectNoSeriousA11yViolations(page);
        });
      }
    });
  }
}

test('keyboard: Tab moves focus through the login form with a visible focus indicator', async ({
  page,
}) => {
  await page.goto('/login');
  const email = page.getByLabel('البريد الإلكتروني');
  await email.focus();
  await page.keyboard.press('Tab');
  const focused = page.locator(':focus');
  await expect(focused).toHaveAttribute('id', 'password');
  const indicator = await focused.evaluate((el) => {
    const s = getComputedStyle(el);
    return { outline: s.outlineStyle, shadow: s.boxShadow };
  });
  expect(indicator.outline !== 'none' || indicator.shadow !== 'none').toBe(true);
});

test('the warning alert uses the warning token surface', async ({ page }) => {
  await page.goto(`/login?next=${encodeURIComponent('/schedule')}`);
  await login(page);
  await expect(page).toHaveURL(/\/schedule$/);
  // D141: «اشتراك جديد» is the ListActions create button.
  await page.getByRole('button', { name: 'اشتراك جديد' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'اشتراك جديد' })).toBeVisible();
  await page.getByRole('combobox', { name: /الطالب/ }).click();
  await page.getByPlaceholder('ابحث باسم الطالب').fill('Ali');
  await page.getByRole('option', { name: /^Ali\s?New York$/ }).click();
  await page.getByRole('combobox', { name: /المعلم/ }).click();
  await page.getByPlaceholder('ابحث باسم المعلم').fill('Ahmed');
  await page.getByRole('option', { name: /Ahmed Fathy/ }).click();
  await page.getByRole('combobox', { name: /الدورة/ }).click();
  await page.getByRole('option').first().click();
  await page.getByLabel(/رابط الاجتماع/).fill('https://meet.example.com/e2e-class');
  await page.getByRole('button', { name: 'التالي' }).click();
  await page.getByRole('combobox', { name: /^الوقت/ }).click();
  await page.getByRole('option', { name: '8:00 م' }).click();
  await page.getByRole('button', { name: 'أضف الموعد' }).click();

  const tick = page.getByRole('checkbox', { name: 'خارج ساعات عمل المعلم' });
  const alert = page.locator('[data-slot="alert"]').filter({ has: tick });
  await expect(alert).toBeVisible();
  const colors = await alert.evaluate((el) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--warning)';
    document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(el).backgroundColor, expected };
  });
  expect(colors.actual).toBe(colors.expected);
  await expect(page).toHaveTitle(/\S/);
  await expectNoSeriousA11yViolations(page);
});
