import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Integration check against the real API and its dev database (opt-in: `pnpm test:e2e:real`).
 * The seed admin comes from E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD, or from SEED_ADMIN_* in
 * apps/api/.env (never committed, never printed).
 */
test.skip(process.env.E2E_REAL_API !== '1', 'set E2E_REAL_API=1 (needs the API and Postgres)');

function seedAdmin(): { email: string; password: string } {
  const fromEnv = { email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD };
  if (fromEnv.email && fromEnv.password) return fromEnv as { email: string; password: string };
  const file = fileURLToPath(new URL('../../api/.env', import.meta.url));
  const vars = Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1], m[2]!.replace(/^(['"])(.*)\1$/, '$2')]),
  );
  return { email: vars.SEED_ADMIN_EMAIL, password: vars.SEED_ADMIN_PASSWORD };
}

test('real API: login → home → roles → logout', async ({ page }) => {
  const admin = seedAdmin();
  expect(admin.email, 'seed admin email').toBeTruthy();

  await page.goto('/roles');
  await expect(page).toHaveURL(/\/login\?next=%2Froles$/);
  await page.getByLabel('البريد الإلكتروني').fill(admin.email);
  await page.locator('#password').fill(admin.password);
  await page.getByRole('button', { name: 'دخول' }).click();

  // Back to the deep link with the real roles from the database.
  await expect(page).toHaveURL(/\/roles$/);
  const table = page.getByRole('table', { name: 'الأدوار' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(10); // header + 9 system roles
  await expect(table.getByText('مشرف متابعة')).toBeVisible();

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('مرحبًا');

  await page.getByRole('button', { name: 'حسابي' }).click();
  await page.getByRole('menuitem', { name: 'تسجيل الخروج' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});

test('real API: wrong password shows the invalid-credentials message', async ({ page }) => {
  const admin = seedAdmin();
  await page.goto('/login');
  await page.getByLabel('البريد الإلكتروني').fill(admin.email);
  await page.locator('#password').fill('definitely-not-the-password');
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page.getByText('البريد الإلكتروني أو كلمة المرور غير صحيحة.')).toBeVisible();
});
