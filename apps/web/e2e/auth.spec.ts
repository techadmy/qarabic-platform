import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, login } from './helpers';

test('Arabic RTL by default', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { name: 'تسجيل الدخول إلى حسابك' })).toBeVisible();
});

test('login → home, and a signed-in user visiting /login goes home', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await login(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'مرحبًا، مدير النظام' })).toBeVisible();
  await page.goto('/login');
  await expect(page).toHaveURL(/\/$/);
});

test('an unauthenticated deep link comes back after login', async ({ page }) => {
  await page.goto('/roles');
  await expect(page).toHaveURL(/\/login\?next=%2Froles$/);
  await login(page);
  await expect(page).toHaveURL(/\/roles$/);
  await expect(page.getByRole('table', { name: 'الأدوار' })).toBeVisible();
});

test('wrong password shows the invalid-credentials message', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('البريد الإلكتروني').fill('admin@qarabic.test');
  await page.locator('#password').fill('wrong');
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByText('البريد الإلكتروني أو كلمة المرور غير صحيحة.')).toBeVisible();
});

test('a teacher sees only their own pages: «الرئيسية», «حصصي», «طلباتي», «طلابي»', async ({
  page,
}) => {
  await page.goto('/login');
  await login(page, 'teacher@qarabic.test');
  await expect(page.getByRole('heading', { name: 'مرحبًا، معلم تجريبي' })).toBeVisible();
  await expect(page.locator('[data-sidebar="content"]').getByRole('link')).toHaveText([
    'الرئيسية',
    'حصصي',
    'طلباتي',
    'طلابي',
  ]);
});

test('language switch on the login page flips to English LTR', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

test('language switch in the top bar flips the app shell', async ({ page }) => {
  await page.goto('/login');
  await login(page);
  await expect(page.getByRole('heading', { name: 'مرحبًا، مدير النظام' })).toBeVisible();
  await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { name: 'Welcome, مدير النظام' })).toBeVisible();
  await expect(page.locator('[data-slot="sidebar"][data-side="left"]')).toBeAttached();
});

test('logout returns to the login page', async ({ page }) => {
  await page.goto('/login');
  await login(page);
  await page.getByRole('button', { name: 'حسابي' }).click();
  await expect(page.getByRole('menu')).toContainText('admin@qarabic.test');
  await page.getByRole('menuitem', { name: 'تسجيل الخروج' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});

test.describe('mobile 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('no horizontal scroll on login, home and roles; sidebar opens as a sheet', async ({
    page,
  }) => {
    await page.goto('/login');
    await expectNoHorizontalScroll(page);
    await login(page);
    await expect(page.getByRole('heading', { name: 'مرحبًا، مدير النظام' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'إظهار القائمة الجانبية أو إخفاؤها' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('link', { name: 'الأدوار والصلاحيات' })).toBeVisible();
    await sheet.getByRole('link', { name: 'الأدوار والصلاحيات' }).click();
    await expect(page.getByRole('table', { name: 'الأدوار' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe('accessibility (axe)', () => {
  for (const path of ['/login', '/forgot-password']) {
    test(`${path} has no serious or critical violations`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const serious = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
    });
  }

  test('the app shell has no serious or critical violations', async ({ page }) => {
    await page.goto('/login');
    await login(page);
    await expect(page.getByRole('heading', { name: 'مرحبًا، مدير النظام' })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
  });
});

test('the RTL spike page is not served by production builds', async ({ page }) => {
  const response = await page.goto('/dev/components');
  expect(response?.status()).toBe(404);
});
