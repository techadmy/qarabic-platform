import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations, login } from './helpers';

/**
 * N3 teaching against the MSW mocks (production build, mocks on). The mock data is built from the
 * page clock when the app loads; flows that need time to pass (a class must run 25 minutes before
 * its teacher may end it) drive it with Playwright's `page.clock`, so they pass at any hour.
 * Steps that change data stay in one page (client navigation), since a reload rebuilds the mocks.
 */

async function signIn(page: Page, email: string, path: string) {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await login(page, email);
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[?]/g, '\\?')}$`));
}

/** «6:15 م» of an instant in Cairo, as the app's time picker writes it. */
function cairoClock(ms: number) {
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Africa/Cairo',
  }).format(new Date(ms));
}

test('teacher: week → start → end → write the report → edit it inside the window', async ({
  page,
  context,
}) => {
  // Midday in Cairo today (12:00 UTC+2; 13:00 in summer time): with the real time, a run at Friday ~23:55 started the class at 23:59 and
  // the 30 minutes below crossed into Saturday, a new week, so «تحديث» lost the running class.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
  await page.clock.install({ time: new Date(`${today}T12:00:00+02:00`) });
  // The meeting opens in a new tab on «ابدأ الحصة»; close any such tab.
  context.on('page', (p) => void p.close());
  await signIn(page, 'teacher@qarabic.test', '/');
  // The sidebar's link: the teacher home (M9) has a «حصصي» link of its own.
  await page.locator('[data-slot="sidebar"]').first().getByRole('link', { name: 'حصصي' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'حصصي' })).toBeVisible();
  await expect(page.getByText('بلا تقرير').first()).toBeVisible();

  // The class that starts in 5 minutes (the activation window is open).
  const start = page.getByRole('button', { name: /ابدأ الحصة/ }).first();
  await expect(start).toBeVisible();
  const id = await page
    .locator('tr[data-session-id]')
    .filter({ has: start })
    .getAttribute('data-session-id');
  const row = page.locator(`tr[data-session-id="${id}"]`);
  const name = (await row.getByRole('button').first().textContent())!.trim();
  await start.click();
  await expect(row.getByText('مفعّلة').or(row.getByText('جارية')).first()).toBeVisible();

  // 30 minutes later the teacher may end it.
  await page.clock.fastForward('30:00');
  await page.getByRole('button', { name: 'تحديث' }).click();
  const end = row.getByRole('button', { name: /أنهِ الحصة/ });
  await expect(end).toBeVisible();
  await end.click();

  // «اكتب التقرير» opens the report form in the class sheet.
  const write = row.getByRole('button', { name: /اكتب التقرير/ });
  await expect(write).toBeVisible();
  await write.click();
  const sheet = page.getByRole('dialog', { name: 'تفاصيل الحصة' });
  const form = sheet.getByRole('form', { name: 'تقرير الحصة' });
  await expect(form).toBeVisible();
  await form.getByLabel(/ملخص الحصة/).fill('Read the new ayahs with good tajweed.');
  await form.getByRole('radio', { name: '5 من 5' }).click();
  await form.getByRole('button', { name: 'حفظ التقرير' }).click();
  await expect(page.getByText(`حُفظ تقرير حصة ${name}`)).toBeVisible();

  // The sheet shows the sent report; the teacher may still edit it.
  await expect(sheet.getByText('Read the new ayahs with good tajweed.')).toBeVisible();
  await sheet.getByRole('button', { name: 'تعديل التقرير' }).click();
  const edit = sheet.getByRole('form', { name: 'تعديل تقرير الحصة' });
  await expect(edit.getByText(/يمكنك تعديل التقرير حتى/)).toBeVisible();
  await edit.getByLabel(/الواجب/).fill('Repeat the lesson three times.');
  await edit.getByRole('button', { name: 'حفظ التقرير' }).click();
  await expect(page.getByText('حُفظت تعديلات التقرير')).toBeVisible();
  await expect(sheet.getByText('Repeat the lesson three times.')).toBeVisible();
});

/**
 * Opens the first class of the list that is a lesson: a trial class closes through the trial
 * report instead (T4, B85), and the list does not show the kind, so it looks at the sheet.
 */
async function openLesson(page: Page, table: Locator) {
  const sheet = page.getByRole('dialog', { name: 'تفاصيل الحصة' });
  for (let i = 0; i < 8; i++) {
    const row = table.locator('tbody tr').nth(i);
    const name = (await row.getByRole('button').first().textContent())!.trim();
    await row.getByRole('button', { name }).first().click();
    await expect(sheet.getByText(name).first()).toBeVisible();
    const trial = sheet.getByRole('region', { name: 'تقرير الحصة التجريبية' });
    const lesson = sheet.getByRole('region', { name: 'تقرير الحصة', exact: true });
    await expect(trial.or(lesson)).toBeVisible();
    if (await lesson.isVisible()) return { sheet, name };
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  }
  throw new Error('no lesson among the first 8 classes');
}

test('staff: reports without a report → open the class', async ({ page }) => {
  await signIn(page, 'admin@qarabic.test', '/');
  await page.getByRole('link', { name: 'تقارير الحصص' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'تقارير الحصص' })).toBeVisible();
  await page.getByRole('radio', { name: /^بلا تقرير/ }).click();
  await expect(page).toHaveURL(/state=missing/);
  const table = page.getByRole('table', { name: 'تقارير الحصص' });
  await expect(table.locator('tbody tr').first().getByText('بلا تقرير').first()).toBeVisible();
  const { sheet } = await openLesson(page, table);
  await expect(sheet.getByText('لم يُرسَل تقرير هذه الحصة بعد.')).toBeVisible();
  // Staff may write it on the teacher's behalf.
  await expect(sheet.getByRole('button', { name: 'اكتب التقرير' })).toBeVisible();
  await expect(page).toHaveURL(/session=\d+/);
});

test('staff: schedule a test, then record its result', async ({ page }) => {
  // Midday in Cairo today (12:00 UTC+2): with the real clock, a run after 23:45 picked tomorrow's
  // 00:00 as «the next quarter hour» while the date stayed today (a time in the past).
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
  const now = Date.parse(`${day}T12:00:00+02:00`);
  await page.clock.install({ time: new Date(now) });
  await signIn(page, 'admin@qarabic.test', '/tests');
  await expect(page.getByRole('heading', { level: 1, name: 'الاختبارات والنتائج' })).toBeVisible();
  await page.getByRole('button', { name: 'جدولة اختبار' }).click();
  const dialog = page.getByRole('dialog', { name: 'جدولة اختبار' });
  await dialog.getByRole('combobox', { name: /الطالب/ }).click();
  await page.getByRole('option').nth(3).click();
  // The next quarter hour: within the 30 minutes before the test the result can be recorded.
  const next = Math.ceil((now + 1) / 900_000) * 900_000;
  await dialog.locator('#test-time').click();
  await page.getByRole('option', { name: cairoClock(next), exact: true }).click();
  // A student has one scheduled test per track: try the tracks until one is free.
  for (const track of ['القاعدة', 'التلاوة نظرًا', 'الحفظ']) {
    await dialog.getByRole('radio', { name: track }).click();
    await dialog.getByRole('button', { name: 'جدولة الاختبار' }).click();
    if (
      await page.waitForURL(/\/tests\/\d+$/, { timeout: 3_000 }).then(
        () => true,
        () => false,
      )
    )
      break;
  }
  await expect(page).toHaveURL(/\/tests\/\d+$/);
  await expect(page.getByText(/^جُدول اختبار /)).toBeVisible();

  // Record: tick a mistake, pick the scores the track needs, save.
  await page.getByLabel('نطق الحروف غير سليم').click();
  await expect(
    page
      .getByText(/^التجويد: \d+%$/)
      .or(page.getByText(/التجويد:/))
      .first(),
  ).toBeVisible();
  for (const label of ['التلاوة', 'الحفظ']) {
    const group = page.getByRole('radiogroup', { name: new RegExp(`^${label}`) });
    if (await group.count()) await group.getByRole('radio', { name: '100%' }).click();
  }
  await page.getByRole('button', { name: 'حفظ النتيجة' }).click();
  await expect(page.getByText('حُفظت النتيجة')).toBeVisible();
  await expect(page.getByText('الدرجة الكلية')).toBeVisible();
  await expect(page.getByText('مخارج الحروف:')).toBeVisible();
  await expect(page.getByText('منجز').first()).toBeVisible();
});

test('parent sees the child progress without internal notes', async ({ page }) => {
  await signIn(page, 'parent@qarabic.test', '/');
  await page.getByRole('link', { name: 'عائلتي' }).click();
  await page.locator('a[href^="/students/"]').first().click();
  await expect(page).toHaveURL(/\/students\/\d+$/);
  const progress = page.getByRole('region', { name: /التقدم وسجل الدروس/ });
  await expect(progress.getByText('للاطلاع فقط')).toBeVisible();
  await expect(progress.getByRole('heading', { name: /^سجل الدروس/ })).toBeVisible();
  await expect(progress.getByText('ملاحظة داخلية')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'الاختبارات' })).toBeVisible();
});

test.describe('phone (375 px)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('no horizontal scroll on reports, tests, a test, the week and progress', async ({
    page,
  }) => {
    await signIn(page, 'admin@qarabic.test', '/lesson-reports');
    await expect(page.getByRole('list', { name: 'تقارير الحصص' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.goto('/tests');
    await expect(page.getByRole('list', { name: 'الاختبارات والنتائج' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.locator('a[href^="/tests/"]').first().click();
    await expect(page.getByText('بيانات الاختبار')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.goto('/students/1');
    await expect(page.getByRole('region', { name: /التقدم وسجل الدروس/ })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'حسابي' }).click();
    await page.getByRole('menuitem', { name: 'تسجيل الخروج' }).click();
    await login(page, 'teacher@qarabic.test');
    await expect(page.getByRole('heading', { name: 'مرحبًا، معلم تجريبي' })).toBeVisible();
    await page.goto('/my-classes');
    await expect(page.getByRole('heading', { level: 1, name: 'حصصي' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test('accessibility: report form, tests, a test and progress', async ({ page }) => {
  await signIn(page, 'admin@qarabic.test', '/lesson-reports?state=missing');
  await openLesson(page, page.getByRole('table', { name: 'تقارير الحصص' }));
  await page.getByRole('dialog').getByRole('button', { name: 'اكتب التقرير' }).click();
  await expect(page.getByRole('form', { name: 'تقرير الحصة' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.goto('/tests');
  await expect(page.getByRole('heading', { level: 1, name: 'الاختبارات والنتائج' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.locator('a[href^="/tests/"]').first().click();
  await expect(page.getByText('بيانات الاختبار')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'حسابي' }).click();
  await page.getByRole('menuitem', { name: 'تسجيل الخروج' }).click();
  await login(page, 'teacher@qarabic.test');
  await expect(page.getByRole('heading', { name: 'مرحبًا، معلم تجريبي' })).toBeVisible();
  await page.goto('/my-students');
  await expect(page.getByRole('heading', { level: 1, name: 'طلابي' })).toBeVisible();
  await page.locator('a[href^="/students/"]').first().click();
  await expect(page.getByRole('region', { name: /التقدم وسجل الدروس/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^سجل الدروس/ })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('teacher (phone, English): the trial report closes a trial class (T4, B85)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, 'teacher@qarabic.test', '/lesson-reports?state=missing');
  await page.locator('header').getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  // The list does not show the kind: open classes until a trial one (its sheet has the trial report).
  const sheet = page.getByRole('dialog', { name: 'Class details' });
  const write = sheet.getByRole('button', { name: 'Write the trial report' });
  let found = false;
  for (let i = 0; i < 12 && !found; i++) {
    // Phone: each class is a card link to its sheet.
    const rows = page.locator('main a[href*="session="]');
    if (i >= (await rows.count())) break;
    await rows.nth(i).click();
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByRole('region', { name: /^(Trial class report|Lesson report)$/ }),
    ).toBeVisible();
    found = await write.isVisible();
    if (!found) {
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
    }
  }
  expect(found, 'an ended trial class of the demo teacher').toBe(true);
  await write.click();
  const form = sheet.getByRole('form', { name: 'Trial class report' });
  await expect(form).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  const send = form.getByRole('button', { name: 'Send the report and close the class' });
  await expect(send).toBeInViewport();
  await send.click();
  await expect(form.getByText('Complete the required fields marked below.')).toBeVisible();
  await expect(form.getByRole('radio', { name: 'On time' })).toBeFocused();
  await form.getByRole('radio', { name: 'On time' }).check();
  await form.getByRole('radio', { name: 'Beginner' }).check();
  await form.getByRole('radio', { name: 'High' }).check();
  await send.click();
  await expect(page.getByText(/^Trial report for .+ sent\.$/)).toBeVisible();
  await expectNoHorizontalScroll(page);
});
