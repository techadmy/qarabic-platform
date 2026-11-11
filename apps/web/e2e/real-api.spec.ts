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

test('real API: families list → open one → edit a field (saved in the database)', async ({
  page,
}) => {
  const admin = seedAdmin();
  await page.goto('/families');
  await expect(page).toHaveURL(/\/login\?next=%2Ffamilies$/);
  await page.getByLabel('البريد الإلكتروني').fill(admin.email);
  await page.locator('#password').fill(admin.password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/families$/);

  // The seed's made-up demo families, with counts on the status tabs from meta.counts.
  const table = page.getByRole('table', { name: 'العائلات' });
  await expect(table).not.toHaveAttribute('aria-busy');
  await expect(table.getByRole('row').nth(1)).toBeVisible();
  await expect(page.getByRole('radio', { name: /^الكل/ })).toHaveText(/\(\d+\)/);

  const first = table.getByRole('row').nth(1).getByRole('link').first();
  const name = (await first.textContent())!.trim();
  await first.click();
  await expect(page).toHaveURL(/\/families\/\d+$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name);

  const zoom = `E2E ${Date.now() % 1_000_000}`;
  await page.getByRole('button', { name: 'تعديل', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'تعديل بيانات العائلة' });
  await sheet.getByLabel(/معرّف Zoom/).fill(zoom);
  await sheet.getByRole('button', { name: 'حفظ' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText(zoom)).toBeVisible();

  // Still there after a reload: it came back from the API, not from the cache.
  await page.reload();
  await expect(page.getByText(zoom)).toBeVisible();
});

test('real API: Today board on real data → open a class', async ({ page }) => {
  const admin = seedAdmin();
  await page.goto('/today');
  await expect(page).toHaveURL(/\/login\?next=%2Ftoday$/);
  await page.getByLabel('البريد الإلكتروني').fill(admin.email);
  await page.locator('#password').fill(admin.password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole('heading', { level: 1, name: 'حصص اليوم' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'عدادات اليوم' })).toBeVisible();

  // The seed's demo weekly times: find the next day with classes (at most a week ahead).
  const rows = page.locator('tr[data-session-id]');
  for (let i = 0; i < 7; i++) {
    await expect(rows.first().or(page.getByText('لا توجد حصص في هذا اليوم'))).toBeVisible();
    if (await rows.count()) break;
    await page.getByRole('button', { name: 'اليوم التالي' }).click();
  }
  const row = rows.first();
  await expect(row).toBeVisible();
  const name = (await row.getByRole('button').first().textContent())!.trim();
  await row.getByRole('button', { name }).first().click();
  await expect(page).toHaveURL(/session=\d+/);
  const sheet = page.getByRole('dialog', { name: 'تفاصيل الحصة' });
  await expect(sheet.getByText(name).first()).toBeVisible();
  await expect(sheet.getByText('سجل الحصة')).toBeVisible();
  await expect(sheet.getByText('إثبات الحضور')).toBeVisible();
});

test('real API: the N2 pages load real data (the shared schemas parse every answer)', async ({
  page,
}) => {
  const admin = seedAdmin();
  await page.goto('/login?next=%2Fschedule');
  await page.getByLabel('البريد الإلكتروني').fill(admin.email);
  await page.locator('#password').fill(admin.password);
  await page.getByRole('button', { name: 'دخول' }).click();
  await expect(page).toHaveURL(/\/schedule$/);
  const table = page.getByRole('table', { name: 'الاشتراكات' });
  await expect(table.locator('tbody tr').first()).toBeVisible();
  await table.locator('tbody tr').first().getByRole('link').first().click();
  await expect(page).toHaveURL(/\/schedule\/\d+$/);
  await expect(page.getByRole('list', { name: 'المواعيد الأسبوعية' })).toBeVisible();
  await page.getByRole('link', { name: 'جدول المعلم' }).click();
  await expect(page).toHaveURL(/\/teachers\/\d+\/timetable$/);
  await expect(page.getByRole('table', { name: 'المواعيد الأسبوعية' })).toBeVisible();
  for (const [path, check] of [
    [
      '/requests',
      page
        .getByRole('list', { name: 'طلبات الحصص' })
        .or(page.getByText('لا توجد طلبات قيد المراجعة')),
    ],
    [
      '/holidays',
      page.getByRole('table', { name: 'العطلات الرسمية' }).or(page.getByText(/لا توجد عطلات في/)),
    ],
    ['/settings/sessions', page.getByLabel('تُنشأ الحصص مسبقًا لمدة')],
  ] as const) {
    await page.goto(path);
    await expect(check).toBeVisible();
    await expect(page.getByText('تعذّر تحميل البيانات')).toHaveCount(0);
  }
});
