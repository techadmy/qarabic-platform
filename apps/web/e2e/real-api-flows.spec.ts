import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import { conflictResultSchema, trialTeachersResponseSchema } from '@qarabic/shared';
import { z } from 'zod';
import { expectLoaded, REAL_API, runTag, signInReal } from './real-api-helpers';

/**
 * N3–N7 key flows against the real API and its seeded dev database (opt-in: `pnpm test:e2e:real`),
 * so the mock-only specs cannot hide contract drift: every step writes through the API and the
 * screen reads the answer back with the shared schemas. Each run makes its own lead, invoice and
 * payroll month, so the suite can run again on the same database.
 */
test.skip(!REAL_API, 'set E2E_REAL_API=1 (needs the API and Postgres)');
test.describe.configure({ mode: 'serial' });

const conflictAnswer = z.object({ data: conflictResultSchema });
const trialTeachersAnswer = trialTeachersResponseSchema;

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
 * Moves the select `combo` to another option with the keyboard (open, `steps` × ↓, Enter) and
 * waits until the list has closed. Pointer clicks in the long list (96 times) missed under heavy
 * load while Radix was still positioning it, which left the list open over the dialog.
 */
async function chooseOption(page: Page, combo: Locator, index: number) {
  await combo.focus();
  await combo.press('Enter');
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  const options = list.getByRole('option');
  const target = index % (await options.count());
  // Step from the option Radix highlighted on opening (the current value) towards the target,
  // one key at a time and reading where the highlight is (presses sent back to back got lost).
  // Radix moves focus to the highlighted option: the keys go to the page, not the list element.
  const at = () =>
    options.evaluateAll((all) => all.findIndex((o) => o.hasAttribute('data-highlighted')));
  for (let n = 0; n < 200; n++) {
    const from = await at();
    if (from === target) break;
    await page.keyboard.press(from === -1 || from < target ? 'ArrowDown' : 'ArrowUp');
    // On a busy machine the highlight moves a beat later: wait for it before the next key.
    await expect.poll(at).not.toBe(from);
  }
  await expect(options.nth(target)).toHaveAttribute('data-highlighted');
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();
}

/**
 * Option indexes for the time lists, never the same twice in a test: a time already checked is
 * answered from the dialog's cache (no new request to wait for).
 */
function* distinctTimes() {
  const start = Number(runTag());
  for (let k = 0; k < 96; k++) yield start + k * 7; // 7 and 96 are coprime: 96 distinct times
}

/**
 * T2 trial booking: steps through distinct times; for each, the ranked teachers
 * (`/trial-teachers`) answer first, a teacher is chosen among the eligible ones by the run's tag
 * (repeated runs spread their trials), and the live check of that teacher and time decides. The
 * check is matched by its request (teacher + time), so an answer for an earlier choice never counts.
 */
async function pickTrialTimeAndTeacher(page: Page, dialog: Locator, tries: Iterator<number>) {
  const checks: { teacherId: number; time: string; body: unknown }[] = [];
  const onResponse = async (r: Response) => {
    if (!r.url().endsWith('/schedule/check') || r.request().method() !== 'POST') return;
    const sent = JSON.parse(r.request().postData() ?? '{}') as {
      teacherId?: number;
      localStartTime?: string;
    };
    checks.push({
      teacherId: Number(sent.teacherId),
      time: String(sent.localStartTime),
      body: await r.json().catch(() => null),
    });
  };
  page.on('response', onResponse);
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      const listed = page.waitForResponse(
        (r) => /\/trial-teachers\?/.test(r.url()) && r.request().method() === 'GET',
      );
      await chooseOption(
        page,
        dialog.getByRole('combobox', { name: 'الوقت' }),
        tries.next().value!,
      );
      const res = await listed;
      const time = new URL(res.url()).searchParams.get('localTime')!;
      const { data } = trialTeachersAnswer.parse(await res.json());
      if (!data.eligible.length) continue;
      const pick = data.eligible[Number(runTag()) % data.eligible.length]!;
      await dialog
        .getByRole('radiogroup', { name: 'المعلم' })
        .getByRole('radio', { name: pick.teacher.name, exact: true })
        .check();
      let answer: unknown = null;
      await expect
        .poll(() => {
          answer =
            checks.find((c) => c.teacherId === pick.teacher.id && c.time === time)?.body ?? null;
          return answer !== null;
        })
        .toBe(true);
      const check = conflictAnswer.parse(answer).data;
      if (check.conflicts.length === 0) {
        await expect(dialog.getByText(/لا يمكن الحفظ/)).toHaveCount(0);
        return check;
      }
    }
    throw new Error('no time with a free eligible teacher after 20 tries');
  } finally {
    page.off('response', onResponse);
  }
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
  // A long flow (8 dialogs, each with server checks): more than the default 30 s on a busy runner.
  test.setTimeout(90_000);
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
  // T2: date and time first, then a teacher from the server's ranked list (see
  // pickTrialTimeAndTeacher: by the run's tag among the eligible, so runs spread their trials).
  await pickTomorrow(page, book, 'Africa/Cairo');
  // The live check looks at the weekly pattern; the booking also checks the one date and can
  // still refuse a clash with a one-off class there: then try the next free time.
  const times = distinctTimes();
  for (let attempt = 0; ; attempt++) {
    expect(attempt, 'a bookable trial time after 10 tries').toBeLessThan(10);
    const check = await pickTrialTimeAndTeacher(page, book, times);
    // Tick the warnings this answer reported (e.g. the teacher's daily limit, as earlier runs pile
    // classes on the demo teacher): the dialog sends nothing until they are acknowledged.
    const boxes = book.getByRole('alert').getByRole('checkbox');
    await expect(boxes).toHaveCount(check.warnings.length);
    for (const box of await boxes.all()) await box.check();
    const answer = page.waitForResponse(
      (r) => /\/leads\/\d+\/trials$/.test(r.url()) && r.request().method() === 'POST',
    );
    await book.getByRole('button', { name: 'احجز الحصة' }).click();
    if ((await answer).ok()) break;
  }
  await expect(page.getByText('حُجزت الحصة التجريبية.')).toBeVisible();
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
  const slotTimes = distinctTimes();
  for (let attempt = 0; ; attempt++) {
    expect(attempt, 'a free weekly time after 20 tries').toBeLessThan(20);
    await chooseOption(
      page,
      convert.getByRole('combobox', { name: 'وقت الموعد 1' }),
      slotTimes.next().value!,
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
