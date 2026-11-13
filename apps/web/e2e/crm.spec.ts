import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * N5 CRM on the mock API: a new lead goes contact → trial booked → outcome → converted; the list,
 * the public trial form and the parent referral; 375 px layout and axe.
 */
async function signIn(page: Page, email = 'admin@qarabic.test', path = '/leads') {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page, email);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

/** Days from today (in `tz`) to the next Friday, 1–7: the demo teachers' day off (Sat–Thu hours). */
function daysToFriday(tz: string) {
  const day = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: tz }).format(new Date());
  const iso = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(day) + 1;
  return (5 - iso + 7) % 7 || 7;
}

/** Picks the day `days` ahead (in `tz`) in the shadcn calendar of the `التاريخ` date button. */
async function pickDay(page: Page, scope: ReturnType<Page['getByRole']>, tz: string, days: number) {
  const target = new Date(Date.now() + days * 86_400_000);
  const part = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('ar', { ...o, timeZone: tz, numberingSystem: 'latn' }).format(target);
  const today = new Date();
  const monthOf = (d: Date) =>
    new Intl.DateTimeFormat('en', { month: 'numeric', timeZone: tz }).format(d);
  await scope.getByRole('button', { name: 'التاريخ' }).click();
  if (monthOf(target) !== monthOf(today)) {
    await page.getByRole('button', { name: 'اذهب إلى الشهر التالي' }).click();
  }
  const label = `${part({ month: 'long' })} ${Number(part({ day: 'numeric' }))}, ${part({ year: 'numeric' })}`;
  await page.getByRole('button', { name: new RegExp(label) }).click();
}

test('lead lifecycle: contact → book trial → interested → convert to regular', async ({ page }) => {
  await signIn(page, 'admin@qarabic.test', '/leads/1');
  await expect(page.getByRole('heading', { level: 1, name: 'Amina Rahman' })).toBeVisible();

  // 1. Log a call: the composer needs a call result.
  await page.getByRole('button', { name: 'سجّل', exact: true }).click();
  await expect(page.getByText('اختر نتيجة المكالمة.')).toBeVisible();
  await page.getByRole('combobox', { name: /نتيجة المكالمة/ }).click();
  await page.getByRole('option', { name: 'تم الرد' }).click();
  await page.getByRole('button', { name: 'سجّل', exact: true }).click();
  await expect(page.getByText('سُجّل التواصل.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'احجز حصة تجريبية' }).first()).toBeVisible();

  // 2. Book a trial: step 1 creates the family account.
  await page.getByRole('button', { name: 'احجز حصة تجريبية' }).first().click();
  const book = page.getByRole('dialog', { name: 'حجز حصة تجريبية' });
  await expect(book).toBeVisible();
  await expect(book.getByRole('textbox', { name: /اسم ولي الأمر/ })).toHaveValue('Amina Rahman');
  await book.getByRole('button', { name: 'أنشئ الحساب وتابع' }).click();
  await expect(page.getByText('أُنشئ حساب العائلة.')).toBeVisible();

  // Step 2: the next Friday (family zone), a time, then a teacher from the server's ranked list
  // (T2: the eligible teachers for this child, course and time); the teacher's time shows live.
  await pickDay(page, book, 'Europe/London', daysToFriday('Europe/London'));
  await book.getByRole('combobox', { name: 'الوقت' }).click();
  await page.getByRole('option', { name: '6:00 م' }).click();
  const teachers = book.getByRole('radiogroup', { name: 'المعلم' });
  await expect(teachers.locator('label').first()).toContainText('#1');
  // Friday is outside the Cairo teachers' hours (they rank after anyone it suits): pick one of them.
  await teachers
    .locator('label')
    .filter({ hasText: 'خارج ساعات العمل' })
    .first()
    .getByRole('radio')
    .check();
  await expect(book.getByText(/عند المعلم: /)).toBeVisible();
  // Friday is the demo teacher's day off (work hours Sat–Thu): booking needs the acknowledgement.
  // (It was «tomorrow», which only worked when tomorrow was a Friday.)
  await book.getByRole('button', { name: 'احجز الحصة' }).click();
  await expect(book.getByText('عالج التعارضات أو أكّد التنبيهات قبل الحجز.')).toBeVisible();
  await book.getByRole('checkbox', { name: 'خارج ساعات عمل المعلم' }).check();
  // A teacher in another zone also brings the DST note: every warning listed needs its tick.
  for (const tick of await book.getByRole('alert').getByRole('checkbox').all()) await tick.check();
  await book.getByRole('button', { name: 'احجز الحصة' }).click();
  await expect(page.getByText('حُجزت الحصة التجريبية.')).toBeVisible();
  await expect(book).toBeHidden();

  // 3. Outcome: interested → trial done.
  await page.getByRole('button', { name: 'سجّل نتيجة التجريبية' }).first().click();
  const outcome = page.getByRole('dialog', { name: 'نتيجة الحصة التجريبية' });
  await outcome.getByRole('button', { name: 'سجّل النتيجة' }).click();
  await expect(outcome.getByText('اختر النتيجة.')).toBeVisible();
  await outcome.getByRole('radio', { name: 'مهتم بالاشتراك' }).check();
  await outcome.getByRole('button', { name: 'سجّل النتيجة' }).click();
  await expect(page.getByText('سُجّلت النتيجة.')).toBeVisible();

  // 4. Convert to regular.
  await page.getByRole('button', { name: 'حوّل إلى منتظم' }).first().click();
  const convert = page.getByRole('dialog', { name: 'التحويل إلى منتظم' });
  await expect(convert).toBeVisible();
  // Yusuf keeps his trial's course; Maryam (no trial of her own) keeps the course she signed up for.
  const courses = convert.getByRole('combobox', { name: 'الدورة' });
  await expect(courses.nth(0)).toHaveText('تلاوة القرآن نظرًا');
  await expect(courses.nth(1)).toHaveText('حفظ القرآن الكريم');
  await convert.getByRole('button', { name: 'حوّل إلى منتظم' }).click();
  await expect(convert.getByText(/أكمل بيانات كل طالب/)).toBeVisible();
  for (const n of [0, 1]) {
    await convert.getByRole('combobox', { name: 'يوم الموعد 1' }).nth(n).click();
    await page.getByRole('option', { name: 'السبت' }).click();
    await convert.getByRole('combobox', { name: 'وقت الموعد 1' }).nth(n).click();
    await page.getByRole('option', { name: n === 0 ? '4:00 م' : '5:00 م' }).click();
  }
  await expect(convert.getByRole('checkbox', { name: /بريد الترحيب/ })).not.toBeChecked();
  await convert.getByRole('button', { name: 'حوّل إلى منتظم' }).click();
  await expect(page.getByText('تحوّلت العائلة إلى منتظمة.')).toBeVisible();
  await expect(convert).toBeHidden();
  await expect(page.getByText(/تحوّل إلى منتظم في /)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('trial booking: a teacher who takes no trials needs an override reason (T2)', async ({
  page,
}) => {
  // Lead 6 already has a family and a child: the dialog opens on the trial step.
  await signIn(page, 'admin@qarabic.test', '/leads/6');
  await page
    .getByRole('button', { name: /احجز حصة تجريبية|أعد حجز التجريبية/ })
    .first()
    .click();
  const book = page.getByRole('dialog', { name: 'حجز حصة تجريبية' });
  await expect(book.getByText('اختر الطالب والدورة والموعد لعرض المعلمين المتاحين.')).toBeVisible();
  // The Saturday after the next Friday: inside the demo teachers' hours (no warning to tick).
  await pickDay(page, book, 'America/New_York', daysToFriday('America/New_York') + 1);
  await book.getByRole('combobox', { name: 'الوقت' }).click();
  await page.getByRole('option', { name: '10:00 ص' }).click();
  await book.getByRole('button', { name: /^عرض غير المتاحين/ }).click();
  const card = book.locator('label').filter({ hasText: 'Mahmoud Saeed' });
  await expect(card).toContainText('لا يقبل الحصص التجريبية');
  await card.getByRole('radio').check();
  await book.getByRole('button', { name: 'احجز الحصة' }).click();
  await expect(book.getByText('اذكر سبب التجاوز (3 أحرف على الأقل).')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await book.getByRole('textbox', { name: 'سبب التجاوز' }).fill('The family asked for him');
  await book.getByRole('button', { name: 'احجز الحصة' }).click();
  await expect(page.getByText('حُجزت الحصة التجريبية.')).toBeVisible();
});

test('public trial form: required fields, then the thank-you message', async ({ page }) => {
  await page.goto('/trial');
  await expect(
    page.getByRole('heading', { level: 1, name: 'احجز حصة تجريبية مجانية' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'أرسل الطلب' }).click();
  await expect(page.getByRole('textbox', { name: /الاسم الكامل/ })).toHaveAttribute(
    'aria-invalid',
    'true',
  );

  await page.getByRole('textbox', { name: /الاسم الكامل/ }).fill('Layla Hassan');
  await page.getByRole('combobox', { name: /بلد الإقامة/ }).click();
  await page.keyboard.type('مصر');
  await page.getByRole('option', { name: /مصر/ }).first().click();
  await page.getByRole('textbox', { name: /رقم واتساب/ }).fill('1001234567');
  await page.getByRole('textbox', { name: /البريد الإلكتروني/ }).fill('layla.hassan@example.com');
  await page.getByRole('textbox', { name: /اسم الطالب/ }).fill('Omar');
  await page.getByRole('spinbutton', { name: /العمر/ }).fill('9');
  await page.getByRole('combobox', { name: /الجنس/ }).click();
  await page.getByRole('option', { name: 'ذكر' }).click();
  await page.getByRole('combobox', { name: /الدورة/ }).click();
  await page.getByRole('option').first().click();
  await page.getByRole('checkbox', { name: 'السبت' }).check();
  await page.getByRole('button', { name: 'أرسل الطلب' }).click();
  await expect(page.getByText('اختر وقتًا واحدًا على الأقل.')).toBeVisible();
  await page.getByRole('checkbox', { name: 'مساءً' }).check();
  await page.getByRole('button', { name: 'أرسل الطلب' }).click();
  await expect(page.getByRole('heading', { name: 'شكرًا لك، Layla Hassan' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('parent refers a friend from the home page', async ({ page }) => {
  await signIn(page, 'parent@qarabic.test', '/');
  const card = page.getByRole('region', { name: 'رشّح صديقًا' });
  await card.getByRole('button', { name: 'رشّح صديقًا' }).click();
  const dialog = page.getByRole('dialog', { name: 'ترشيح صديق' });
  await dialog.getByRole('button', { name: 'أرسل الترشيح' }).click();
  await expect(dialog.getByRole('textbox', { name: /اسم ولي الأمر/ })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await dialog.getByRole('textbox', { name: /اسم ولي الأمر/ }).fill('Fatima Ali');
  await dialog.getByRole('textbox', { name: 'البريد الإلكتروني' }).fill('fatima.ali@example.com');
  await dialog.getByRole('button', { name: 'أرسل الترشيح' }).click();
  await expect(page.getByText('شكرًا لك، أُرسل الترشيح.')).toBeVisible();
  await expect(dialog).toBeHidden();
});

test('leads list: status view and filters live in the URL; bulk bar counts the selection', async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByRole('heading', { level: 1, name: 'العملاء المحتملون' })).toBeVisible();
  // The ten statuses are a views menu on the title (D141 §2).
  await page.getByRole('button', { name: /تغيير العرض$/ }).click();
  await page.getByRole('menuitemradio', { name: /^جديد\s*\d+$/ }).click();
  await expect(page).toHaveURL(/status=new/);
  await page.reload();
  await expect(page.getByRole('button', { name: /^جديد \(\d+\) تغيير العرض$/ })).toBeVisible();

  await page.getByRole('searchbox', { name: 'البحث' }).fill('Amina');
  await expect(page).toHaveURL(/q=Amina/);
  const table = page.getByRole('table', { name: 'العملاء المحتملون' });
  await expect(table.getByRole('row')).toHaveCount(2);

  await table.getByRole('row').nth(1).getByRole('checkbox').check();
  const bulk = page.getByRole('region', { name: 'المحدد: 1' });
  await expect(bulk.getByRole('button', { name: 'غير مهتم' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test.describe('phone 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('leads list, a lead, CRM settings and the public form fit the screen', async ({ page }) => {
    await page.goto('/trial');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await signIn(page);
    await expectNoHorizontalScroll(page);
    for (const path of ['/leads/1', '/leads/6', '/settings/crm']) {
      await page.goto(path);
      await expect(page.locator('#main h1').first()).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page);
    }
  });
});
