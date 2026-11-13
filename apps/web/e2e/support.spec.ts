import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * N4 support centre against the MSW mocks (production build, mocks on). The mock data is built
 * from the clock when the page loads, so a reload rebuilds it: flows that change data and then
 * switch users stay in one page (client navigation, sign out and in again).
 */

async function signIn(page: Page, email: string, path = '/') {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page, email);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[?]/g, '\\?')}$`));
}

async function signOutAndIn(page: Page, email: string) {
  await page.getByRole('button', { name: 'حسابي' }).click();
  await page.getByRole('menuitem', { name: 'تسجيل الخروج' }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page, email);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

const contactButton = (page: Page) =>
  page.getByRole('button', { name: 'تواصل معنا' }).filter({ visible: true }).first();

test('parent: «تواصل معنا» → a class → «مشكلة في هذه الحصة» with context → in «طلباتي»', async ({
  page,
}) => {
  await signIn(page, 'parent@qarabic.test');
  await expect(
    page.getByRole('heading', { level: 1, name: 'مرحبًا، ولي أمر تجريبي' }),
  ).toBeVisible();
  await contactButton(page).click();
  const hub = page.getByRole('dialog', { name: 'تواصل معنا' });
  await expect(hub.getByRole('heading', { name: 'بخصوص ماذا؟' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await hub.getByRole('button', { name: /^الحصص والمواعيد/ }).click();
  await page
    .getByRole('button', { name: /^مشكلة في هذه الحصة · / })
    .first()
    .click();
  const form = page.getByRole('dialog', { name: 'مشكلة في حصة' });
  await expect(form.getByText(/^الحصة:/)).toBeVisible();
  await form.getByLabel(/ما المشكلة في هذه الحصة؟/).fill('The teacher could not hear us today.');
  await form.getByRole('button', { name: 'أرسل' }).click();
  await expect(page.getByText(/أُرسل طلبك رقم #9/).first()).toBeVisible();

  await page.getByRole('link', { name: 'طلباتي', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'طلباتي' })).toBeVisible();
  const list = page.getByRole('list', { name: 'طلباتي' });
  await expect(
    list.getByRole('link', { name: /#9 · The teacher could not hear us today/ }),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await list.getByRole('link', { name: /#9 · / }).click();
  await expect(page.getByRole('heading', { level: 1, name: /#9/ })).toBeVisible();
  await expect(page.getByText('الحصة #', { exact: false }).first()).toBeVisible();
  await expect(
    page.getByText('بانتظار رد الفريق').or(page.getByText('لم يُحدَّد بعد؛ سنراجعه قريبًا')),
  ).toBeVisible();
});

test('staff take → reply → fixed in the inbox; the parent confirms the fix', async ({ page }) => {
  await signIn(page, 'admin@qarabic.test', '/support');
  await expect(page.getByRole('heading', { level: 1, name: 'صندوق الطلبات' })).toBeVisible();
  // D141: seven queue views live in the title's views menu.
  await page.getByRole('button', { name: /كل الأقسام\s*تغيير العرض/ }).click();
  await expect(
    page.getByRole('menuitemradio', { name: /الحسابات والفواتير\s*متأخرة: 1/ }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  const list = page.getByRole('list', { name: 'صندوق الطلبات' });
  const row = list.getByRole('listitem').filter({ hasText: '#2 · I paid the November invoice' });
  // Overdue first.
  await expect(list.getByRole('listitem').first()).toContainText('#2 · I paid');
  await expect(row.getByText(/^متأخر /)).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await row.getByRole('button', { name: /^استلام\s?: #2$/ }).click();
  await expect(page.getByText('استلمتَ الطلب.')).toBeVisible();
  await expect(row.getByText('المسؤول: مدير النظام')).toBeVisible();

  await row.getByRole('button', { name: /^رد\s?: #2$/ }).click();
  const reply = page.getByRole('dialog', { name: 'الرد على الطلب #2' });
  await reply.getByLabel('نص الرد').fill('We found your payment; we are updating the invoice.');
  await reply.getByRole('button', { name: 'إرسال' }).click();
  await expect(page.getByText('أُرسل الرد.')).toBeVisible();

  for (const status of ['قيد التنفيذ', 'تم الحل (بانتظار التأكيد)']) {
    await row.getByRole('button', { name: /^تغيير الحالة\s?: #2$/ }).click();
    const dialog = page.getByRole('dialog', { name: /الحالة الجديدة|نقل الطلب/ });
    await dialog.getByRole('combobox', { name: 'الحالة الجديدة' }).click();
    await page.getByRole('option', { name: status }).click();
    if (status !== 'قيد التنفيذ') {
      await dialog.getByLabel(/ملاحظة لمقدّم الطلب/).fill('The invoice now shows as paid.');
    }
    await dialog.getByRole('button', { name: 'نقل' }).click();
    await expect(dialog).toBeHidden();
  }
  await expect(row.getByText('تم الحل (بانتظار التأكيد)')).toBeVisible();

  await signOutAndIn(page, 'parent@qarabic.test');
  await page.getByRole('link', { name: 'طلباتي', exact: true }).click();
  const mine = page.getByRole('list', { name: 'طلباتي' });
  const two = mine.getByRole('listitem').filter({ hasText: '#2 · I paid' });
  await expect(two.getByText('تحديث جديد')).toBeVisible();
  await two.getByRole('link', { name: /#2 · / }).click();
  await expect(page.getByText('We found your payment; we are updating the invoice.')).toBeVisible();
  await expect(page.getByText('هل حُلّت المشكلة؟')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'نعم، حُلّت' }).click();
  await expect(page.getByText('شكرًا لتأكيدك.')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1 }).locator('..').getByText('مغلق'),
  ).toBeVisible();
});

test('a teacher never sees a complaint about them, nor the inbox', async ({ page }) => {
  await signIn(page, 'teacher@qarabic.test', '/tickets/3');
  await expect(page.getByText('هذا الطلب غير موجود أو ليس لك')).toBeVisible();
  await expect(page.getByText(/late twice/)).toHaveCount(0);
  await page.goto('/my-requests');
  await expect(page.getByRole('list', { name: 'طلباتي' })).toBeVisible();
  await expect(page.getByText(/late twice/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'صندوق الطلبات' })).toHaveCount(0);
  await page.goto('/support');
  await expect(page.getByText('ليست لديك صلاحية', { exact: true })).toBeVisible();
});

test('parent at 375 px: home, «تواصل معنا» and «طلباتي» fit without sideways scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, 'parent@qarabic.test');
  await expect(page.getByRole('heading', { name: 'آخر تقارير الحصص' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);
  await contactButton(page).click();
  const hub = page.getByRole('dialog', { name: 'تواصل معنا' });
  await expect(hub.getByRole('button', { name: /^الفواتير والاشتراك/ })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.keyboard.press('Escape');
  await page.goto('/my-requests');
  await expect(page.getByRole('list', { name: 'طلباتي' })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('staff at 375 px: the inbox and a ticket fit; settings and triage pass axe', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, 'admin@qarabic.test', '/support');
  await expect(page.getByRole('list', { name: 'صندوق الطلبات' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.goto('/tickets/4');
  await expect(page.getByRole('heading', { level: 1, name: /#4/ })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/settings/support');
  await expect(page.getByRole('table', { name: 'الأقسام' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.goto('/feedback');
  await expect(page.getByRole('table', { name: 'فرز البلاغات' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('a parent (phone) asks to pause the subscription: dates and reason, then «طلباتي» (S3)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/login');
  await login(page, 'parent@qarabic.test');
  await page.getByRole('button', { name: 'تواصل معنا' }).filter({ visible: true }).first().click();
  const hub = page.getByRole('dialog', { name: 'تواصل معنا' });
  await hub.getByRole('button', { name: /الفواتير والاشتراك/ }).click();
  await page.getByRole('button', { name: 'إيقاف مؤقت أو إلغاء الاشتراك' }).click();
  const form = page.getByRole('dialog', { name: 'إيقاف مؤقت أو إلغاء الاشتراك' });
  await expect(form.getByRole('radio', { name: 'إيقاف مؤقت' })).toBeChecked();
  await form
    .getByRole('textbox')
    .last()
    .fill('We travel for the summer and will be back in August.');
  await form.getByRole('button', { name: 'أرسل' }).click();
  // The end of the pause and the reason are required.
  await expect(form.getByText('حدد نهاية الإيقاف المؤقت.')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await form.getByRole('button', { name: 'إلى' }).click();
  await page.getByRole('button', { name: 'اذهب إلى الشهر التالي' }).click();
  await page.getByRole('gridcell').filter({ hasText: /^20$/ }).first().getByRole('button').click();
  await form.getByRole('combobox', { name: 'السبب' }).click();
  await page.getByRole('option', { name: 'سفر' }).click();
  await form.getByRole('button', { name: 'أرسل' }).click();
  await expect(page.getByText(/أُرسل طلبك رقم #\d+/).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
});
