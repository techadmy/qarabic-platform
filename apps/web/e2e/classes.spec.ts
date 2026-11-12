import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * N2 schedule and classes against the MSW mocks (production build, mocks on). The mock data is
 * built from the real clock: today's board has past, running, late and upcoming classes. Steps
 * that change data stay in one page (client navigation), since a reload rebuilds the mocks.
 */

async function signIn(page: Page, email = 'admin@qarabic.test', path = '/') {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page, email);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[?]/g, '\\?')}$`));
}

function cairoKey(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(d);
}

/** «6:00 م» of an instant in Cairo, as the app writes it. */
function cairoClock(ms: number) {
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Africa/Cairo',
  }).format(new Date(ms));
}

async function boardRows(page: Page): Promise<Locator> {
  const table = page.getByRole('table', { name: 'حصص اليوم' });
  await expect(table.locator('tr[data-session-id]').first()).toBeVisible();
  return table.locator('tr[data-session-id]');
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'حسابي' }).click();
  await page.getByRole('menuitem', { name: 'تسجيل الخروج' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test('staff: Today board → mark a class → undo', async ({ page }) => {
  await signIn(page, 'admin@qarabic.test', `/today?date=${cairoKey(1)}`);
  // The first «مجدولة» class (the mock day can open with a held one), pinned by its id so the
  // locator survives the status change.
  const rows = await boardRows(page);
  const id = await rows.filter({ hasText: 'مجدولة' }).first().getAttribute('data-session-id');
  const row = rows.and(page.locator(`[data-session-id="${id}"]`));
  const name = (await row.getByRole('button').first().textContent())!.trim();
  await expect(row.getByText('مجدولة')).toBeVisible();
  await row.getByRole('button', { name: `إجراءات أخرى: ${name}` }).click();
  await page.getByRole('menuitem', { name: 'تسجيل إجازة' }).click();
  const dialog = page.getByRole('dialog', { name: `تسجيل إجازة ${name}` });
  await dialog.getByLabel(/ملاحظة/).fill('Family trip');
  await dialog.getByRole('button', { name: 'تسجيل إجازة' }).click();
  await expect(page.getByText(`سُجّلت إجازة ${name}`)).toBeVisible();
  await expect(row.getByText('إجازة', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'تراجع' }).click();
  await expect(page.getByText('أُعيدت الحالة السابقة')).toBeVisible();
  await expect(row.getByText('مجدولة')).toBeVisible();

  // The class opens in the sheet with its timeline (the leave and its undo are logged).
  await row.getByRole('button', { name }).first().click();
  const sheet = page.getByRole('dialog', { name: 'تفاصيل الحصة' });
  await expect(sheet.getByText('سجل الحصة')).toBeVisible();
  await expect(sheet.getByText('أُعيدت إلى مجدولة')).toBeVisible();
  await expect(page).toHaveURL(/session=\d+/);
});

test('staff: create an enrollment with weekly times (warning acknowledged)', async ({ page }) => {
  await signIn(page, 'admin@qarabic.test', '/schedule');
  await page.getByRole('link', { name: 'اشتراك جديد' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'اشتراك جديد' })).toBeVisible();

  // Step 1: the demo parent's child Ali (New York) with Ahmed Fathy.
  await page.getByRole('combobox', { name: /الطالب/ }).click();
  await page.getByPlaceholder('ابحث باسم الطالب').fill('Ali');
  await page.getByRole('option', { name: /^Ali\s?New York$/ }).click();
  await expect(page.getByText('المواعيد بتوقيت العائلة: نيويورك')).toBeVisible();
  await page.getByRole('combobox', { name: /المعلم/ }).click();
  await page.getByPlaceholder('ابحث باسم المعلم').fill('Ahmed');
  await page.getByRole('option', { name: /Ahmed Fathy/ }).click();
  await page.getByRole('combobox', { name: /الدورة/ }).click();
  await page.getByRole('option').first().click();
  await page.getByLabel(/رابط الاجتماع/).fill('https://meet.example.com/e2e-class');
  await page.getByRole('button', { name: 'التالي' }).click();

  // Step 2: Saturday 8:00 pm New York = 3:00 am Cairo, outside the teacher's work hours.
  await expect(page.getByText('لم تُضف مواعيد بعد.')).toBeVisible();
  await page.getByRole('combobox', { name: /^الوقت/ }).click();
  await page.getByRole('option', { name: '8:00 م' }).click();
  await page.getByRole('button', { name: 'أضف الموعد' }).click();
  await expect(page.getByText('المعلم: الأحد 3:00 ص (القاهرة)')).toBeVisible();
  const tick = page.getByRole('checkbox', { name: 'خارج ساعات عمل المعلم' });
  await expect(tick).toBeVisible();
  await page.getByRole('button', { name: 'التالي' }).click();
  await expect(page.getByText('راجع قبل الإنشاء')).toBeHidden();
  await tick.click();
  await page.getByRole('button', { name: 'التالي' }).click();

  // Step 3: review, create, land on the enrollment with its weekly time.
  await expect(page.getByText('راجع قبل الإنشاء')).toBeVisible();
  await page.getByRole('button', { name: 'أنشئ الاشتراك' }).click();
  await expect(page).toHaveURL(/\/schedule\/\d+$/);
  await expect(page.getByText('أُنشئ الاشتراك')).toBeVisible();
  const slots = page.getByRole('list', { name: 'المواعيد الأسبوعية' });
  await expect(slots.getByText(/السبت 8:00 م \(نيويورك\)/)).toBeVisible();
  await expect(slots.getByText('المعلم: الأحد 3:00 ص (القاهرة)')).toBeVisible();
});

test('parent requests a leave → staff approves it', async ({ page }) => {
  await signIn(page, 'parent@qarabic.test', '/');
  await page.getByRole('link', { name: 'حصص أبنائي' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'حصص أبنائي' })).toBeVisible();

  // The child's class that starts in 90 minutes (too late for an automatic approval).
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  const times = [-1, 0, 1].map((d) => cairoClock(minute + (90 + d) * 60_000));
  // count() does not wait: let the week's classes render first, or every count reads 0 and the
  // test jumps to next week while this week's rows are still arriving (CI flake).
  const rows = page.locator('tr[data-session-id]');
  await expect(rows.first()).toBeVisible();
  let row = rows.filter({ hasText: times[1]! });
  if (!(await row.count())) row = rows.filter({ hasText: times[0]! });
  if (!(await row.count())) {
    // Late in the week the class can fall into the next week.
    await page.getByRole('button', { name: 'الأسبوع التالي' }).click();
    row = rows.filter({ hasText: new RegExp(times.join('|')) });
    await expect(row.first()).toBeVisible();
  }
  row = row.first();
  const name = (await row.getByRole('button').first().textContent())!.trim();
  await row.getByRole('button', { name: `إجراءات أخرى: ${name}` }).click();
  await page.getByRole('menuitem', { name: 'طلب إجازة' }).click();
  const dialog = page.getByRole('dialog', { name: `طلب إجازة — ${name}` });
  await dialog.getByLabel(/السبب/).fill('Fever since the morning');
  await dialog.getByRole('button', { name: 'أرسل الطلب' }).click();
  await expect(page.getByText('أُرسل الطلب وهو قيد المراجعة')).toBeVisible();
  await expect(row.getByText('طلب قيد المراجعة')).toBeVisible();

  // Staff (same page: the mock data stays) approves it from the inbox.
  await signOut(page);
  await login(page, 'admin@qarabic.test');
  await page.getByRole('link', { name: 'طلبات الحصص' }).click();
  const card = page.getByRole('listitem').filter({ hasText: 'Fever since the morning' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: new RegExp(`^موافقة\\s*:\\s*${name}$`) }).click();
  const approve = page.getByRole('dialog', { name: `موافقة على طلب إجازة — ${name}` });
  await approve.getByRole('button', { name: 'وافق على الطلب' }).click();
  await expect(page.getByText('اعتُمد الطلب')).toBeVisible();
  await expect(card).toBeHidden();
  await page.getByRole('radio', { name: /^تم البت فيها/ }).click();
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'Fever since the morning' })
      .getByText('تمت الموافقة'),
  ).toBeVisible();
});

test('a teacher sees only their own classes', async ({ page }) => {
  await signIn(page, 'teacher@qarabic.test', '/');
  // «حصصي» is the teacher portal's week (N3).
  const week = page.waitForResponse(
    (r) => /\/api\/v1\/teacher-portal\/week/.test(r.url()) && r.status() === 200,
  );
  await page.getByRole('link', { name: 'حصصي', exact: true }).click();
  const body = (await (await week).json()) as {
    data: { days: { sessions: { teacher: { id: number } }[] }[] };
  };
  const rows = body.data.days.flatMap((d) => d.sessions);
  expect(rows.length).toBeGreaterThan(0);
  expect(new Set(rows.map((s) => s.teacher.id))).toEqual(new Set([1]));
  await expect(page.getByRole('heading', { level: 1, name: 'حصصي' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'المعلم' })).toHaveCount(0);
  // No company-wide pages for a teacher.
  await expect(page.getByRole('link', { name: 'حصص اليوم' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'الجدول' })).toHaveCount(0);
});

test.describe('phone (375 px)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('no horizontal scroll on the board, enrollment, requests and new enrollment', async ({
    page,
  }) => {
    await signIn(page, 'admin@qarabic.test', '/today');
    await expect(page.getByRole('list', { name: 'حصص اليوم' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.goto('/schedule/1');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('—');
    await expectNoHorizontalScroll(page);
    await page.goto('/requests');
    await expect(page.getByRole('list', { name: 'طلبات الحصص' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.goto('/schedule/new');
    await expect(page.getByRole('heading', { level: 1, name: 'اشتراك جديد' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test('accessibility: board, class detail, enrollment and requests', async ({ page }) => {
  await signIn(page, 'admin@qarabic.test', '/today');
  const row = (await boardRows(page)).first();
  await expectNoSeriousA11yViolations(page);
  await row.getByRole('button').first().click();
  await expect(
    page.getByRole('dialog', { name: 'تفاصيل الحصة' }).getByText('سجل الحصة'),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.goto('/schedule/1');
  await expect(page.getByRole('list', { name: 'المواعيد الأسبوعية' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.goto('/requests');
  await expect(page.getByRole('list', { name: 'طلبات الحصص' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
