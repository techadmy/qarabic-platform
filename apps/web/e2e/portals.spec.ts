import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * M9 portals against the MSW mocks: the teacher's home «يومي» and the parent home additions, at
 * phone, tablet and desktop widths, Arabic RTL and English LTR, with axe.
 */
const WIDTHS = { mobile: 375, tablet: 768, desktop: 1440 } as const;

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await login(page, email);
  await expect(page.locator('main h1').first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

async function switchToEnglish(page: Page) {
  await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  // Leave the switch button: axe must not read its hover / colour transition.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
}

for (const [name, width] of Object.entries(WIDTHS)) {
  for (const lang of ['ar', 'en'] as const) {
    for (const role of ['teacher', 'parent'] as const) {
      test(`${name} ${width}px ${lang}: ${role} home fits and passes axe`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await signIn(page, `${role}@qarabic.test`);
        if (lang === 'en') await switchToEnglish(page);
        if (role === 'teacher') {
          const hero = page.getByRole('region', {
            name:
              lang === 'ar' ? /الحصة التالية|الحصة الجارية الآن/ : /Next class|Class in progress/,
          });
          await expect(hero).toBeVisible();
        }
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        await expectNoHorizontalScroll(page);
        // Next streams <title> with the page metadata; axe needs it in place.
        await expect(page).toHaveTitle(/\S/);
        await expectNoSeriousA11yViolations(page);
      });
    }
  }
}

test('teacher «يومي»: the next days open on tap; the student opens their profile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, 'teacher@qarabic.test');
  await expect(page.getByRole('heading', { level: 1, name: /مرحبًا/ })).toBeVisible();
  const upcoming = page.getByRole('region', { name: 'الأيام الخمسة القادمة' });
  await expect(upcoming.getByRole('heading', { level: 3 })).toHaveCount(5);
  const day = upcoming.getByRole('button', { disabled: false }).first();
  await day.click();
  await expect(day).toHaveAttribute('aria-expanded', 'true');
  await expectNoHorizontalScroll(page);

  const hero = page.getByRole('region', { name: /الحصة التالية|الحصة الجارية الآن/ });
  await hero.getByRole('link').click();
  await expect(page).toHaveURL(/\/students\/\d+$/);
});

test('parent: a child card opens that child’s lessons and progress', async ({ page }) => {
  await signIn(page, 'parent@qarabic.test');
  const link = page.getByRole('link', { name: /وتقدّمه$/ }).first();
  await link.click();
  await expect(page).toHaveURL(/\/students\/\d+$/);
  await expect(page.locator('main h1').first()).toBeVisible();
});

test('parent (phone): «المستحق عليكم» leads to paying that invoice', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, 'parent@qarabic.test');
  const due = page.getByRole('region', { name: 'المستحق عليكم' });
  await expect(due).toBeVisible();
  const pay = due.getByRole('link', { name: /^ادفع الآن/ }).first();
  // A thumb-sized target on the phone (docs/15 §5.15).
  expect((await pay.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await pay.click();
  await expect(page).toHaveURL(/\/invoices\/\d+\?pay=1$/);
  await expect(page.locator('main h1').first()).toBeVisible();
});
