import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, localParts, NAMES, shot, signIn } from './helpers';

/**
 * J4 «إجازة وتعويض وتأجيل» (leave, make-up, postponement), on the real stack: staff give a second
 * child of the QA family a weekly class → the parent asks for leave on tomorrow's class (approved
 * on its own: enough notice) → the parent asks for a make-up of that class → the parent asks to
 * postpone next week's class → staff approve both on «طلبات الحصص» → the make-up class exists and
 * next week's class moves → the teacher sees the leave, the make-up and the new time → the parent
 * sees the requests decided, with no staff names (D142).
 *
 * The make-up request goes through the API as the parent: no screen offers it today (the parent's
 * and the staff's class menus on a leave class have no make-up action; docs/31 bug).
 */
const STEPS = [
  'Staff give the child a weekly class; the parent sees tomorrow’s class',
  'The parent asks for leave on tomorrow’s class → approved automatically (enough notice)',
  'The parent asks for a make-up of the leave class (API: no screen offers it yet)',
  'The parent asks to postpone next week’s class → «pending review»',
  'Staff approve both on «طلبات الحصص» → the make-up class exists, next week’s class moves',
  'The teacher sees the leave, the make-up and the new time',
  'The parent sees the requests decided — no staff names (D142)',
] as const;

const CHILD = 'QA Leave Student';
const ZONE = 'Europe/London';
const DAY = 24 * 3_600_000;

/** A new signed-out context where every request off localhost gets a stub page. */
async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  await context.route(/^https?:\/\/(?!localhost[:/])/, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>QA stub</title>QA: external link' }),
  );
  return context.newPage();
}

/** The family's local `HH:MM` on a date, as an instant (London is UTC+0 in winter, +1 in summer). */
function londonInstant(date: string, time: string): string {
  for (const offset of ['+00:00', '+01:00']) {
    const at = new Date(`${date}T${time}:00${offset}`);
    const back = localParts(at, ZONE);
    if (back.date === date && back.time === time) return at.toISOString().replace('.000', '');
  }
  throw new Error(`no London instant for ${date} ${time}`);
}

type Session = {
  id: number;
  stage: string;
  kind: string;
  startsAt: string;
  occurrenceDate: string;
};

test(
  'J4 leave, make-up and postponement',
  { tag: '@J4', annotation: STEPS.map((description) => ({ type: 'step', description })) },
  async ({ browser }, testInfo) => {
    const staff = await newPage(browser);
    const parent = await newPage(browser);
    const teacher = await newPage(browser);
    const step = (n: number, body: () => Promise<void>) => test.step(`${n}. ${STEPS[n - 1]}`, body);
    const tomorrow = localParts(new Date(Date.now() + DAY), ZONE);
    const nextWeek = localParts(new Date(Date.now() + 8 * DAY), ZONE);
    const makeupDay = localParts(new Date(Date.now() + 3 * DAY), ZONE);
    let enrollmentId = 0;
    let leaveClass: Session | undefined;
    const sessions = async () =>
      (await api(staff).get(`/sessions?enrollmentId=${enrollmentId}&perPage=50`)).body
        .data as Session[];

    await step(1, async () => {
      await signIn(staff, 'qa-admin');
      const people = api(staff);
      const student = (
        (await people.get(`/students?search=${encodeURIComponent(CHILD)}`)).body.data as Array<{
          name: string;
          id: number;
          regularCourse: { id: number };
        }>
      ).find((s) => s.name === CHILD)!;
      const qaTeacher = (await people.get('/teachers?perPage=10')).body.data.find(
        (t: { name: string }) => t.name === NAMES.teacher,
      );
      const created = await people.send('POST', '/enrollments', {
        studentId: student.id,
        courseId: student.regularCourse.id,
        teacherId: qaTeacher.id,
        kind: 'regular',
        startsOn: localParts(new Date(), ZONE).date,
        sessionMinutes: 30,
        timezone: ZONE,
        meetingMode: 'external',
        externalMeetingUrl: 'https://us02web.zoom.us/j/9000000003?pwd=qa',
        slots: [{ weekday: tomorrow.weekday, localStartTime: '18:00' }],
        // The QA teacher has no work hours, and London and Cairo change clocks on other dates.
        acknowledgeWarnings: ['outside_work_hours', 'dst_shift'],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      enrollmentId = created.body.data.id;
      const all = await sessions();
      leaveClass = all.find((s) => s.occurrenceDate === tomorrow.date);
      expect(leaveClass, 'tomorrow’s class').toBeTruthy();
      expect(
        all.some((s) => s.occurrenceDate === nextWeek.date),
        'next week’s class',
      ).toBe(true);

      await signIn(parent, 'qa-parent');
      await parent.goto(`/my-classes?week=${tomorrow.date}`);
      await expect(parent.getByRole('row', { name: new RegExp(CHILD) }).first()).toContainText(
        'مجدولة',
      );
      await shot(parent, testInfo, 1, 'parent-week');
    });

    await step(2, async () => {
      const row = parent.getByRole('row', { name: new RegExp(CHILD) }).first();
      await row.getByRole('button', { name: `إجراءات أخرى: ${CHILD}` }).click();
      await parent.getByRole('menuitem', { name: 'طلب إجازة' }).click();
      const dialog = parent.getByRole('dialog', { name: `طلب إجازة — ${CHILD}` });
      await dialog.getByRole('textbox', { name: 'السبب' }).fill('QA: family travel');
      await dialog.getByRole('button', { name: 'أرسل الطلب' }).click();
      await expect(row).toContainText('إجازة');
      expect((await sessions()).find((s) => s.id === leaveClass!.id)!.stage).toBe('leave');
      const mine = (await api(parent).get('/session-requests')).body.data as Array<{
        type: string;
        status: string;
      }>;
      expect(mine.find((r) => r.type === 'leave')?.status).toBe('auto_approved');
      await shot(parent, testInfo, 2, 'leave-approved');
    });

    await step(3, async () => {
      const made = await api(parent).send('POST', '/session-requests', {
        type: 'reschedule',
        sessionId: leaveClass!.id,
        proposedStartsAt: londonInstant(makeupDay.date, '17:00'),
        reason: 'QA: make-up for the travel day',
      });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      expect(made.body.data).toMatchObject({ status: 'pending', type: 'reschedule' });
    });

    await step(4, async () => {
      await parent.goto(`/my-classes?week=${nextWeek.date}`);
      const row = parent.getByRole('row', { name: new RegExp(CHILD) }).first();
      await row.getByRole('button', { name: `إجراءات أخرى: ${CHILD}` }).click();
      await parent.getByRole('menuitem', { name: 'طلب تأجيل' }).click();
      const dialog = parent.getByRole('dialog', { name: `طلب تأجيل — ${CHILD}` });
      // The dialog proposes the next day at the same time (the parent's zone): kept as is.
      await dialog.getByRole('textbox', { name: 'السبب' }).fill('QA: exams week');
      await dialog.getByRole('button', { name: 'أرسل الطلب' }).click();
      await expect(row).toContainText('طلب قيد المراجعة');
      await shot(parent, testInfo, 4, 'postpone-pending');
    });

    await step(5, async () => {
      await staff.goto('/requests');
      const list = staff.getByRole('list', { name: 'طلبات الحصص' });
      await expect(list.getByRole('listitem')).toHaveCount(2);
      await shot(staff, testInfo, 5, 'requests-pending');
      for (let left = 1; left >= 0; left--) {
        await list
          .getByRole('button', { name: `موافقة : ${CHILD}` })
          .first()
          .click();
        // Warnings (e.g. outside the teacher's work hours): ticked in the dialog, then confirmed.
        const dialog = staff.getByRole('dialog');
        if (await dialog.isVisible().catch(() => false)) {
          for (const box of await dialog.getByRole('checkbox').all()) await box.check();
          await dialog.getByRole('button', { name: 'وافق على الطلب' }).click();
        }
        await expect(list.getByRole('listitem')).toHaveCount(left);
      }
      type Decided = {
        type: string;
        status: string;
        resultSessionId: number | null;
        session: { id: number };
      };
      // The list drops a request as soon as it is approved; the server may still be saving it.
      const reschedules = async () =>
        ((await api(staff).get('/session-requests?status=decided')).body.data as Decided[]).filter(
          (r) => r.type === 'reschedule',
        );
      await expect
        .poll(async () => (await reschedules()).map((r) => r.status))
        .toEqual(['approved', 'approved']);
      const decided = await reschedules();
      const all = await sessions();
      const makeupId = decided.find((r) => r.session.id === leaveClass!.id)!.resultSessionId;
      const makeup = all.find((s) => s.id === makeupId);
      expect(makeup, 'the make-up class').toMatchObject({
        kind: 'rescheduled',
        stage: 'scheduled',
      });
      // A make-up is not from the weekly schedule (no occurrence date): its time is the one asked.
      expect(localParts(new Date(makeup!.startsAt), ZONE)).toMatchObject({
        date: makeupDay.date,
        time: '17:00',
      });
      expect(all.find((s) => s.id === leaveClass!.id)!.stage).toBe('leave');
    });

    await step(6, async () => {
      await signIn(teacher, 'qa-teacher');
      const rowsOf = async (date: string) => {
        await teacher.goto(`/my-classes?week=${date}`);
        await expect(teacher.locator('[aria-busy="true"]')).toHaveCount(0);
        return teacher.getByRole('row', { name: new RegExp(CHILD) });
      };
      // Tomorrow: on leave. The make-up day: the make-up at 5:00 م London. Next week: the class
      // «moved», and its replacement on the requested day (6:00 م London).
      await expect((await rowsOf(tomorrow.date)).filter({ hasText: 'إجازة' })).toHaveCount(1);
      const makeupRows = (await rowsOf(makeupDay.date)).filter({ hasText: 'تعويضية' });
      await expect(makeupRows.filter({ hasText: '5:00 م (لندن)' })).toHaveCount(1);
      await shot(teacher, testInfo, 6, 'teacher-week');
      const later = await rowsOf(nextWeek.date);
      await expect(later.filter({ hasText: 'نُقلت' })).toHaveCount(1);
      await expect(
        later.filter({ hasText: 'تعويضية' }).filter({ hasText: '6:00 م (لندن)' }),
      ).toHaveCount(1);
    });

    await step(7, async () => {
      await parent.goto('/my-requests');
      await expect(parent.locator('[aria-busy="true"]')).toHaveCount(0);
      await expect(parent.getByText(NAMES.admin)).toHaveCount(0);
      await shot(parent, testInfo, 7, 'parent-requests');
      const statuses = (
        (await api(parent).get('/session-requests')).body.data as Array<{
          status: string;
        }>
      ).map((r) => r.status);
      expect(statuses.sort()).toEqual(['approved', 'approved', 'auto_approved']);
      // D142 in the API answers too: parents and teachers never get the deciding staff member's
      // name or id (#150).
      for (const page of [parent, teacher]) {
        const answer = (await api(page).get('/session-requests')).body as {
          data: Array<{ status: string; decidedBy: Record<string, unknown> | null }>;
        };
        expect(JSON.stringify(answer)).not.toContain(NAMES.admin);
        for (const r of answer.data.filter((x) => x.status === 'approved')) {
          // The role at most: never who it was.
          expect(r.decidedBy?.name ?? null).toBeNull();
          expect(r.decidedBy?.id ?? null).toBeNull();
        }
      }
    });
  },
);
