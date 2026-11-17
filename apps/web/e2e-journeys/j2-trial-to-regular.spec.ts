import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, localParts, NAMES, setQaPassword, shot, signIn } from './helpers';

/**
 * J2 «من التجريبية إلى المنتظم» (trial → regular), on the real stack: a parent asks for a free
 * trial on the public form → staff call, open the family account and book a trial today with the
 * trial teacher → the teacher runs it and writes the trial report → staff convert the family to
 * regular in the dialog (prefilled from that report) → the first regular class is generated → the
 * teacher sees it and the new parent signs in to see the child's teacher, the first class and the
 * trial summary, with no staff names or notes meant for staff (D142).
 *
 * Every numbered `test.step` is one line on the QA dashboard, with its screenshot.
 */
const STEPS = [
  'A parent asks for a free trial on the public form → a new lead',
  'Staff call, open the family account and book a trial today',
  'Trial teacher sees the trial, opens its link, runs and ends it',
  'Trial teacher submits the trial report → lead «trial done», staff notified',
  'Staff convert the family to regular (dialog prefilled from the report)',
  'The first regular class is generated; the teacher sees it',
  'The new parent signs in: teacher, first class, trial summary — no staff names (D142)',
] as const;

const LEAD = {
  parent: 'QA Lead Parent',
  email: 'qa-family2@qa.qarabic.test',
  student: 'QA Trial Student',
  zone: 'Europe/London',
  link: 'https://us02web.zoom.us/j/9000000002?pwd=qa',
};
const CSR_NOTE = 'QA: knows the letters — staff only';
/** The class course: the form's choice, kept through the trial and the conversion. */
const COURSE = 'القاعدة النورانية';
const WEEKDAYS_AR = ['', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'];

/** A new signed-out context where every request off localhost gets a stub page. */
async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  await context.route(/^https?:\/\/(?!localhost[:/])/, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>QA stub</title>QA: external link' }),
  );
  return context.newPage();
}

test(
  'J2 trial to regular',
  { tag: '@J2', annotation: STEPS.map((description) => ({ type: 'step', description })) },
  async ({ browser }, testInfo) => {
    const visitor = await newPage(browser);
    const staff = await newPage(browser);
    const teacher = await newPage(browser);
    const parent = await newPage(browser);
    const step = (n: number, body: () => Promise<void>) => test.step(`${n}. ${STEPS[n - 1]}`, body);
    let leadId = 0;
    let trialId = 0;
    let firstClassDate = '';

    await step(1, async () => {
      const courses = visitor.waitForResponse((r) => r.url().endsWith('/public/courses') && r.ok());
      await visitor.goto('/trial');
      // The form loads its courses after hydration: typing before that is wiped.
      await courses;
      await visitor.getByRole('textbox', { name: /الاسم الكامل/ }).fill(LEAD.parent);
      await visitor.getByRole('combobox', { name: /بلد الإقامة/ }).click();
      await visitor.keyboard.type('المملكة المتحدة');
      await visitor
        .getByRole('option', { name: /المملكة المتحدة/ })
        .first()
        .click();
      await visitor.getByRole('textbox', { name: /رقم واتساب/ }).fill('7700900123');
      await visitor.getByRole('textbox', { name: /البريد الإلكتروني/ }).fill(LEAD.email);
      await visitor.getByRole('textbox', { name: /اسم الطالب/ }).fill(LEAD.student);
      await visitor.getByRole('spinbutton', { name: /العمر/ }).fill('8');
      await visitor.getByRole('combobox', { name: /الجنس/ }).click();
      await visitor.getByRole('option', { name: 'أنثى' }).click();
      await visitor.getByRole('combobox', { name: /الدورة/ }).click();
      await visitor.getByRole('option', { name: COURSE }).click();
      await visitor.getByRole('checkbox', { name: 'السبت' }).check();
      await visitor.getByRole('checkbox', { name: 'مساءً' }).check();
      await visitor.getByRole('button', { name: 'أرسل الطلب' }).click();
      await expect(visitor.getByRole('heading', { name: /شكرًا لك/ })).toContainText(LEAD.parent);

      await signIn(staff, 'qa-admin');
      const leads = await api(staff).get(`/leads?status=all&q=${encodeURIComponent(LEAD.parent)}`);
      expect(leads.body.data).toHaveLength(1);
      expect(leads.body.data[0]).toMatchObject({ status: 'new', email: LEAD.email });
      leadId = leads.body.data[0].id;
      await staff.goto(`/leads?status=all&q=${encodeURIComponent(LEAD.parent)}`);
      const row = staff.getByRole('table', { name: 'العملاء المحتملون' }).getByRole('row').nth(1);
      await expect(row).toContainText(LEAD.parent);
      await expect(row).toContainText('جديد');
      await shot(staff, testInfo, 1, 'lead-listed');
    });

    await step(2, async () => {
      const people = api(staff);
      const me = (await people.get('/me')).body as { id: number };
      const assigned = await people.send('POST', `/leads/${leadId}/assign`, { userId: me.id });
      expect(assigned.status).toBe(200);
      await staff.goto(`/leads/${leadId}`);
      await staff.getByRole('combobox', { name: /نتيجة المكالمة/ }).click();
      await staff.getByRole('option', { name: 'تم الرد' }).click();
      await staff.getByRole('button', { name: 'سجّل', exact: true }).click();
      await expect(staff.getByText('سُجّل التواصل.')).toBeVisible();

      // The family account, then a trial today in ~6 minutes (the booking's date and time are in
      // the family's zone) with the trial teacher, on an external link.
      const lead = (await people.get(`/leads/${leadId}`)).body.data;
      const courseId = lead.children[0].courseId as number;
      const account = await people.send('POST', `/leads/${leadId}/account`, {
        parentName: LEAD.parent,
        email: LEAD.email,
        timezone: LEAD.zone,
        children: [{ name: LEAD.student, age: 8, gender: 'female', courseId }],
      });
      expect(account.status, JSON.stringify(account.body)).toBe(201);
      // A trial «today» must not cross the family's midnight: in the last minutes, wait.
      const london = localParts(new Date(), LEAD.zone);
      if (london.time >= '23:50') {
        const [h, m] = london.time.split(':').map(Number) as [number, number];
        await new Promise((r) => setTimeout(r, ((24 - h) * 60 - m + 1) * 60_000));
      }
      const start = localParts(new Date(Date.now() + 6 * 60_000), LEAD.zone);
      const teachers = (await people.get('/teachers?perPage=10')).body.data;
      const trialTeacher = teachers.find((t: { name: string }) => t.name === NAMES.trialTeacher);
      const booked = await people.send('POST', `/leads/${leadId}/trials`, {
        studentId: account.body.data.students[0].id,
        courseId,
        teacherId: trialTeacher.id,
        localDate: start.date,
        localTime: start.time,
        acknowledgeWarnings: [],
        meetingUrl: LEAD.link,
      });
      expect(booked.status, JSON.stringify(booked.body)).toBe(201);
      expect(booked.body.data).toMatchObject({ status: 'trial_scheduled' });
      trialId = booked.body.data.trial.sessionId;

      await staff.reload();
      await expect(staff.getByRole('heading', { level: 1, name: LEAD.parent })).toBeVisible();
      await expect(staff.getByText('حصة تجريبية محجوزة').first()).toBeVisible();
      await shot(staff, testInfo, 2, 'trial-booked');
    });

    await step(3, async () => {
      await signIn(teacher, 'qa-teacher2');
      const next = teacher.getByRole('region', { name: 'الحصة التالية' });
      await expect(next.getByRole('link', { name: LEAD.student })).toBeVisible();
      const popup = teacher.context().waitForEvent('page');
      await next.getByRole('button', { name: `ابدأ الحصة : ${LEAD.student}` }).click();
      const tab = await popup;
      await expect.poll(() => tab.url()).toBe(LEAD.link);
      await tab.close();
      await shot(teacher, testInfo, 3, 'trial-running');
      await teacher.getByRole('button', { name: `أنهِ الحصة : ${LEAD.student}` }).click();
      await expect
        .poll(async () => (await api(staff).get(`/sessions/${trialId}`)).body.data.stage)
        .toBe('ended');
    });

    await step(4, async () => {
      await teacher.getByRole('button', { name: `اكتب التقرير : ${LEAD.student}` }).click();
      const form = teacher.getByRole('form', { name: 'تقرير الحصة التجريبية' });
      await form.getByRole('radio', { name: 'حضر في الموعد' }).check();
      await form.getByRole('radio', { name: 'مبتدئ' }).check();
      await form.getByRole('radio', { name: 'مرتفع' }).check();
      await form.getByRole('textbox', { name: 'ملاحظات لخدمة العملاء' }).fill(CSR_NOTE);
      await shot(teacher, testInfo, 4, 'trial-report');
      await form.getByRole('button', { name: 'أرسل التقرير وأغلق الحصة' }).click();
      const sheet = teacher.getByRole('dialog', { name: 'تفاصيل الحصة' });
      await expect(sheet.getByRole('region', { name: 'تقرير الحصة التجريبية' })).toContainText(
        'مبتدئ',
      );
      const people = api(staff);
      expect((await people.get(`/sessions/${trialId}`)).body.data.stage).toBe('taken');
      expect((await people.get(`/leads/${leadId}`)).body.data.status).toBe('trial_done');
      // The lead's owner (the CSR) gets the report in the bell.
      const bell = (await people.get('/me/notifications')).body.data as Array<{
        kind: string;
        event: string;
      }>;
      expect(bell.some((n) => n.kind === 'lead' && n.event === 'trial_report')).toBe(true);
    });

    await step(5, async () => {
      await staff.goto(`/leads/${leadId}`);
      await expect(staff.getByText('حضر التجريبية').first()).toBeVisible();
      await staff.getByRole('button', { name: 'حوّل إلى منتظم' }).first().click();
      const convert = staff.getByRole('dialog', { name: 'التحويل إلى منتظم' });
      // Prefilled from the trial report: the course, the teacher, two classes a week.
      await expect(convert.getByText(/من تقرير المعلم بعد الحصة التجريبية/)).toBeVisible();
      await expect(convert.getByRole('combobox', { name: 'المعلم' })).toHaveText(
        NAMES.trialTeacher,
      );
      // One weekly time: tomorrow (the family's zone) at 5:00 م.
      const tomorrow = localParts(new Date(Date.now() + 24 * 3_600_000), LEAD.zone);
      firstClassDate = tomorrow.date;
      await convert.getByRole('button', { name: 'احذف الموعد 2' }).click();
      await convert.getByRole('combobox', { name: 'يوم الموعد 1' }).click();
      await staff.getByRole('option', { name: WEEKDAYS_AR[tomorrow.weekday]! }).click();
      await convert.getByRole('combobox', { name: 'وقت الموعد 1' }).click();
      await staff.getByRole('option', { name: '5:00 م', exact: true }).click();
      await expect(staff.getByRole('listbox')).toHaveCount(0);
      await shot(staff, testInfo, 5, 'convert-dialog');
      await convert.getByRole('button', { name: 'حوّل إلى منتظم' }).click();
      // Soft warnings (e.g. the DST shift between London and Cairo) are ticked, then sent again.
      const boxes = convert.getByRole('alert').getByRole('checkbox');
      await expect(staff.getByText('تحوّلت العائلة إلى منتظمة.').or(boxes.first())).toBeVisible();
      if (await boxes.count()) {
        for (const box of await boxes.all()) await box.check();
        await convert.getByRole('button', { name: 'حوّل إلى منتظم' }).click();
      }
      await expect(staff.getByText('تحوّلت العائلة إلى منتظمة.')).toBeVisible();
      await expect(staff.getByText(/تحوّل إلى منتظم في /)).toBeVisible();
      expect((await api(staff).get(`/leads/${leadId}`)).body.data.status).toBe('converted');
    });

    await step(6, async () => {
      const people = api(staff);
      const enrollments = (await people.get('/enrollments?perPage=50')).body.data as Array<{
        id: number;
        kind: string;
        student: { name: string };
      }>;
      const regular = enrollments.find(
        (e) => e.student.name === LEAD.student && e.kind === 'regular',
      );
      expect(regular, 'the regular enrollment').toBeTruthy();
      const sessions = (await people.get(`/sessions?enrollmentId=${regular!.id}`)).body
        .data as Array<{ occurrenceDate: string; kind: string; stage: string }>;
      expect(sessions[0]).toMatchObject({
        occurrenceDate: firstClassDate,
        kind: 'regular',
        stage: 'scheduled',
      });

      await teacher.goto('/');
      const week = teacher.getByRole('region', { name: 'الأيام الخمسة القادمة' });
      // The days ahead show a count per day: tomorrow has the one class (this teacher has no other).
      await expect(week).toContainText('حصة واحدة');
      await shot(teacher, testInfo, 6, 'teacher-first-class');
    });

    await step(7, async () => {
      setQaPassword(LEAD.email);
      await signIn(parent, 'qa-family2');
      const children = parent.getByRole('region', { name: 'الأبناء' });
      await expect(children.getByRole('heading', { name: LEAD.student })).toBeVisible();
      await expect(children).toContainText(NAMES.trialTeacher);
      const next = parent.getByRole('region', { name: `الحصة القادمة · ${LEAD.student}` });
      await expect(next).not.toContainText('لا توجد حصة قادمة');
      const reports = parent.getByRole('region', { name: 'آخر تقارير الحصص' });
      await expect(reports).toContainText('حصة تجريبية');
      await expect(reports).toContainText('مبتدئ');
      await shot(parent, testInfo, 7, 'parent-home');

      // D142: no staff names, no notes meant for staff — on screen or in the parent's answers.
      for (const text of [NAMES.admin, CSR_NOTE]) {
        await expect(parent.getByText(text)).toHaveCount(0);
      }
      const mine = api(parent);
      const answers = JSON.stringify([
        (await mine.get('/parent/home')).body,
        (await mine.get(`/sessions/${trialId}`)).body,
        (await mine.get('/me/notifications')).body,
      ]);
      expect(answers).not.toContain(NAMES.admin);
      expect(answers).not.toContain(CSR_NOTE);
      // The trial report itself is for staff and the teacher only.
      expect((await mine.get(`/sessions/${trialId}/trial-report`)).status).toBe(403);
    });
  },
);
