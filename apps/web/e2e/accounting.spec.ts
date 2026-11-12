import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * M7 accounting against the MSW mocks: the journal, a new balanced entry, vouchers (create and
 * void) and the chart of accounts with a statement; every screen at phone, tablet and desktop
 * widths in Arabic and English, with axe. Steps that change data stay in one page (client
 * navigation), since a reload rebuilds the mocks.
 */
const WIDTHS = { mobile: 375, tablet: 768, desktop: 1440 } as const;
const PAGES = [
  '/accounting/journal',
  '/accounting/journal/new',
  '/accounting/journal/1',
  '/accounting/vouchers',
  '/accounting/vouchers/1',
  '/accounting/accounts',
  '/accounting/accounts/4',
  '/accounting/reports',
  '/accounting/reports?report=profit-and-loss',
  '/accounting/reports?report=balance-sheet',
  '/accounting/reports?report=cash',
  '/accounting/periods',
] as const;

async function signIn(page: Page, path: string) {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page, 'accounts@qarabic.test');
  await expect(page.locator('main h1').first()).toBeVisible();
}

for (const [name, width] of Object.entries(WIDTHS)) {
  for (const lang of ['ar', 'en'] as const) {
    test(`${name} ${width}px ${lang}: accounting screens fit and pass axe`, async ({ page }) => {
      test.slow();
      await page.setViewportSize({ width, height: 900 });
      await signIn(page, '/accounting/journal');
      if (lang === 'en') {
        await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
        await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
      }
      for (const path of PAGES) {
        await page.goto(path);
        await expect(page.locator('main h1').first()).toBeVisible();
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page);
      }
    });
  }
}

async function pick(page: Page, trigger: ReturnType<Page['getByRole']>, code: string) {
  await trigger.click();
  await page.getByPlaceholder('ابحث برقم الحساب أو اسمه').last().fill(code);
  await page.getByRole('option', { name: new RegExp(`^${code} ·`) }).click();
}

test('accounts: post a balanced entry, then reverse it', async ({ page }) => {
  await signIn(page, '/accounting/journal');
  await page.getByRole('link', { name: 'قيد جديد' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'قيد يومية جديد' })).toBeVisible();
  await page.getByLabel(/البيان/).fill('Prepaid hosting');
  const lines = page.getByRole('list', { name: 'أسطر القيد' }).getByRole('listitem');
  await pick(page, lines.nth(0).getByRole('combobox'), '1320');
  await lines.nth(0).getByLabel('مدين · السطر 1').fill('300');
  await pick(page, lines.nth(1).getByRole('combobox'), '1120');
  await lines.nth(1).getByLabel('دائن · السطر 2').fill('250');
  await page.getByRole('button', { name: 'ترحيل القيد' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'غير متوازن' })).toBeVisible();
  await lines.nth(1).getByLabel('دائن · السطر 2').fill('300');
  await page.getByRole('button', { name: 'ترحيل القيد' }).click();
  await expect(page).toHaveURL(/\/accounting\/journal\/\d+$/);
  await expect(page.getByRole('table', { name: 'أسطر القيد' })).toBeVisible();

  await page.getByRole('button', { name: 'عكس القيد' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('textbox').fill('Wrong account');
  await dialog.getByRole('button', { name: 'عكس القيد' }).click();
  await expect(page.getByRole('link', { name: 'فتح القيد الأصلي' })).toBeVisible();
});

test('accounts: a payment voucher on a phone, then void it', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, '/accounting/vouchers');
  await page.getByRole('button', { name: 'سند صرف' }).click();
  const dialog = page.getByRole('dialog', { name: 'سند صرف' });
  await pick(page, dialog.getByRole('combobox', { name: /حساب الدفع/ }), '1120');
  await dialog.getByLabel(/المدفوع له/).fill('Hosting Ltd');
  await dialog
    .getByLabel(/^الوصف/)
    .first()
    .fill('Server for November');
  await pick(page, dialog.getByRole('combobox', { name: /حساب المصروف/ }), '5150');
  await dialog.getByLabel(/^المبلغ/).fill('75.50');
  await dialog.getByRole('button', { name: /ترحيل السند/ }).click();
  await expect(page).toHaveURL(/\/accounting\/vouchers\/\d+$/);
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'إلغاء السند' }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.getByRole('textbox').fill('Duplicate');
  await confirm.getByRole('button', { name: 'إلغاء السند' }).click();
  await expect(page.getByText(/السبب: Duplicate/)).toBeVisible();
});

test('accounts: the chart opens a statement', async ({ page }) => {
  await signIn(page, '/accounting/accounts');
  await page.getByRole('link', { name: 'البنك', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: /كشف حساب 1120/ })).toBeVisible();
  await expect(page.getByText('الرصيد الافتتاحي')).toBeVisible();
});

test('accounts: reports switch by tab and keep the currency in the URL', async ({ page }) => {
  await signIn(page, '/accounting/reports');
  await expect(page.getByRole('table', { name: 'ميزان المراجعة' })).toBeVisible();
  await page.getByRole('tab', { name: 'قائمة الدخل' }).click();
  await expect(page).toHaveURL(/report=profit-and-loss/);
  await expect(page.getByText(/صافي (الربح|الخسارة)/)).toBeVisible();
  await page.getByRole('tab', { name: 'النقدية' }).click();
  await expect(page.getByRole('table', { name: /النقدية بعملة/ }).first()).toBeVisible();
});
