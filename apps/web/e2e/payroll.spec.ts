import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * N7 payroll on the mock API (no money ever moves: «تسجيل الصرف» only records). Steps that change
 * data stay in one page (client navigation and sign-out / sign-in), since a reload rebuilds the
 * mocks. Covers: check-in → check-out; a teacher's leave request → a manager approves it; a fine
 * proposed by a monitor → approved by a manager; the month's run created → reviewed → approved →
 * a payment recorded → the payslip is paid; a teacher sees only their own payslips and wallet on a
 * phone; axe on every screen.
 */
async function signIn(page: Page, email = 'admin@qarabic.test', path = '/') {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page, email);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[?]/g, '\\?')}$`));
}

async function switchUser(page: Page, email: string) {
  await page.getByRole('button', { name: 'حسابي' }).click();
  await page.getByRole('menuitem', { name: 'تسجيل الخروج' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await login(page, email);
  await expect(page.locator('main h1').first()).toBeVisible();
}

const sidebar = (page: Page) => page.locator('[data-slot="sidebar"]').first();

test('teacher on a phone: check in → check out, then request leave', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, 'teacher@qarabic.test', '/attendance');
  await expect(page.getByRole('heading', { level: 1, name: 'حضوري وإجازاتي' })).toBeVisible();
  await expect(page.getByText('لم تسجّل حضورك اليوم بعد.')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);

  await page.getByRole('button', { name: 'تسجيل الحضور' }).click();
  await expect(page.getByText(/سُجّل الحضور الساعة/)).toBeVisible();
  await page.getByRole('button', { name: 'تسجيل الانصراف' }).click();
  await expect(page.getByText(/اكتمل يوم العمل/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'تسجيل الانصراف' })).toHaveCount(0);

  await page.getByRole('button', { name: 'طلب إجازة' }).click();
  const dialog = page.getByRole('dialog', { name: 'طلب إجازة' });
  await dialog.getByRole('textbox', { name: /السبب/ }).fill('Family wedding');
  await dialog.getByRole('button', { name: 'أرسل الطلب' }).click();
  await expect(page.getByText('أُرسل طلب الإجازة.')).toBeVisible();
  await expect(page.getByText('قيد المراجعة').first()).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('leave: the teacher requests, a manager approves (days go to attendance)', async ({
  page,
}) => {
  await signIn(page, 'teacher@qarabic.test', '/attendance');
  await page.getByRole('button', { name: 'طلب إجازة' }).click();
  const dialog = page.getByRole('dialog', { name: 'طلب إجازة' });
  await dialog.getByRole('combobox', { name: /نوع الإجازة/ }).click();
  await page.getByRole('option', { name: 'إجازة بدون أجر' }).click();
  await dialog.getByRole('textbox', { name: /السبب/ }).fill('Moving house');
  await dialog.getByRole('button', { name: 'أرسل الطلب' }).click();
  await expect(page.getByText('أُرسل طلب الإجازة.')).toBeVisible();

  await switchUser(page, 'admin@qarabic.test');
  await sidebar(page).getByRole('link', { name: 'الحضور والإجازات' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'الحضور والإجازات' })).toBeVisible();
  await page.getByRole('tab', { name: /طلبات الإجازة/ }).click();
  const list = page.getByRole('table', { name: 'طلبات الإجازة' });
  await list.getByRole('button', { name: 'موافقة: معلم تجريبي' }).click();
  const approve = page.getByRole('dialog', { name: 'اعتماد إجازة معلم تجريبي' });
  await expect(approve).toContainText('تُسجّل أيام الإجازة');
  await approve.getByRole('button', { name: 'موافقة' }).click();
  await expect(page.getByText('اعتُمدت الإجازة وسُجّلت أيامها في الحضور.')).toBeVisible();
  await expect(list.getByRole('button', { name: 'موافقة: معلم تجريبي' })).toHaveCount(0);
  // Stacked toasts fade while they leave (sonner); check the page once they are gone.
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 10_000 });
  await expectNoSeriousA11yViolations(page);
});

test('fine: a monitor proposes, a manager approves', async ({ page }) => {
  await signIn(page, 'monitor@qarabic.test', '/fines');
  await expect(page.getByRole('heading', { level: 1, name: 'الغرامات' })).toBeVisible();
  await page.getByRole('button', { name: 'اقترح غرامة' }).click();
  const dialog = page.getByRole('dialog', { name: 'غرامة جديدة' });
  await dialog.getByRole('combobox', { name: /الموظف/ }).click();
  await page.getByRole('option', { name: /Huda Mostafa/ }).click();
  await dialog.getByRole('textbox', { name: /المبلغ/ }).fill('30');
  await dialog.getByRole('textbox', { name: /السبب/ }).fill('Late to class by 12 minutes');
  await dialog.getByRole('button', { name: 'أرسل للاعتماد' }).click();
  await expect(page.getByText('أُرسلت الغرامة للاعتماد.')).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await switchUser(page, 'admin@qarabic.test');
  await sidebar(page).getByRole('link', { name: 'الغرامات والبنود' }).click();
  const table = page.getByRole('table', { name: 'الغرامات والبنود' });
  await table.getByRole('button', { name: 'اعتماد: Huda Mostafa' }).click();
  const approve = page.getByRole('dialog', { name: /اعتماد غرامة: Huda Mostafa/ });
  await approve.getByRole('button', { name: 'اعتماد' }).click();
  await expect(page.getByText('اعتُمد البند.')).toBeVisible();
  await expect(table.getByRole('button', { name: 'اعتماد: Huda Mostafa' })).toHaveCount(0);
});

test('run: create the month → review → approve → record a payment → payslip paid', async ({
  page,
}) => {
  await signIn(page, 'admin@qarabic.test', '/payroll');
  await expect(page.getByRole('heading', { level: 1, name: 'مسيّرات الرواتب' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.getByRole('button', { name: 'أنشئ مسيّر الشهر' }).click();
  const create = page.getByRole('dialog', { name: 'مسيّر رواتب جديد' });
  await create.getByRole('button', { name: 'معاينة' }).click();
  await expect(create.getByRole('table', { name: 'معاينة القسائم' })).toBeVisible();
  await create.getByRole('button', { name: 'أنشئ المسيّر' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /مسيّر رواتب/ })).toBeVisible();
  await expect(page.locator('main h1')).toContainText('مسودة');
  await expectNoSeriousA11yViolations(page);

  await page.getByRole('button', { name: 'اعتمد المراجعة' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'اعتمد المراجعة' }).click();
  await expect(page.locator('main h1')).toContainText('تمت المراجعة');
  await page.getByRole('button', { name: 'اعتمد المسيّر' }).click();
  const approve = page.getByRole('dialog', { name: 'اعتماد مسيّر الرواتب' });
  await expect(approve).toContainText('يُقفل شهر');
  await approve.getByRole('button', { name: 'اعتمد المسيّر' }).click();
  await expect(approve).toBeHidden();
  await expect(page.locator('main h1')).toContainText('معتمد');
  await expect(page.getByRole('button', { name: 'أعد فتح المسيّر' })).toBeVisible();

  await page
    .getByRole('table', { name: 'قسائم الرواتب' })
    .getByRole('link', { name: 'Ahmed Fathy' })
    .click();
  await expect(
    page.getByRole('heading', { level: 1, name: /قسيمة راتب Ahmed Fathy/ }),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'سجّل الصرف' }).click();
  const pay = page.getByRole('dialog', { name: 'تسجيل صرف الراتب' });
  await pay.getByRole('textbox', { name: /الرقم المرجعي/ }).fill('VC-2026-11');
  await pay.getByRole('button', { name: 'سجّل الصرف' }).click();
  await expect(page.getByText('سُجّل الصرف.')).toBeVisible();
  await expect(page.locator('main h1')).toContainText('مصروفة');
  await expect(page.getByText('VC-2026-11')).toBeVisible();
  await expect(page.getByRole('button', { name: 'سجّل الصرف' })).toHaveCount(0);
});

test('teacher on a phone: only own payslips and wallet', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, 'teacher@qarabic.test', '/payroll');
  await expect(page.getByRole('heading', { level: 1, name: 'راتبي' })).toBeVisible();
  const slips = page.getByRole('list', { name: 'قسائم الراتب' });
  await expect(slips.getByRole('link')).toHaveCount(2);
  await expect(page.getByRole('list', { name: 'حركات المحفظة' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);

  await slips.getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1, name: /قسيمة الراتب/ })).toBeVisible();
  await expect(page.getByRole('table', { name: 'بنود القسيمة' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'سجّل الصرف' })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);

  // Another person's payslip (the mock's payslip 2 belongs to Ahmed Fathy) is not found.
  await page.goto('/payroll/payslips/2');
  await expect(page.getByText('لم يُعثر على هذه القسيمة أو لم تُعتمد بعد.')).toBeVisible();
  // The runs list is for payroll staff; a teacher has no fines queue actions either.
  await page.goto('/fines');
  await expect(page.getByRole('heading', { level: 1, name: 'غراماتي' })).toBeVisible();
  await expect(page.getByRole('button', { name: /اعتماد|غرامة/ })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test('staff screens fit a phone and pass axe', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, 'admin@qarabic.test', '/attendance');
  for (const path of [
    '/attendance',
    '/attendance?tab=leave',
    '/fines',
    '/payroll',
    '/payroll/runs/2',
    '/payroll/profiles',
    '/payroll/wallets',
    '/settings/pay-rules',
  ]) {
    await page.goto(path);
    await expect(page.locator('main h1').first()).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
  }
});
