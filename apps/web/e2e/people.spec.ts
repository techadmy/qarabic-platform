import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/** N1 people and roles against the MSW mocks (production build, mocks on). */

async function signIn(page: Page, email = 'admin@qarabic.test', path = '/') {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page, email);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[?]/g, '\\?')}$`));
}

async function pick(page: Page, combobox: string, search: string, option: RegExp) {
  await page.getByRole('dialog').first().getByRole('combobox', { name: combobox }).click();
  await page.getByRole('dialog').last().getByRole('combobox').fill(search);
  await page.getByRole('option', { name: option }).first().click();
}

test('family: add → in the list → profile → edit → status with reason → archive → restore', async ({
  page,
}) => {
  await signIn(page, 'admin@qarabic.test', '/families');
  await expect(page.getByRole('table', { name: 'العائلات' })).toBeVisible();

  // Add (sheet, shared schema, dial code → E.164, searchable time zone).
  await page.getByRole('button', { name: 'أضف عائلة' }).click();
  const sheet = page.getByRole('dialog', { name: 'عائلة جديدة' });
  await expect(sheet.getByLabel(/اسم ولي الأمر/)).toBeVisible();
  await sheet.getByLabel(/اسم ولي الأمر/).fill('E2E Parent');
  await sheet.getByLabel(/البريد الإلكتروني/).fill('e2e.parent@example.com');
  await pick(page, 'رمز الدولة', 'المملكة المتحدة', /المملكة المتحدة \(\+44\)/);
  await sheet.getByLabel(/^الهاتف/).fill('07700 900777');
  await pick(page, 'المنطقة الزمنية', 'لندن', /لندن/);
  await sheet.getByRole('button', { name: 'إنشاء' }).click();
  await expect(page).toHaveURL(/\/families\/100$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('E2E Parent');
  await expect(page.getByText('+447700900777')).toBeVisible();

  // Back to the list: it shows up in a search.
  await page.getByRole('link', { name: 'الرجوع إلى العائلات' }).click();
  await page.getByRole('searchbox', { name: 'بحث في العائلات' }).fill('E2E Parent');
  await expect(page).toHaveURL(/q=E2E/);
  const row = page
    .getByRole('table', { name: 'العائلات' })
    .getByRole('link', { name: 'E2E Parent' });
  await expect(row).toBeVisible();
  await row.click();
  // From 1024 px the name opens the split view (D141 §1); the record's own page is one click on.
  await expect(page).toHaveURL(/[?&]id=100/);
  await page.getByRole('link', { name: 'فتح في صفحة كاملة' }).click();
  await expect(page).toHaveURL(/\/families\/100$/);

  // Edit one field.
  await page.getByRole('button', { name: 'تعديل', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'تعديل بيانات العائلة' });
  await edit.getByLabel(/معرّف Zoom/).fill('812 345 6789');
  await edit.getByRole('button', { name: 'حفظ' }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByText('812 345 6789')).toBeVisible();

  // Status with a reason (deactivated needs one).
  await page.getByRole('button', { name: 'تغيير الحالة' }).click();
  const status = page.getByRole('dialog', { name: 'تغيير حالة E2E Parent' });
  await status.getByRole('radio', { name: 'غير نشطة' }).click();
  await status.getByRole('button', { name: 'ألغِ تفعيل الحساب' }).click();
  await expect(status.getByText('اكتب السبب (3 أحرف على الأقل)')).toBeVisible();
  await status.getByLabel(/السبب/).fill('Finished the course');
  await status.getByRole('button', { name: 'ألغِ تفعيل الحساب' }).click();
  await expect(status).toBeHidden();
  // The status history is the profile's «السجل» tab (D141 §7).
  await page.getByRole('tab', { name: 'السجل' }).click();
  await expect(page.getByText('من «منتظمة» إلى «غير نشطة»')).toBeVisible();

  // Archive with a reason → read-only banner → restore.
  await page.getByRole('button', { name: 'إجراءات أخرى' }).click();
  await page.getByRole('menuitem', { name: 'حذف' }).click();
  const archive = page.getByRole('alertdialog', { name: 'حذف E2E Parent؟' });
  await archive.getByLabel(/سبب الحذف/).fill('Test record');
  await archive.getByRole('button', { name: 'احذف' }).click();
  await expect(page.getByText('سجل محذوف (في الأرشيف)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'تغيير الحالة' })).toHaveCount(0);
  await page.getByRole('button', { name: /استعادة/ }).click();
  await expect(page.getByText('سجل محذوف (في الأرشيف)')).toBeHidden();
  await expect(page.getByRole('button', { name: 'تغيير الحالة' })).toBeVisible();
});

test('roles: edit a preset role and save after the confirmation', async ({ page }) => {
  await signIn(page, 'admin@qarabic.test', '/roles');
  await page
    .getByRole('table', { name: 'الأدوار' })
    .getByRole('link', { name: 'مشرف متابعة', exact: true })
    .click();
  await expect(page).toHaveURL(/\/roles\/4$/);
  const families = page.getByRole('group', { name: 'العائلات والطلاب' });
  await families.getByRole('checkbox', { name: /^إدارة/ }).click();
  await expect(page.getByText('تغيير واحد لم يُحفظ')).toBeVisible();
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'احفظ التغييرات' }).click();
  await expect(page.getByText('لا توجد تغييرات')).toBeVisible();
  await expect(families.getByRole('checkbox', { name: /^إدارة/ })).toBeChecked();
});

test('a teacher gets «طلابي» with only their students', async ({ page }) => {
  await signIn(page, 'teacher@qarabic.test');
  const menu = page.locator('[data-sidebar="content"]');
  await expect(menu.getByRole('link')).toHaveText([
    'الرئيسية',
    'حصصي',
    'طلابي',
    'جدولي',
    'الاختبارات',
    'حضوري وإجازاتي',
    'راتبي',
    'طلباتي',
  ]);
  await menu.getByRole('link', { name: 'طلابي' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'طلابي' })).toBeVisible();
  const table = page.getByRole('table', { name: 'طلابي' });
  await expect(table.getByRole('link', { name: 'Ali', exact: true })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'المعلم' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'أضف طالبًا' })).toHaveCount(0);
});

test('a parent gets «عائلتي» with their children', async ({ page }) => {
  await signIn(page, 'parent@qarabic.test');
  await page.locator('[data-sidebar="content"]').getByRole('link', { name: 'عائلتي' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('ولي أمر تجريبي');
  await expect(page.getByRole('table', { name: 'أبناء العائلة' }).getByRole('link')).toHaveText([
    'Ali',
    'Mariam',
  ]);
  await expect(page.getByRole('button', { name: 'تعديل', exact: true })).toHaveCount(0);
});

test.describe('mobile 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('no horizontal scroll on the lists, profiles, sheet, roles and account', async ({
    page,
  }) => {
    await signIn(page, 'admin@qarabic.test', '/families');
    // Phone layout: rows as cards, not a table.
    await expect(page.getByRole('list', { name: 'العائلات' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    for (const path of [
      '/students',
      '/teachers',
      '/staff',
      '/families/2',
      '/teachers/1',
      '/roles',
      '/roles/4',
      '/account',
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalScroll(page);
    }
    await page.goto('/families/2');
    await page.getByRole('button', { name: 'تعديل', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'تعديل بيانات العائلة' });
    await expect(sheet.getByLabel(/اسم ولي الأمر/)).toBeVisible();
    // Full screen on phones.
    await expect.poll(async () => Math.round((await sheet.boundingBox())?.width ?? 0)).toBe(375);
    await expectNoHorizontalScroll(page);
  });
});

// Nine axe runs used to share one test and outgrew the 30 s budget on the CI runner (it failed on
// main): the lists and the profile flows are two tests now.
test.describe('accessibility (axe)', () => {
  test('lists: families, students, teachers, staff, roles', async ({ page }) => {
    await signIn(page, 'admin@qarabic.test', '/families');
    await expect(page.getByRole('table', { name: 'العائلات' }).getByRole('row')).toHaveCount(26);
    await expectNoSeriousA11yViolations(page);
    for (const [path, ready] of [
      ['/students', 'الطلاب'],
      ['/teachers', 'المعلمون'],
      ['/staff', 'الموظفون'],
      ['/roles', 'الأدوار'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('table', { name: ready })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoSeriousA11yViolations(page);
    }
  });

  test('profile, edit sheet, status dialog, a role and the account', async ({ page }) => {
    await signIn(page, 'admin@qarabic.test', '/families/2');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Yusuf Hassan');
    await page.waitForLoadState('networkidle');
    await expectNoSeriousA11yViolations(page);
    await page.getByRole('button', { name: 'تعديل', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel(/اسم ولي الأمر/)).toBeVisible();
    await page.waitForTimeout(400); // let the slide-in finish (contrast is checked on the final colours)
    await expectNoSeriousA11yViolations(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'تغيير الحالة' }).click();
    await page.getByRole('dialog').getByRole('radio', { name: 'معلّقة' }).click();
    await page.waitForTimeout(400);
    await expectNoSeriousA11yViolations(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    for (const path of ['/roles/4', '/account']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoSeriousA11yViolations(page);
    }
  });
});
