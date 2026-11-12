import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * N6 billing on the mock API (no provider is ever called; the mock's "provider page" is the app's
 * own return address): the monthly run → an invoice → a manual payment → paid; void with a reason;
 * a parent sees only their own invoices, pays by card and sees the checkout result; 375 px + axe.
 */
async function signIn(page: Page, email = 'admin@qarabic.test', path = '/invoices') {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page, email);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[?]/g, '\\?')}$`));
}

test('monthly run → open an invoice → record a manual payment → paid', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'الفواتير' })).toBeVisible();
  // D141: the amounts per currency sit in the summary, closed by default.
  await page.getByRole('button', { name: /إظهار التفاصيل/ }).click();
  await expect(page.getByRole('region', { name: 'ملخص المبالغ حسب العملة' })).toBeVisible();

  await page.getByRole('button', { name: 'إصدار فواتير الشهر' }).click();
  const run = page.getByRole('dialog', { name: 'إصدار الفواتير الشهرية' });
  await run.getByRole('button', { name: 'معاينة' }).click();
  await expect(run.getByRole('status')).toContainText('الفواتير التي ستُصدر');
  const preview = run.getByRole('table', { name: 'معاينة الفواتير' });
  await expect(preview.getByText('ستُصدر').first()).toBeVisible();
  // Family 4 has a child on a package with no AUD price: listed, not issued.
  await expect(preview.getByText('باقة بلا سعر بعملة الأسرة').first()).toBeVisible();
  await run.getByRole('button', { name: /^أصدر / }).click();
  await expect(page.getByText(/^أُصدرت .*(فاتورة|فواتير|فاتورتان)\.$/)).toBeVisible();
  await expect(run).toBeHidden();

  // The newest invoice is first; open it from its number.
  const table = page.getByRole('table', { name: 'الفواتير' });
  await table.getByRole('row').nth(1).getByRole('link').first().click();
  // D141: from 1024 px it opens beside the list; continue on the invoice's own page.
  await page.getByRole('link', { name: 'فتح في صفحة كاملة' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /INV-\d{4}-\d{6}/ })).toBeVisible();
  await expect(page.locator('main h1')).toContainText('مستحقة');

  await page.getByRole('button', { name: 'تسجيل دفعة' }).click();
  const pay = page.getByRole('dialog', { name: /تسجيل دفعة على الفاتورة/ });
  const amount = pay.getByRole('textbox', { name: /المبلغ/ });
  const balance = await amount.inputValue();
  expect(balance).toMatch(/^\d+\.\d{2}$/);
  // More than the balance is refused before it reaches the server.
  await amount.fill('999999');
  await pay.getByRole('button', { name: 'سجّل الدفعة' }).click();
  await expect(pay.getByText(/المبلغ أكبر من الرصيد المستحق/)).toBeVisible();
  await amount.fill(balance);
  await pay.getByRole('combobox', { name: /طريقة الدفع/ }).click();
  await page.getByRole('option', { name: 'نقدًا' }).click();
  await pay.getByRole('textbox', { name: 'رقم المرجع' }).fill('CASH-001');
  await pay.getByRole('button', { name: 'سجّل الدفعة' }).click();
  await expect(page.getByText('سُجّلت الدفعة.')).toBeVisible();
  await expect(pay).toBeHidden();
  await expect(page.locator('main h1')).toContainText('مدفوعة');
  await expect(page.getByRole('button', { name: 'تسجيل دفعة' })).toHaveCount(0);
  const payments = page.getByRole('list', { name: 'المدفوعات' });
  await expect(payments.getByText('نقدًا', { exact: true })).toBeVisible();
  await expect(payments.getByRole('link', { name: /الإيصال/ })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('void an invoice: the reason is required; the invoice stays, marked void', async ({
  page,
}) => {
  await signIn(page, 'admin@qarabic.test', '/invoices/1');
  await expect(page.locator('main h1')).toContainText('مستحقة');
  await page.getByRole('button', { name: 'إجراءات أخرى' }).click();
  await page.getByRole('menuitem', { name: 'إلغاء الفاتورة' }).click();
  const dialog = page.getByRole('alertdialog', { name: /إلغاء الفاتورة/ });
  await dialog.getByRole('button', { name: 'إلغاء الفاتورة' }).click();
  await expect(dialog.getByRole('textbox', { name: /السبب/ })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await dialog.getByRole('textbox', { name: /السبب/ }).fill('أُصدرت بالخطأ لعائلة متوقفة');
  await dialog.getByRole('button', { name: 'إلغاء الفاتورة' }).click();
  await expect(page.getByText('أُلغيت الفاتورة.')).toBeVisible();
  await expect(page.getByText('أُلغيت هذه الفاتورة')).toBeVisible();
  await expect(page.getByText('السبب: أُصدرت بالخطأ لعائلة متوقفة')).toBeVisible();
  await expect(page.locator('main h1')).toContainText('ملغاة');
  await expect(page.getByRole('button', { name: 'إجراءات أخرى' })).toHaveCount(0);
});

test('list: status tab, month and search live in the URL', async ({ page }) => {
  await signIn(page);
  // D141: nine views live in the title's views menu.
  await page.getByRole('button', { name: /تغيير العرض$/ }).click();
  await page.getByRole('menuitemradio', { name: /^متأخرة/ }).click();
  await expect(page).toHaveURL(/status=overdue/);
  const table = page.getByRole('table', { name: 'الفواتير' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await page.reload();
  await expect(
    page.getByRole('button', { name: /^متأخرة\s*\(\d+\)\s*تغيير العرض$/ }),
  ).toBeVisible();
  await page.getByRole('searchbox', { name: 'البحث' }).fill('Yusuf');
  await expect(page).toHaveURL(/q=Yusuf/);
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByText('Yusuf Hassan')).toBeVisible();
});

test('a parent sees only their own invoices, pays by card and comes back paid', async ({
  page,
}) => {
  await signIn(page, 'parent@qarabic.test', '/invoices');
  await expect(page.getByRole('heading', { level: 1, name: 'فواتيري' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'المستحق الآن' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'الفواتير السابقة' })).toBeVisible();
  // Another family's invoice is not listed, and its address answers «not found».
  await expect(page.getByText('Yusuf Hassan')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^ادفع الآن/ })).toHaveCount(1);
  await expectNoSeriousA11yViolations(page);

  await page.getByRole('link', { name: /^ادفع الآن/ }).click();
  const dialog = page.getByRole('dialog', { name: 'اختر طريقة الدفع' });
  await expect(dialog.getByRole('button', { name: 'بطاقة ائتمان أو خصم مباشر' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'PayPal' })).toBeVisible();
  await dialog.getByRole('button', { name: 'بطاقة ائتمان أو خصم مباشر' }).click();
  await expect(page).toHaveURL(/checkout=return&provider=stripe/);
  await expect(page.getByText('تم الدفع بنجاح')).toBeVisible();
  await expect(page.locator('main h1')).toContainText('مدفوعة');
  await expect(page.getByRole('button', { name: 'ادفع الآن' })).toHaveCount(0);
  await page
    .getByRole('link', { name: /الإيصال/ })
    .last()
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'إيصال دفع' })).toBeVisible();
  await expect(page.getByText(/RC-\d{6}/)).toBeVisible();

  await page.goto('/invoices/3');
  await expect(page.getByText('الفاتورة غير موجودة')).toBeVisible();
});

test('checkout return: «cancel» says nothing was charged; PayPal is captured on return', async ({
  page,
}) => {
  await signIn(page, 'parent@qarabic.test', '/invoices/1?checkout=cancelled');
  await expect(page.getByText('أُلغيت عملية الدفع')).toBeVisible();
  await expect(page.getByText('لم يُخصم أي مبلغ، ويمكنكم الدفع لاحقًا.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ادفع الآن' })).toBeVisible();

  await page.getByRole('button', { name: 'ادفع الآن' }).click();
  await page
    .getByRole('dialog', { name: 'اختر طريقة الدفع' })
    .getByRole('button', { name: 'PayPal' })
    .click();
  await expect(page).toHaveURL(/provider=paypal&token=MOCK-ORDER-\d+/);
  await expect(page.getByText('تم الدفع بنجاح')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test.describe('phone 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('staff and parent billing screens fit the screen and pass axe', async ({ page }) => {
    await signIn(page);
    await expectNoHorizontalScroll(page);
    for (const path of [
      '/invoices/4',
      '/invoices/7',
      '/packages',
      '/settings/billing',
      '/families/1',
    ]) {
      await page.goto(path);
      await expect(page.locator('#main h1').first()).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page);
    }
    await page.goto('/invoices/11');
    await page.getByRole('button', { name: 'إجراءات أخرى' }).click();
    await page.getByRole('menuitem', { name: 'تقسيم الفاتورة' }).click();
    await expect(page.getByRole('dialog', { name: /تقسيم الفاتورة/ })).toBeVisible();
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
  });

  test('parent invoices on a phone', async ({ page }) => {
    await signIn(page, 'parent@qarabic.test', '/invoices');
    await expectNoHorizontalScroll(page);
    await page.goto('/invoices/1');
    await expect(page.locator('#main h1').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
  });
});
