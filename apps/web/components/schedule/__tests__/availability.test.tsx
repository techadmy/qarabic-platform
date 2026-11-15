import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MyScheduleView } from '@/app/(app)/my-schedule/my-schedule-view';
import { AvailabilityQueueView } from '@/app/(app)/schedule/availability-requests/queue-view';
import { TimetableView } from '@/app/(app)/teachers/[id]/timetable/timetable-view';
import { replaceWorkHours } from '@/lib/api/schedule';
import { mockSignIn } from '@/mocks/handlers';
import { sdb } from '@/mocks/schedule-db';
import { renderPage } from '@/test/people';

const TEACHER = 'teacher@qarabic.test';

/** The demo teacher asks for new hours (as the API would get it from the portal). */
async function teacherAsks() {
  mockSignIn(TEACHER);
  const r = await replaceWorkHours(1, {
    workHours: [{ weekday: 6, localStartTime: '10:00', localEndTime: '12:00' }],
    requestNote: 'أفضّل الصباح',
  });
  expect(r.pending).toBe(true);
}

describe('A1 availability (docs/42 §4, B131)', () => {
  it('a teacher’s change is a request: it waits, shows its status and can be withdrawn', async () => {
    const user = userEvent.setup();
    const before = JSON.stringify(sdb.workHours.get(1) ?? []);
    renderPage(<MyScheduleView />, { as: TEACHER, path: '/my-schedule' });
    await user.click(await screen.findByRole('button', { name: 'أضف فترة' }));
    expect(screen.getByLabelText('تسري من')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'أرسل الطلب للاعتماد' }));
    expect(await screen.findByText(/أُرسل طلب تعديل ساعات العمل للاعتماد/)).toBeInTheDocument();
    // Nothing changed yet.
    expect(JSON.stringify(sdb.workHours.get(1) ?? [])).toBe(before);
    const card = await screen.findByRole('region', { name: 'طلباتي لتعديل الإتاحة' });
    expect(within(card).getByText('بانتظار الاعتماد')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'سحب الطلب' }));
    expect(await within(card).findByText('مسحوب')).toBeInTheDocument();
  });

  it('staff approve from the queue: the hours apply; the booked classes outside them are listed', async () => {
    const user = userEvent.setup();
    await teacherAsks();
    renderPage(<AvailabilityQueueView />, { path: '/schedule/availability-requests' });
    const card = await screen.findByRole('region', { name: 'بانتظار الاعتماد' });
    expect(await within(card).findByText(/خارج الساعات الجديدة/)).toBeInTheDocument();
    expect(within(card).getByText('ملاحظة المعلم: أفضّل الصباح')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'اعتماد' }));
    expect(await screen.findByText(/اعتُمد طلب/)).toBeInTheDocument();
    await waitFor(() =>
      expect(sdb.workHours.get(1)).toEqual([
        expect.objectContaining({ weekday: 6, localStartTime: '10:00', localEndTime: '12:00' }),
      ]),
    );
  });

  it('a rejection needs a reason, which the teacher then sees', async () => {
    const user = userEvent.setup();
    await teacherAsks();
    const { unmount } = renderPage(<AvailabilityQueueView />, {
      path: '/schedule/availability-requests',
    });
    const card = await screen.findByRole('region', { name: 'بانتظار الاعتماد' });
    await user.click(await within(card).findByRole('button', { name: 'رفض' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'رفض' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: /سبب الرفض/ }), 'نحتاجك مساءً');
    await user.click(within(dialog).getByRole('button', { name: 'رفض' }));
    expect(await screen.findByText(/رُفض طلب/)).toBeInTheDocument();
    unmount();
    renderPage(<MyScheduleView />, { as: TEACHER, path: '/my-schedule' });
    expect(await screen.findByText('سبب القرار: نحتاجك مساءً')).toBeInTheDocument();
  });

  it('staff edits apply at once (no request)', async () => {
    const user = userEvent.setup();
    renderPage(<TimetableView id={1} />, { path: '/teachers/1/timetable' });
    await user.click(await screen.findByRole('button', { name: 'أضف فترة' }));
    expect(screen.queryByLabelText('تسري من')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'احفظ ساعات العمل' }));
    expect(await screen.findByText('حُفظت ساعات العمل')).toBeInTheDocument();
  });
});
