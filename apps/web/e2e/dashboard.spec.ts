import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * D2 management dashboard on the mock API (docs/40, D144), gating in CI: the range bar drives the
 * URL, compare names the API's previous period, and the page passes axe with no sideways scroll at
 * 375, 768 and 1440 px in Arabic and English.
 */
const RUNS = [
  { width: 375, lang: 'ar' },
  { width: 375, lang: 'en' },
  { width: 768, lang: 'ar' },
  { width: 768, lang: 'en' },
  { width: 1440, lang: 'ar' },
  { width: 1440, lang: 'en' },
] as const;

async function open(page: Page, width: number, lang: 'ar' | 'en', path = '/') {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page);
  await page.waitForURL((u) => u.pathname === '/');
  if (lang === 'en') {
    await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    // The switch refreshes the page in place and the streamed <title> can be gone for a moment;
    // axe then reports «document-title». Load the English page whole (the choice is a cookie).
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  }
  // Under a loaded CI box the metrics answer and the charts can take a while: wait for both.
  await expect(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
}

for (const run of RUNS) {
  test(`dashboard ${run.width}px ${run.lang}: fits and passes axe`, async ({ page }) => {
    await open(page, run.width, run.lang, '/?range=last_12_months&compare=1');
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
  });
}

test('the range bar writes the URL; compare names the API’s period (1440, English)', async ({
  page,
}) => {
  await open(page, 1440, 'en');
  const bar = page.getByRole('region', { name: 'Time range' });
  await bar.getByRole('combobox', { name: 'Period' }).click();
  await page.getByRole('option', { name: 'Last 12 months' }).click();
  await expect(page).toHaveURL(/range=last_12_months/);
  await bar.getByRole('switch', { name: 'Compare with the previous period' }).click();
  await expect(page).toHaveURL(/compare=1/);
  await expect(bar.getByRole('status')).toContainText('vs ');
  // A card opens its list.
  await expect(page.getByRole('link', { name: /^Net profit/ })).toHaveAttribute(
    'href',
    /report=profit-and-loss&from=/,
  );
});

test('D3 widgets at 375 (Arabic): the owner sees every chart and the teacher pay total', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/login?next=%2F');
  await login(page);
  await page.waitForURL((u) => u.pathname === '/');
  const dash = page.getByRole('region', { name: 'لوحة المؤشرات' });
  for (const title of [
    'أعمار الديون المتأخرة',
    'العملاء المحتملون حسب المصدر',
    'أسباب فقد العملاء',
    'ساعات التدريس',
  ]) {
    await expect(dash.getByRole('heading', { level: 3, name: title })).toBeVisible();
  }
  await expect(dash.getByText(/رواتب المعلمين في الفترة: \$/)).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);
});

test('D3 at 375 (Arabic): accounts see the ageing and the collection rate, never teacher pay', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/login?next=%2F');
  await login(page, 'accounts@qarabic.test');
  await page.waitForURL((u) => u.pathname === '/');
  const dash = page.getByRole('region', { name: 'لوحة المؤشرات' });
  await page.waitForURL((u) => u.pathname === '/');
  await expect(
    dash.getByRole('heading', { level: 3, name: 'أعمار الديون المتأخرة' }),
  ).toBeVisible();
  await expect(dash.getByRole('link', { name: /^نسبة التحصيل/ })).toBeVisible();
  await expect(dash.getByRole('heading', { level: 3, name: 'ساعات التدريس' })).toHaveCount(0);
  await expect(dash.getByText(/رواتب المعلمين/)).toHaveCount(0);
});
