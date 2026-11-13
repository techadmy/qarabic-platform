import type { TrialTeacherOptionDto, TrialTeachersQuery } from '@qarabic/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { TrialTeacherPicker } from '@/components/crm/trial-teacher-picker';
import { crmdb } from '@/mocks/crm-db';
import { zonedUtc } from '@/mocks/crm-handlers';
import { trialTeachers } from '@/mocks/trial-teachers';
import { renderPage } from '@/test/people';

const LEAD = 6; // Khadija Noor: has a family and a child

/** A week ahead at 7 pm in the family's zone: in the future, a normal teaching hour. */
function queryFor(courseId?: number): TrialTeachersQuery {
  const lead = crmdb.leads.find((l) => l.id === LEAD)!;
  const student = lead.students[0]!;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: lead.timezone }).format(
    new Date(Date.now() + 7 * 86_400_000),
  );
  return {
    studentId: student.id,
    // Course 2 is taught by teachers 1, 4 and 7 in the mocks.
    courseId: courseId ?? 2,
    localDate: day,
    localTime: '19:00',
    timezone: lead.timezone,
    durationMinutes: 30,
  };
}

function expected(query: TrialTeachersQuery) {
  const lead = crmdb.leads.find((l) => l.id === LEAD)!;
  return trialTeachers(
    lead,
    {
      studentId: Number(query.studentId),
      courseId: Number(query.courseId),
      localDate: query.localDate,
      localTime: query.localTime,
      timezone: query.timezone!,
      durationMinutes: 30,
    },
    zonedUtc(query.localDate, query.localTime, query.timezone!),
  ).data;
}

function Harness({ query }: { query: TrialTeachersQuery | null }) {
  const [value, setValue] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [selected, setSelected] = useState<TrialTeacherOptionDto | undefined>();
  return (
    <>
      <TrialTeacherPicker
        leadId={LEAD}
        query={query}
        value={value}
        onChange={setValue}
        onSelected={setSelected}
        overrideReason={reason}
        onOverrideReason={setReason}
        showErrors
      />
      <output aria-label="selected">
        {selected ? `${selected.teacher.id}:${selected.eligible}` : ''}
      </output>
    </>
  );
}

describe('T2 trial teacher picker', () => {
  it('asks for the time first', async () => {
    renderPage(<Harness query={null} />, { path: `/leads/${LEAD}` });
    expect(
      await screen.findByText('اختر الطالب والدورة والموعد لعرض المعلمين المتاحين.'),
    ).toBeInTheDocument();
  });

  it('lists the eligible teachers in the server’s order, with why they rank there', async () => {
    const query = queryFor();
    const want = expected(query);
    expect(want.eligible.length).toBeGreaterThan(1);
    renderPage(<Harness query={query} />, { path: `/leads/${LEAD}` });
    const group = await screen.findByRole('radiogroup', { name: 'المعلم' });
    const radios = within(group).getAllByRole('radio');
    // Eligible first, in rank order; the others stay collapsed.
    expect(radios).toHaveLength(want.eligible.length);
    expect(radios.map((r) => r.closest('label')!.textContent)).toEqual(
      want.eligible.map((o) => expect.stringContaining(o.teacher.name)),
    );
    const first = radios[0]!.closest('label')!;
    expect(first).toHaveTextContent('#1');
    expect(first).toHaveTextContent(/داخل ساعات العمل|خارج ساعات العمل/);
    expect(first).toHaveTextContent(/نسبة التحويل \d+٪/);
    expect(first).toHaveTextContent(/متاحة هذا الأسبوع|ساعات العمل غير محددة/);
  });

  it('«عرض غير المتاحين» shows the reasons; an overridable teacher needs a reason, a busy one is off', async () => {
    const user = userEvent.setup();
    const query = queryFor();
    const want = expected(query);
    const notAccepting = want.ineligible.find((o) => o.reasons.includes('not_accepting'));
    expect(notAccepting, 'teacher 3 takes no trials in the mocks').toBeTruthy();
    renderPage(<Harness query={query} />, { path: `/leads/${LEAD}` });
    await user.click(
      await screen.findByRole('button', { name: `عرض غير المتاحين (${want.ineligible.length})` }),
    );
    const card = screen.getByText(notAccepting!.teacher.name).closest('label')!;
    expect(card).toHaveTextContent('لا يقبل الحصص التجريبية');
    await user.click(within(card).getByRole('radio'));
    await waitFor(() =>
      expect(screen.getByLabelText('selected')).toHaveTextContent(
        `${notAccepting!.teacher.id}:false`,
      ),
    );
    const reason = screen.getByRole('textbox', { name: 'سبب التجاوز' });
    expect(screen.getByText('اذكر سبب التجاوز (3 أحرف على الأقل).')).toBeInTheDocument();
    await user.type(reason, 'Family asked for him');
    expect(screen.queryByText('اذكر سبب التجاوز (3 أحرف على الأقل).')).toBeNull();
    expect(screen.getByText('يُحفظ السبب مع الحجز في سجل العميل.')).toBeInTheDocument();
  });

  it('a course the teacher doesn’t teach is a reason too', async () => {
    const user = userEvent.setup();
    const query = queryFor(1);
    const want = expected(query);
    const course = want.ineligible.find((o) => o.reasons.includes('course'));
    expect(course).toBeTruthy();
    renderPage(<Harness query={query} />, { path: `/leads/${LEAD}` });
    await user.click(await screen.findByRole('button', { name: /^عرض غير المتاحين/ }));
    expect(screen.getByText(course!.teacher.name).closest('label')).toHaveTextContent(
      'لا يدرّس هذه الدورة',
    );
  });
});
