import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, cli, localParts, NAMES, postZoom, QA_ZOOM, shot, signIn, zoomEvent } from './helpers';

/**
 * J1 «يوم حصة» (class day), on the real stack: staff create an enrollment with an external meeting
 * link → today's class is generated → the class reminder goes out → the teacher activates it (the
 * join link opens) → Zoom reports the teacher and the student in the meeting (signed webhooks, as
 * Zoom sends them) → the teacher ends it and writes the lesson report → the parent sees it as held,
 * with the report, and no staff names or internal notes → the parent's notification is there.
 *
 * Every numbered `test.step` is one line on the QA dashboard, with its screenshot.
 */
const STEPS = [
  'QA personas are seeded and staff signs in',
  'Staff creates an enrollment (external link) → today’s class is generated',
  'Teacher sees the class and its join link, and activates it',
  'Zoom: teacher and student join (signed webhooks) → timeline and Today board',
  'Teacher ends the class and submits the lesson report',
  'Parent sees the class as held and the report — no staff names (D142)',
  'Parent’s notification is in the outbox (in-app bell; mail/WhatsApp off)',
] as const;

const REPORT = {
  summary: 'QA: revised An-Naba 1-16 with good fluency',
  homework: 'QA: repeat An-Naba 1-16 three times',
  internal: 'QA internal note — staff only',
};

/** A new signed-out context where every request off localhost gets a stub page. */
async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  await context.route(/^https?:\/\/(?!localhost[:/])/, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>QA stub</title>QA: external link' }),
  );
  return context.newPage();
}

test(
  'J1 class day',
  { tag: '@J1', annotation: STEPS.map((description) => ({ type: 'step', description })) },
  async ({ browser }, testInfo) => {
    const staff = await newPage(browser);
    const teacher = await newPage(browser);
    const parent = await newPage(browser);
    const step = (n: number, body: () => Promise<void>) => test.step(`${n}. ${STEPS[n - 1]}`, body);
    let sessionId = 0;

    await step(1, async () => {
      await signIn(staff, 'qa-admin');
      const people = api(staff);
      const teachers = (await people.get('/teachers?perPage=10')).body.data;
      const students = (await people.get('/students?search=QA%20Student')).body.data;
      expect(teachers.map((t: { name: string }) => t.name)).toEqual([NAMES.teacher]);
      expect(students.map((s: { name: string }) => s.name)).toEqual([NAMES.student]);
      await shot(staff, testInfo, 1, 'staff-signed-in');
    });

    await step(2, async () => {
      const people = api(staff);
      const student = (await people.get('/students?search=QA%20Student')).body.data[0];
      const teacherRow = (await people.get('/teachers?perPage=10')).body.data[0];
      // A class «today» must not cross Cairo midnight: in the last minutes of the day, wait.
      const cairo = localParts(new Date(), 'Africa/Cairo');
      if (cairo.time >= '23:50') {
        const [h, m] = cairo.time.split(':').map(Number) as [number, number];
        await new Promise((r) => setTimeout(r, ((24 - h) * 60 - m + 1) * 60_000));
      }
      // Starts in ~6 minutes: inside the activation window (10 min before), still upcoming for the
      // reminder job.
      const start = localParts(new Date(Date.now() + 6 * 60_000), 'Africa/Cairo');
      const created = await people.send('POST', '/enrollments', {
        studentId: student.id,
        courseId: student.regularCourse.id,
        teacherId: teacherRow.id,
        kind: 'regular',
        startsOn: start.date,
        sessionMinutes: 30,
        timezone: 'Africa/Cairo',
        meetingMode: 'external',
        externalMeetingUrl: QA_ZOOM.joinUrl,
        slots: [{ weekday: start.weekday, localStartTime: start.time }],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.data.meetingMode).toBe('external');

      // The daily generator (POST /sessions/generate) is idempotent: today's class exists once.
      const generated = await people.send('POST', '/sessions/generate', { date: start.date });
      expect(generated.status).toBe(200);
      const sessions = (await people.get(`/sessions?enrollmentId=${created.body.data.id}`)).body
        .data as Array<{
        id: number;
        occurrenceDate: string;
        stage: string;
        zoom: { link: string };
      }>;
      const today = sessions.filter((s) => s.occurrenceDate === start.date);
      expect(today).toHaveLength(1);
      expect(today[0]).toMatchObject({ stage: 'scheduled', zoom: { link: 'external' } });
      sessionId = today[0]!.id;

      // The reminder job (every 5 minutes in production) runs once: teacher + parent.
      expect(cli('operations:notify')).toMatch(/class reminders: 2\b/);

      await staff.goto('/today');
      const row = staff.getByRole('row', { name: new RegExp(NAMES.student) });
      await expect(row).toContainText('مجدولة');
      await expect(row).toContainText('رابط خارجي');
      await shot(staff, testInfo, 2, 'today-board-scheduled');
    });

    await step(3, async () => {
      await signIn(teacher, 'qa-teacher');
      const next = teacher.getByRole('region', { name: 'الحصة التالية' });
      await expect(next.getByRole('link', { name: NAMES.student })).toBeVisible();
      await expect(
        next.getByRole('button', { name: `افتح الاجتماع: ${NAMES.student}` }),
      ).toBeVisible();
      // «ابدأ الحصة» activates the class and opens its meeting: the external link, exactly.
      const popup = teacher.context().waitForEvent('page');
      await next.getByRole('button', { name: `ابدأ الحصة : ${NAMES.student}` }).click();
      const tab = await popup;
      await expect.poll(() => tab.url()).toBe(QA_ZOOM.joinUrl);
      await tab.close();
      const running = teacher.getByRole('region', { name: 'الحصة الجارية الآن' });
      await expect(running).toContainText('مفعّلة');
      expect((await api(staff).get(`/sessions/${sessionId}`)).body.data.stage).toBe('activated');
      await shot(teacher, testInfo, 3, 'teacher-activated');
    });

    await step(4, async () => {
      const zoom = teacher.context().request;
      const now = Date.now();
      await postZoom(zoom, zoomEvent('meeting.started', new Date(now - 60_000)));
      await postZoom(
        zoom,
        zoomEvent('meeting.participant_joined', new Date(now - 60_000), { teacher: true }),
      );
      await postZoom(
        zoom,
        zoomEvent('meeting.participant_joined', new Date(now - 30_000), { teacher: false }),
      );
      await postZoom(
        zoom,
        zoomEvent('meeting.participant_left', new Date(now), { teacher: false, left: true }),
      );
      const people = api(staff);
      await expect
        .poll(async () => (await people.get(`/sessions/${sessionId}`)).body.data.evidence, {
          timeout: 20_000,
        })
        .toMatchObject({
          teacherJoinedAt: expect.any(String),
          studentJoinedAt: expect.any(String),
          actualStartedAt: expect.any(String),
        });
      const events = (await people.get(`/sessions/${sessionId}`)).body.data.events.map(
        (e: { type: string }) => e.type,
      );
      expect(events).toEqual(
        expect.arrayContaining([
          'activated',
          'zoom_meeting_started',
          'participant_joined',
          'participant_left',
        ]),
      );

      // Today board: both joined; the class sheet: the evidence and the timeline.
      await staff.goto('/today');
      const row = staff.getByRole('row', { name: new RegExp(NAMES.student) });
      await expect(row).toContainText('مفعّلة');
      await expect(row.getByRole('img', { name: 'دخل' })).toHaveCount(2);
      await row.getByRole('button', { name: NAMES.student, exact: true }).click();
      const sheet = staff.getByRole('dialog', { name: 'تفاصيل الحصة' });
      const evidence = sheet.getByRole('region', { name: 'إثبات الحضور' });
      await expect(evidence).toBeVisible();
      await expect(evidence.getByText('لم يدخل')).toHaveCount(0);
      const timeline = sheet.getByRole('region', { name: 'سجل الحصة' });
      await expect(timeline.getByText('دخل مشارك').first()).toBeVisible();
      await expect(timeline.getByText('خرج مشارك').first()).toBeVisible();
      await shot(staff, testInfo, 4, 'timeline-and-board');
      await staff.keyboard.press('Escape');
    });

    await step(5, async () => {
      await teacher.reload();
      await teacher.getByRole('button', { name: `أنهِ الحصة : ${NAMES.student}` }).click();
      await teacher.getByRole('button', { name: `اكتب التقرير : ${NAMES.student}` }).click();
      const form = teacher.getByRole('form', { name: 'تقرير الحصة' });
      await form.getByRole('textbox', { name: 'ملخص الحصة' }).fill(REPORT.summary);
      await form.getByRole('textbox', { name: 'الواجب (اختياري)' }).fill(REPORT.homework);
      await form.getByRole('textbox', { name: 'ملاحظات داخلية (اختياري)' }).fill(REPORT.internal);
      await shot(teacher, testInfo, 5, 'report-form');
      await form.getByRole('button', { name: 'حفظ التقرير' }).click();
      await expect
        .poll(async () => (await api(staff).get(`/sessions/${sessionId}`)).body.data.stage)
        .toBe('taken');
      const report = (await api(staff).get(`/sessions/${sessionId}/report`)).body.data;
      expect(report).toMatchObject({ summary: REPORT.summary, homework: REPORT.homework });
    });

    await step(6, async () => {
      await signIn(parent, 'qa-parent');
      const reports = parent.getByRole('region', { name: 'آخر تقارير الحصص' });
      await expect(reports).toContainText(REPORT.summary);
      await parent.goto('/my-classes');
      const row = parent.getByRole('row', { name: new RegExp(NAMES.student) }).first();
      await expect(row).toContainText('منعقدة');
      await row.getByRole('button', { name: NAMES.student, exact: true }).click();
      const sheet = parent.getByRole('dialog', { name: 'تفاصيل الحصة' });
      await expect(sheet).toContainText(REPORT.summary);
      await expect(sheet).toContainText(REPORT.homework);
      await shot(parent, testInfo, 6, 'parent-report');

      // D142: no staff names and no internal notes, on screen or in the parent's API answers.
      for (const text of [NAMES.admin, REPORT.internal]) {
        await expect(parent.getByText(text)).toHaveCount(0);
      }
      const mine = api(parent);
      const answers = JSON.stringify([
        (await mine.get(`/sessions/${sessionId}`)).body,
        (await mine.get(`/sessions/${sessionId}/report`)).body,
      ]);
      expect(answers).toContain(REPORT.summary);
      expect(answers).not.toContain(NAMES.admin);
      expect(answers).not.toContain(REPORT.internal);
    });

    await step(7, async () => {
      const inbox = (await api(parent).get('/me/notifications')).body;
      const reminder = inbox.data.find(
        (n: { kind: string; data: { sessionId?: number } }) =>
          n.kind === 'class_reminder' && n.data.sessionId === sessionId,
      );
      expect(reminder, 'the class reminder in the parent’s bell').toBeTruthy();
      expect(JSON.stringify(inbox)).not.toContain(NAMES.admin);
      await parent.goto('/');
      await parent.getByRole('button', { name: /^الإشعارات/ }).click();
      await expect(parent.getByText(`تذكير: حصة ${NAMES.student}`)).toBeVisible();
      await shot(parent, testInfo, 7, 'parent-notifications');
    });
  },
);
