import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { EnrollmentView } from '@/app/(app)/schedule/[id]/enrollment-view';
import { NewEnrollmentView } from '@/app/(app)/schedule/new/new-enrollment-view';
import { ScheduleView } from '@/app/(app)/schedule/schedule-view';
import { sdb } from '@/mocks/schedule-db';
import { server } from '@/mocks/node';
import { renderPage } from '@/test/people';
import { routerMock } from '@/test/router-mock';

/** A valid `EnrollmentDto` for the stubbed writes (the shared schema parses every answer). */
function enrollmentDto(id: number) {
  const e = sdb.enrollments.find((x) => x.id === id)!;
  return { ...e, slots: [] };
}

const clean = () =>
  server.use(
    http.post('*/api/v1/schedule/check', () =>
      HttpResponse.json({ data: { conflicts: [], warnings: [] } }),
    ),
  );

describe('Enrollments list', () => {
  it('shows status tabs with counts and each enrollment’s weekly times', async () => {
    renderPage(<ScheduleView />, { path: '/schedule' });
    const table = await screen.findByRole('table', { name: 'الاشتراكات' });
    await waitFor(() => expect(table).not.toHaveAttribute('aria-busy'));
    const tabs = screen.getByRole('radiogroup', { name: 'تصفية حسب الحالة' });
    expect(within(tabs).getByRole('radio', { name: /^الكل\s*\(\d+\)$/ })).toBeChecked();
    expect(within(tabs).getByRole('radio', { name: /^موقوف مؤقتًا\s*\(1\)$/ })).toBeInTheDocument();
    expect(
      within(table).getAllByText(/(السبت|الأحد|الإثنين|الثلاثاء|الأربعاء|الخميس|الجمعة) \d/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'اشتراك جديد' })).toHaveAttribute(
      'href',
      '/schedule/new',
    );
  });
});

describe('Enrollment detail: weekly times', () => {
  it('shows the teacher’s side and the DST note, then edits a time from a date (versioned)', async () => {
    const user = userEvent.setup();
    clean();
    // A family in Dubai (no DST) with a teacher in Cairo (DST): the teacher's time moves.
    const e = sdb.enrollments.find((x) => x.timezone === 'Asia/Dubai' && x.status === 'active')!;
    // The first time listed (by weekday, then time).
    const slot = sdb.slots
      .filter((s) => s.enrollmentId === e.id)
      .sort(
        (a, b) => a.weekday - b.weekday || a.localStartTime.localeCompare(b.localStartTime),
      )[0]!;
    let body: Record<string, unknown> | null = null;
    server.use(
      http.patch('*/api/v1/schedule-slots/:id', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          data: {
            ...slot,
            id: 999,
            weekday: body.weekday,
            validFrom: body.effectiveFrom,
            teacherLocal: {
              timezone: 'Africa/Cairo',
              weekday: 1,
              time: '10:00',
              variesWithDst: true,
            },
          },
          affectedManualSessions: [],
        });
      }),
    );
    renderPage(<EnrollmentView id={e.id} />, { path: `/schedule/${e.id}` });
    const list = await screen.findByRole('list', { name: 'المواعيد الأسبوعية' });
    expect(within(list).getAllByText(/^المعلم: /).length).toBeGreaterThan(0);
    expect(within(list).getAllByText('يتغير وقت المعلم مع التوقيت الصيفي').length).toBeGreaterThan(
      0,
    );
    expect(within(list).getAllByText(/\(دبي\)/).length).toBeGreaterThan(0);

    await user.click(within(list).getAllByRole('button', { name: /^تعديل/ })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'تعديل الموعد' });
    // The DST note shows in the dialog too, as the time is picked.
    expect(within(dialog).getByText('يتغير وقت المعلم مع التوقيت الصيفي')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('combobox', { name: 'اليوم' }));
    const other = slot.weekday === 5 ? 'الخميس' : 'الجمعة';
    await user.click(await screen.findByRole('option', { name: other }));
    expect(await within(dialog).findByText('لا يوجد تعارض')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'احفظ الموعد' }));
    expect(await screen.findByText('تغيّر الموعد')).toBeInTheDocument();
    expect(body).toMatchObject({
      weekday: slot.weekday === 5 ? 4 : 5,
      localStartTime: slot.localStartTime,
      effectiveFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  it('pauses only with a reason and ends with a date (confirmed)', async () => {
    const user = userEvent.setup();
    const e = sdb.enrollments.find((x) => x.status === 'active')!;
    renderPage(<EnrollmentView id={e.id} />, { path: `/schedule/${e.id}` });
    await user.click(await screen.findByRole('button', { name: 'إيقاف مؤقت' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'إيقاف مؤقت' }));
    expect(await within(dialog).findByText('اختر السبب')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('combobox', { name: /سبب الإيقاف/ }));
    await user.click(await screen.findByRole('option', { name: 'العائلة في إجازة' }));
    await user.click(within(dialog).getByRole('button', { name: 'إيقاف مؤقت' }));
    expect(await screen.findByText('أُوقف الاشتراك مؤقتًا')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'استئناف' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'إنهاء الاشتراك' }));
    const end = await screen.findByRole('alertdialog');
    expect(within(end).getByText(/لا يمكن التراجع/)).toBeInTheDocument();
  });
});

describe('New enrollment', () => {
  it('walks the three steps, checks each weekly time and creates the enrollment', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post('*/api/v1/enrollments', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ data: enrollmentDto(1) }, { status: 201 });
      }),
    );
    clean();
    // Student 7 has no enrollment in Tajweed (course 4): the teacher (2) teaches it.
    renderPage(<NewEnrollmentView />, { path: '/schedule/new?studentId=7&teacherId=2' });
    await screen.findByText(/المواعيد بتوقيت العائلة/);
    await user.click(screen.getByRole('button', { name: 'التالي' }));
    expect(await screen.findAllByText('هذا الحقل مطلوب')).not.toHaveLength(0);
    await user.click(screen.getByRole('combobox', { name: /الدورة/ }));
    const course = (await screen.findAllByRole('option'))[0]!;
    await user.click(course);
    await user.type(screen.getByLabelText(/رابط الاجتماع/), 'https://meet.example.com/new-class');
    await user.click(screen.getByRole('button', { name: 'التالي' }));

    expect(await screen.findByText('لم تُضف مواعيد بعد.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'التالي' }));
    expect(screen.getByText('أضف موعدًا واحدًا على الأقل.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'أضف الموعد' }));
    expect(await screen.findAllByText('لا يوجد تعارض')).not.toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'التالي' }));

    expect(await screen.findByText('راجع قبل الإنشاء')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'أنشئ الاشتراك' }));
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(expect.stringMatching(/^\/schedule\/\d+$/)),
    );
    expect(body).toMatchObject({
      studentId: 7,
      teacherId: 2,
      kind: 'regular',
      meetingMode: 'external',
      externalMeetingUrl: 'https://meet.example.com/new-class',
      slots: [{ weekday: 6, localStartTime: '17:00', durationMinutes: 30 }],
    });
  });
});
