import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations, login } from './helpers';

/**
 * N8: the app served under a path (`api.qarabic.com/app/`). Runs only with `E2E_BASE_PATH=/app`
 * (the config builds with NEXT_PUBLIC_BASE_PATH and runs this spec alone):
 * `E2E_BASE_PATH=/app E2E_PORT=3250 pnpm --filter @qarabic/web test:e2e`.
 * Navigation is by clicking, so every link, redirect and asset is checked under the path.
 */
const BP = process.env.E2E_BASE_PATH ?? '';
test.skip(!BP, 'E2E_BASE_PATH not set');

test('login, sidebar navigation, images and requests all stay under the base path', async ({
  page,
}) => {
  const outside: string[] = [];
  const broken: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    // The API stays at the host root (`/api/v1`, `/api/class-request`), like on api.qarabic.com.
    const ok =
      url.pathname === BP || url.pathname.startsWith(`${BP}/`) || url.pathname.startsWith('/api/');
    if (url.hostname === 'localhost' && !ok) outside.push(url.pathname);
  });
  page.on('response', (r) => {
    // 401 = the signed-out check before login (expected).
    if (r.status() >= 400 && r.status() !== 401 && new URL(r.url()).hostname === 'localhost')
      broken.push(`${r.status()} ${r.url()}`);
  });

  // An unauthenticated deep link goes to the login page under the path, then back after login.
  await page.goto(`${BP}/families`);
  await expect(page).toHaveURL(new RegExp(`${BP}/login`));
  await login(page);
  await expect(page).toHaveURL(new RegExp(`${BP}/families$`));
  await expect(page.locator('main h1').first()).toBeVisible();

  // Sidebar links keep the path.
  await page.getByRole('link', { name: 'حصص اليوم' }).first().click();
  await expect(page).toHaveURL(new RegExp(`${BP}/today$`));
  await page.getByRole('link', { name: 'الفواتير' }).first().click();
  await expect(page).toHaveURL(new RegExp(`${BP}/invoices$`));
  await page.getByRole('link', { name: 'Qarabic' }).first().click();
  await expect(page).toHaveURL(new RegExp(`${BP}/?$`));

  // The logo images load (next/image string sources need the path by hand).
  const logo = page.getByRole('img', { name: 'Qarabic' }).first();
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  await expectNoSeriousA11yViolations(page);
  expect(outside, 'requests outside the base path').toEqual([]);
  expect(broken, 'failed requests').toEqual([]);
});
