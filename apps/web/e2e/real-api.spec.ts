import { expect, test } from '@playwright/test';
import { REAL_API, seedAdmin, signInReal } from './real-api-helpers';

/**
 * Integration check against the real API and its dev database (opt-in: `pnpm test:e2e:real`).
 * The seed admin comes from E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD, or from SEED_ADMIN_* in
 * apps/api/.env (never committed, never printed). Only the first two tests sign in through the form;
 * the rest share one session (`signInReal`: 5 logins a minute per email). The N3–N7 write flows
 * are in real-api-flows.spec.ts.
 */
test.skip(!REAL_API, 'set E2E_REAL_API=1 (needs the API and Postgres)');

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
  await signInReal(page, '/families');

  // The seed's made-up demo families, with counts on the status tabs from meta.counts.
  const table = page.getByRole('table', { name: 'العائلات' });
  await expect(table).not.toHaveAttribute('aria-busy');
  await expect(table.getByRole('row').nth(1)).toBeVisible();
  await expect(page.getByRole('radio', { name: /^الكل/ })).toHaveText(/\(\d+\)/);

  // A seed family (the flows spec adds converted families without a phone, which the edit form
  // cannot save yet: docs/31 «family edit with no phone»).
  await page.getByRole('searchbox', { name: 'بحث في العائلات' }).fill('Demo Parent');
  await expect(page).toHaveURL(/q=Demo/);
  await expect(table).not.toHaveAttribute('aria-busy');
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
  await signInReal(page, '/today');
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
  await signInReal(page, '/schedule');
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

test('real API: open a class with a lesson report; tests and progress load (N3)', async ({
  page,
}) => {
  await signInReal(page, '/lesson-reports');

  // The seed's reports: a class whose report was sent (on time or late).
  const table = page.getByRole('table', { name: 'تقارير الحصص' });
  await expect(page.getByRole('radio', { name: /^الكل/ })).toHaveText(/\(\d+\)/);
  let state = 'سُلّم في موعده';
  await page.getByRole('radio', { name: /^سُلّم في موعده/ }).click();
  await expect(page).toHaveURL(/state=on_time/);
  const sent = table.locator('tbody tr').filter({ hasText: state });
  await expect(sent.first().or(page.getByText('لا نتائج مطابقة'))).toBeVisible();
  if (!(await sent.count())) {
    state = 'سُلّم متأخرًا';
    await page.getByRole('radio', { name: /^سُلّم متأخرًا/ }).click();
  }
  const row = table.locator('tbody tr').filter({ hasText: state }).first();
  await expect(row).toBeVisible();
  const name = (await row.getByRole('button').first().textContent())!.trim();
  await row.getByRole('button', { name }).first().click();
  const sheet = page.getByRole('dialog', { name: 'تفاصيل الحصة' });
  await expect(sheet.getByText(name).first()).toBeVisible();
  const report = sheet.getByRole('region', { name: 'تقرير الحصة' });
  await expect(report).toBeVisible();
  await expect(report.getByText('ملخص الحصة')).toBeVisible();
  await expect(report.getByText(/أرسله /)).toBeVisible();

  // Tests and the student's progress parse with the shared schemas.
  await page.goto('/tests');
  await expect(page.getByRole('navigation', { name: 'عدادات الشهر' })).toBeVisible();
  await expect(page.getByText('تعذّر تحميل البيانات')).toHaveCount(0);
  await page.goto('/students');
  await page.getByRole('table', { name: 'الطلاب' }).locator('tbody tr a').first().click();
  await expect(page.getByRole('region', { name: /التقدم وسجل الدروس/ })).toBeVisible();
  await expect(page.getByText('تعذّر تحميل البيانات')).toHaveCount(0);
});

test('real API: the N4 support centre — inbox, a ticket, triage, settings, «تواصل معنا» → «طلباتي»', async ({
  page,
}) => {
  await signInReal(page, '/support');

  // The seed's demo tickets, with the queue tabs and their counts (the shared schemas parse them).
  await expect(page.getByRole('heading', { level: 1, name: 'صندوق الطلبات' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /^الجدولة \(\d+\)/ })).toBeVisible();
  const list = page.getByRole('list', { name: 'صندوق الطلبات' });
  await expect(list.getByRole('listitem').first()).toBeVisible();
  await expect(page.getByText('تعذّر تحميل البيانات')).toHaveCount(0);
  await list.locator('a[href^="/tickets/"]').first().click();
  await expect(page).toHaveURL(/\/tickets\/\d+$/);
  await expect(page.getByRole('heading', { level: 1, name: /#\d+/ })).toBeVisible();
  await expect(page.getByText('معالجة الطلب')).toBeVisible();

  for (const [path, check] of [
    ['/feedback', page.getByRole('table', { name: 'فرز البلاغات' })],
    ['/settings/support', page.getByRole('table', { name: 'الأقسام' })],
  ] as const) {
    await page.goto(path);
    await expect(check).toBeVisible();
    await expect(page.getByText('تعذّر تحميل البيانات')).toHaveCount(0);
  }

  // «تواصل معنا» → a suggestion is saved in the database and shows in «طلباتي».
  const text = `E2E suggestion ${Date.now() % 1_000_000}`;
  await page.getByRole('button', { name: 'تواصل معنا' }).filter({ visible: true }).first().click();
  await page
    .getByRole('dialog', { name: 'تواصل معنا' })
    .getByRole('button', { name: /^اقتراح/ })
    .click();
  const report = page.getByRole('dialog', { name: 'مشكلة تقنية أو اقتراح' });
  await expect(report.getByText('جارٍ التقاط صورة الشاشة…')).toHaveCount(0, { timeout: 15_000 });
  await report.getByLabel(/ما اقتراحك؟/).fill(text);
  await report.getByRole('button', { name: 'أرسل' }).click();
  await expect(page.getByText(/أُرسل طلبك رقم #\d+/).first()).toBeVisible();
  await page.goto('/my-requests');
  await expect(page.getByRole('list', { name: 'طلباتي' }).getByText(text)).toBeVisible();
});
