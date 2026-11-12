import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectLoaded, REAL_API, runTag, signInReal } from './real-api-helpers';

/**
 * N3–N7 key flows against the real API and its seeded dev database (opt-in: `pnpm test:e2e:real`),
 * so the mock-only specs cannot hide contract drift: every step writes through the API and the
 * screen reads the answer back with the shared schemas. Each run makes its own lead, invoice and
 * payroll month, so the suite can run again on the same database.
 */
test.skip(!REAL_API, 'set E2E_REAL_API=1 (needs the API and Postgres)');
test.describe.configure({ mode: 'serial' });

/** The first option of an open combobox / select list. */
const firstOption = (page: Page) => page.getByRole('option').first();

/** Tomorrow in `tz` as the shadcn calendar's accessible day name (e.g. «نوفمبر 13, 2026»). */
async function pickTomorrow(page: Page, scope: Locator, tz: string) {
  const tomorrow = new Date(Date.now() + 86_400_000);
  const part = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('ar', { ...o, timeZone: tz, numberingSystem: 'latn' }).format(tomorrow);
  const monthOf = (d: Date) =>
    new Intl.DateTimeFormat('en', { month: 'numeric', timeZone: tz }).format(d);
  await scope.getByRole('button', { name: 'التاريخ' }).click();
  if (monthOf(tomorrow) !== monthOf(new Date())) {
    await page.getByRole('button', { name: 'اذهب إلى الشهر التالي' }).click();
  }
  const label = `${part({ month: 'long' })} ${Number(part({ day: 'numeric' }))}, ${part({ year: 'numeric' })}`;
  await page.getByRole('button', { name: new RegExp(label) }).click();
}

/** The Arabic month names the shared month picker shows (`ar-EG`, long). */
const AR_MONTHS = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat('ar-EG', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, i, 1)),
  ),
);

/** `YYYY-MM` shown on a month picker's button («ديسمبر 2026»). */
async function monthOf(trigger: Locator) {
  const text = (await trigger.textContent())!.trim();
  const index = AR_MONTHS.findIndex((m) => text.includes(m));
  const year = text.match(/\d{4}/)![0];
  return `${year}-${String(index + 1).padStart(2, '0')}`;
}

/** Chooses `key` (`YYYY-MM`) in the shared month picker opened by `trigger`. */
async function pickMonth(page: Page, trigger: Locator, key: string) {
  const [year, month] = key.split('-').map(Number) as [number, number];
  await trigger.click();
  const shown = async () =>
    Number(await page.getByRole('group', { name: /^\d{4}$/ }).getAttribute('aria-label'));
  while ((await shown()) < year) await page.getByRole('button', { name: 'السنة التالية' }).click();
  while ((await shown()) > year) await page.getByRole('button', { name: 'السنة السابقة' }).click();
  await page.getByRole('button', { name: `${AR_MONTHS[month - 1]} ${year}`, exact: true }).click();
  await expect(trigger).toContainText(`${AR_MONTHS[month - 1]} ${year}`);
}

/**
 * Chooses the option at `index` (wrapped) in the select `combo` and waits until the list has
 * closed. In a long list (96 times) a click could land while Radix was still positioning it and
 * leave it open, hiding the dialog behind it; then it tries again.
 */
async function chooseOption(page: Page, combo: Locator, index: number) {
  await expect(async () => {
    if (!(await page.getByRole('listbox').isVisible())) await combo.click();
    const options = page.getByRole('option');
    const option = options.nth(index % (await options.count()));
    await option.scrollIntoViewIfNeeded();
    await option.click({ timeout: 2_000 });
    await expect(page.getByRole('listbox')).toBeHidden({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

/**
 * Picks a time in `combo` that the live schedule check does not block («لا يمكن الحفظ»): earlier
 * runs left trials and weekly times on the same teacher, so it steps through the list until clear.
 */
async function pickFreeTime(page: Page, dialog: Locator, combo: string) {
  const blocked = dialog.getByText(/لا يمكن الحفظ/);
  const start = Number(runTag());
  for (let attempt = 0; attempt < 20; attempt++) {
    // Read the alert only once the check of this choice has answered (it keeps the last result).
    const checked = page.waitForResponse(
      (r) => r.url().endsWith('/schedule/check') && r.request().method() === 'POST',
    );
    await chooseOption(page, dialog.getByRole('combobox', { name: combo }), start + attempt * 7);
    await checked;
    await expect(dialog.getByRole('combobox', { name: combo })).not.toHaveText('');
    if (!(await blocked.isVisible())) return;
  }
  throw new Error(`no free time in «${combo}» after 20 tries`);
}

/**
 * Submits with `button` and waits for `done` (the success toast) or the request to acknowledge the
 * warnings (e.g. the teacher's daily limit, as earlier runs pile classes on the demo teacher);
 * then ticks them and submits again.
 */
async function submitAcknowledging(page: Page, dialog: Locator, button: string, done: string) {
  const success = page.getByText(done);
  const needAck = dialog.getByText('عالج التعارضات أو أكّد التنبيهات قبل الحجز.');
  await dialog.getByRole('button', { name: button }).click();
  await expect(success.or(needAck)).toBeVisible();
  if (await needAck.isVisible()) {
    for (const box of await dialog.getByRole('alert').getByRole('checkbox').all())
      await box.check();
    await dialog.getByRole('button', { name: button }).click();
  }
  await expect(success).toBeVisible();
}

test('real API (N3): staff edit a lesson report; the edit is saved', async ({ page }) => {
  await signInReal(page, '/lesson-reports?state=on_time');
  const table = page.getByRole('table', { name: 'تقارير الحصص' });
  await expectLoaded(page);
  let row = table.locator('tbody tr').filter({ hasText: 'سُلّم في موعده' }).first();
  if (!(await row.count())) {
    await page.getByRole('radio', { name: /^سُلّم متأخرًا/ }).click();
    row = table.locator('tbody tr').filter({ hasText: 'سُلّم متأخرًا' }).first();
  }
  await expect(row).toBeVisible();
  const name = (await row.getByRole('button').first().textContent())!.trim();
  await row.getByRole('button', { name }).first().click();
  const sheet = page.getByRole('dialog', { name: 'تفاصيل الحصة' });
  const report = sheet.getByRole('region', { name: 'تقرير الحصة' });
  await expect(report).toBeVisible();

  const homework = `E2E homework ${runTag()}`;
  await sheet.getByRole('button', { name: 'تعديل التقرير' }).click();
  const edit = sheet.getByRole('form', { name: 'تعديل تقرير الحصة' });
  await edit.getByLabel(/الواجب/).fill(homework);
  await edit.getByRole('button', { name: 'حفظ التقرير' }).click();
  await expect(page.getByText('حُفظت تعديلات التقرير')).toBeVisible();
  await expect(sheet.getByText(homework)).toBeVisible();

  // Still there after a reload (the sheet is in the URL): it came back from the API.
  await page.reload();
  await expect(
    page.getByRole('dialog', { name: 'تفاصيل الحصة' }).getByText(homework),
  ).toBeVisible();
});

test('real API (N4): staff reply to a ticket; the reply is on the ticket', async ({ page }) => {
  await signInReal(page, '/support');
  const list = page.getByRole('list', { name: 'صندوق الطلبات' });
  await expect(list.getByRole('listitem').first()).toBeVisible();
  await expectLoaded(page);
  const item = list.getByRole('listitem').first();
  // The ticket link: the split view (`?id=`) from 1024 px, the ticket page below (D141 §1).
  const link = item.locator('a[href*="id="], a[href^="/tickets/"]').first();
  const number = (await link.textContent())!.match(/#(\d+)/)![1]!;

  const text = `E2E reply ${runTag()}`;
  await item.getByRole('button', { name: new RegExp(`^رد\\s?: #${number}$`) }).click();
  const reply = page.getByRole('dialog', { name: `الرد على الطلب #${number}` });
  await reply.getByRole('textbox').first().fill(text);
  await reply.getByRole('button', { name: 'إرسال' }).click();
  await expect(page.getByText('أُرسل الرد.')).toBeVisible();

  await page.goto(`/tickets/${number}`);
  await expect(
    page.getByRole('heading', { level: 1, name: new RegExp(`#${number}`) }),
  ).toBeVisible();
  await expect(page.getByText(text)).toBeVisible();
  await expectLoaded(page);
});

test('real API (N5): the public trial form stores a lead (no sign-in)', async ({ page }) => {
  const parent = `E2E Web ${runTag()}`;
  // The form loads its courses after hydration: typing before that is wiped by React (CI flake).
  const courses = page.waitForResponse((r) => r.url().endsWith('/public/courses') && r.ok());
  await page.goto('/trial');
  await courses;
  await page.getByRole('textbox', { name: /الاسم الكامل/ }).fill(parent);
  await page.getByRole('combobox', { name: /بلد الإقامة/ }).click();
  await page.keyboard.type('مصر');
  await page.getByRole('option', { name: /مصر/ }).first().click();
  await page.getByRole('textbox', { name: /رقم واتساب/ }).fill(`100${runTag().padStart(7, '0')}`);
  await page
    .getByRole('textbox', { name: /البريد الإلكتروني/ })
    .fill(`e2e.web.${runTag()}@example.test`);
  await page.getByRole('textbox', { name: /اسم الطالب/ }).fill('E2E Student');
  await page.getByRole('spinbutton', { name: /العمر/ }).fill('9');
  await page.getByRole('combobox', { name: /الجنس/ }).click();
  await page.getByRole('option', { name: 'ذكر' }).click();
  await page.getByRole('combobox', { name: /الدورة/ }).click();
  await firstOption(page).click();
  await page.getByRole('checkbox', { name: 'السبت' }).check();
  await page.getByRole('checkbox', { name: 'مساءً' }).check();
  await page.getByRole('button', { name: 'أرسل الطلب' }).click();
  await expect(page.getByRole('heading', { name: `شكرًا لك، ${parent}` })).toBeVisible();

  // Staff see it under «الكل»: «جديد», or «مزعج» when this address sent several within the hour
  // (the API's spam score — expected when the suite runs again soon).
  await signInReal(page, `/leads?status=all&q=${encodeURIComponent(parent)}`);
  const table = page.getByRole('table', { name: 'العملاء المحتملون' });
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByRole('row').nth(1)).toContainText(/جديد|مزعج/);
});

test('real API (N5): a lead → call → trial → interested → converted to regular', async ({
  page,
}) => {
  // 1. Staff add a phone lead.
  const parent = `E2E Parent ${runTag()}`;
  await signInReal(page, '/leads');
  await page.getByRole('button', { name: 'طلب جديد' }).first().click();
  const add = page.getByRole('dialog', { name: 'طلب جديد' });
  await add.getByRole('textbox', { name: /اسم ولي الأمر/ }).fill(parent);
  await add
    .getByRole('textbox', { name: /البريد الإلكتروني/ })
    .fill(`e2e.${runTag()}@example.test`);
  await add
    .getByRole('textbox', { name: /اسم الطالب/ })
    .first()
    .fill('E2E Student');
  await add.getByRole('button', { name: 'أضف الطلب' }).click();
  await expect(page.getByText('أُضيف الطلب.')).toBeVisible();
  await expect(page).toHaveURL(/\/leads\/\d+$/);
  await expect(page.getByRole('heading', { level: 1, name: parent })).toBeVisible();
  await expectLoaded(page);

  // 3. Log a call.
  await page.getByRole('combobox', { name: /نتيجة المكالمة/ }).click();
  await page.getByRole('option', { name: 'تم الرد' }).click();
  await page.getByRole('button', { name: 'سجّل', exact: true }).click();
  await expect(page.getByText('سُجّل التواصل.')).toBeVisible();

  // 4. Book a trial: the family account first, then teacher, tomorrow and a time.
  await page.getByRole('button', { name: 'احجز حصة تجريبية' }).first().click();
  const book = page.getByRole('dialog', { name: 'حجز حصة تجريبية' });
  // A staff lead has no course yet: pick the child's course.
  await book.getByRole('combobox', { name: /الدورة/ }).click();
  await firstOption(page).click();
  await book.getByRole('button', { name: 'أنشئ الحساب وتابع' }).click();
  await expect(page.getByText('أُنشئ حساب العائلة.')).toBeVisible();
  await book.getByRole('combobox', { name: 'المعلم' }).click();
  await firstOption(page).click();
  await pickTomorrow(page, book, 'Africa/Cairo');
  await pickFreeTime(page, book, 'الوقت');
  await submitAcknowledging(page, book, 'احجز الحصة', 'حُجزت الحصة التجريبية.');
  await expect(page.getByText('حُجزت الحصة التجريبية.')).toBeVisible();
  await expect(book).toBeHidden();

  // 5. Outcome: interested.
  await page.getByRole('button', { name: 'سجّل نتيجة التجريبية' }).first().click();
  const outcome = page.getByRole('dialog', { name: 'نتيجة الحصة التجريبية' });
  await outcome.getByRole('radio', { name: 'مهتم بالاشتراك' }).check();
  await outcome.getByRole('button', { name: 'سجّل النتيجة' }).click();
  await expect(page.getByText('سُجّلت النتيجة.')).toBeVisible();

  // 6. Convert to regular with one weekly time.
  await page.getByRole('button', { name: 'حوّل إلى منتظم' }).first().click();
  const convert = page.getByRole('dialog', { name: 'التحويل إلى منتظم' });
  await convert.getByRole('combobox', { name: 'يوم الموعد 1' }).click();
  await page.getByRole('option', { name: 'السبت' }).click();
  // No live check here: a clash with an earlier run's weekly time comes back on submit.
  for (let attempt = 0; ; attempt++) {
    expect(attempt, 'a free weekly time after 20 tries').toBeLessThan(20);
    await chooseOption(
      page,
      convert.getByRole('combobox', { name: 'وقت الموعد 1' }),
      Number(runTag()) + attempt * 7,
    );
    const answer = page.waitForResponse(
      (r) => /\/leads\/\d+\/convert$/.test(r.url()) && r.request().method() === 'POST',
    );
    await convert.getByRole('button', { name: 'حوّل إلى منتظم' }).click();
    if ((await answer).ok()) break;
  }
  await expect(page.getByText('تحوّلت العائلة إلى منتظمة.')).toBeVisible();
  await expect(page.getByText(/تحوّل إلى منتظم في /)).toBeVisible();

  // Still converted after a reload.
  await page.reload();
  await expect(page.getByText(/تحوّل إلى منتظم في /)).toBeVisible();
  await expectLoaded(page);
});

test('real API (N6): monthly invoice run → an invoice → a manual payment → paid', async ({
  page,
}) => {
  await signInReal(page, '/invoices');
  await expect(page.getByRole('heading', { level: 1, name: 'الفواتير' })).toBeVisible();
  await expectLoaded(page);

  // The run for the first month that still has invoices to issue: the default month on a fresh
  // seed, later months on re-runs (no family is invoiced twice for the same period).
  await page.getByRole('button', { name: 'إصدار فواتير الشهر' }).click();
  const run = page.getByRole('dialog', { name: 'إصدار الفواتير الشهرية' });
  const monthButton = run.getByRole('button', { name: /^الشهر/ });
  const first = await monthOf(monthButton);
  const issue = run.getByRole('button', { name: /^أصدر / });
  const none = run.getByRole('button', { name: 'لا فواتير للإصدار' });
  for (let offset = 0; ; offset++) {
    expect(offset, 'a month with invoices to issue in the next two years').toBeLessThan(24);
    const d = new Date(`${first}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + offset);
    await pickMonth(page, monthButton, d.toISOString().slice(0, 7));
    await run.getByRole('button', { name: 'معاينة' }).click();
    await expect(run.getByRole('status')).toContainText(
      new Intl.DateTimeFormat('ar', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
        numberingSystem: 'latn',
      }).format(d),
    );
    await expect(issue.or(none)).toBeVisible();
    if (await issue.isVisible()) break;
  }
  await issue.click();
  await expect(page.getByText(/^أُصدرت .*(فاتورة|فواتير|فاتورتان)\.$/)).toBeVisible();
  await expect(run).toBeHidden();

  // The newest invoice is first: pay its whole balance in cash.
  const table = page.getByRole('table', { name: 'الفواتير' });
  await expect(table).not.toHaveAttribute('aria-busy');
  await table.getByRole('row').nth(1).getByRole('link').first().click();
  // From 1024 px the invoice opens in the split view (D141 §1); its own page is one click on.
  await expect(page).toHaveURL(/[?&]id=\d+/);
  await page.getByRole('link', { name: 'فتح في صفحة كاملة' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /INV-\d{4}-\d{6}/ })).toBeVisible();
  await expect(page.locator('main h1')).toContainText('مستحقة');

  const ref = `E2E-${runTag()}`;
  await page.getByRole('button', { name: 'تسجيل دفعة' }).click();
  const pay = page.getByRole('dialog', { name: /تسجيل دفعة على الفاتورة/ });
  await expect(pay.getByRole('textbox', { name: /المبلغ/ })).toHaveValue(/^\d+\.\d{2}$/);
  await pay.getByRole('combobox', { name: /طريقة الدفع/ }).click();
  await page.getByRole('option', { name: 'نقدًا' }).click();
  await pay.getByRole('textbox', { name: 'رقم المرجع' }).fill(ref);
  await pay.getByRole('button', { name: 'سجّل الدفعة' }).click();
  await expect(page.getByText('سُجّلت الدفعة.')).toBeVisible();
  await expect(page.locator('main h1')).toContainText('مدفوعة');

  await page.reload();
  await expect(page.locator('main h1')).toContainText('مدفوعة');
  const payments = page.getByRole('list', { name: 'المدفوعات' });
  await expect(payments.getByText(ref)).toBeVisible();
  await payments
    .getByRole('link', { name: /الإيصال/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/invoices\/\d+\/receipts\/\d+$/);
  await expectLoaded(page);
});

test('real API (N7): payroll run → review → approve → record the payment → payslip paid', async ({
  page,
}) => {
  await signInReal(page, '/payroll');
  await expect(page.getByRole('heading', { level: 1, name: 'مسيّرات الرواتب' })).toBeVisible();
  await expectLoaded(page);

  // The newest month without a run: this month on a fresh seed, earlier months on re-runs.
  const month = (offset: number) => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - offset);
    return d.toISOString().slice(0, 7);
  };
  // The header button (an empty list repeats it as its call to action).
  await page.getByRole('button', { name: 'أنشئ مسيّر الشهر' }).first().click();
  const create = page.getByRole('dialog', { name: 'مسيّر رواتب جديد' });
  const taken = create.getByText('يوجد مسيّر رواتب لهذا الشهر بالفعل.');
  const preview = create.getByRole('table', { name: 'معاينة القسائم' });
  for (let offset = 0; ; offset++) {
    expect(offset, 'a month without a payroll run in the last two years').toBeLessThan(24);
    await pickMonth(page, create.getByRole('button', { name: /^شهر المسيّر/ }), month(offset));
    await create.getByRole('button', { name: 'معاينة' }).click();
    await expect(preview).toBeVisible();
    // The preview stores nothing; «already has a run» is the create's answer.
    const answer = page.waitForResponse(
      (r) => /\/payroll\/runs$/.test(r.url()) && r.request().method() === 'POST',
    );
    await create.getByRole('button', { name: 'أنشئ المسيّر' }).click();
    if ((await answer).ok()) break;
    await expect(taken).toBeVisible();
  }
  await expect(page.locator('main h1')).toContainText('مسودة');
  await expectLoaded(page);

  await page.getByRole('button', { name: 'اعتمد المراجعة' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'اعتمد المراجعة' }).click();
  await expect(page.locator('main h1')).toContainText('تمت المراجعة');
  await page.getByRole('button', { name: 'اعتمد المسيّر' }).click();
  const approve = page.getByRole('dialog', { name: 'اعتماد مسيّر الرواتب' });
  await approve.getByRole('button', { name: 'اعتمد المسيّر' }).click();
  await expect(approve).toBeHidden();
  await expect(page.locator('main h1')).toContainText('معتمد');

  const slips = page.getByRole('table', { name: 'قسائم الرواتب' });
  await slips.getByRole('row').nth(1).getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1, name: /قسيمة راتب/ })).toBeVisible();
  await expect(page.getByRole('table', { name: 'بنود القسيمة' })).toBeVisible();
  const ref = `E2E-VC-${runTag()}`;
  await page.getByRole('button', { name: 'سجّل الصرف' }).click();
  const pay = page.getByRole('dialog', { name: 'تسجيل صرف الراتب' });
  await pay.getByRole('textbox', { name: /الرقم المرجعي/ }).fill(ref);
  await pay.getByRole('button', { name: 'سجّل الصرف' }).click();
  await expect(page.getByText('سُجّل الصرف.')).toBeVisible();

  await page.reload();
  await expect(page.locator('main h1')).toContainText('مصروفة');
  await expect(page.getByText(ref)).toBeVisible();
  await expectLoaded(page);
});
