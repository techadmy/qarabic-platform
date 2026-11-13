import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MyClassesView } from '@/app/(app)/my-classes/my-classes-view';
import { sdb } from '@/mocks/schedule-db';
import { lastReplacedUrl, renderPage } from '@/test/people';

const TEACHER = 'teacher@qarabic.test';

/** One of the demo teacher's (teacher 1) ended classes, made a trial class for the test. */
function endedTrial() {
  const s = sdb.sessions
    .filter((x) => x.teacherId === 1 && x.stage === 'ended' && !x.deleted)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0]!;
  s.kind = 'trial';
  return s;
}

describe('T4 trial report (B85)', () => {
  it('a trial class shows «تقرير الحصة التجريبية», not the lesson report', async () => {
    const s = endedTrial();
    renderPage(<MyClassesView />, { as: TEACHER, path: `/my-classes?session=${s.id}` });
    const sheet = await screen.findByRole('dialog', { name: 'تفاصيل الحصة' });
    expect(
      await within(sheet).findByText('لم يُكتب تقرير الحصة التجريبية بعد؛ تُغلق الحصة به.'),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole('button', { name: 'اكتب تقرير الحصة التجريبية' }),
    ).toBeInTheDocument();
    expect(within(sheet).queryByText('تقرير الحصة', { exact: true })).toBeNull();
  });

  it('the teacher writes it: required choices first, then it closes the class', async () => {
    const user = userEvent.setup();
    const s = endedTrial();
    renderPage(<MyClassesView />, { as: TEACHER, path: `/my-classes?session=${s.id}&report=1` });
    const sheet = await screen.findByRole('dialog', { name: 'تفاصيل الحصة' });
    const form = await within(sheet).findByRole('form', { name: 'تقرير الحصة التجريبية' });
    await user.click(within(form).getByRole('button', { name: 'أرسل التقرير وأغلق الحصة' }));
    // Attendance, level and engagement have no default: each says so.
    await waitFor(() =>
      expect(
        within(form)
          .getAllByRole('radiogroup')
          .filter((g) => g.getAttribute('aria-invalid')),
      ).toHaveLength(3),
    );
    expect(s.stage).toBe('ended');

    await user.click(within(form).getByRole('radio', { name: 'حضر في الموعد' }));
    await user.click(within(form).getByRole('radio', { name: 'مبتدئ' }));
    await user.click(within(form).getByRole('radio', { name: 'مرتفع' }));
    await user.type(within(form).getByLabelText(/ملاحظات لخدمة العملاء/), 'Shy at first.');
    await user.click(within(form).getByRole('button', { name: 'أرسل التقرير وأغلق الحصة' }));
    await waitFor(() => expect(s.stage).toBe('taken'));
    expect(await screen.findByText(/أُرسل تقرير الحصة التجريبية/)).toBeInTheDocument();
    // Back on the class: the report reads back.
    // The sheet leaves the form (the URL drops `report`); the saved report fills it next time.
    expect(lastReplacedUrl().searchParams.get('report')).toBeNull();
    expect(
      await within(sheet).findByRole('form', { name: 'تعديل تقرير الحصة التجريبية' }),
    ).toBeInTheDocument();
    expect(within(sheet).getByLabelText(/ملاحظات لخدمة العملاء/)).toHaveValue('Shy at first.');
  });
});
