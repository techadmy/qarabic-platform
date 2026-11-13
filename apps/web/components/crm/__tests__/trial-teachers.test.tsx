import {
  trialTeachersQuerySchema,
  type TrialTeacherOptionDto,
  type TrialTeachersQuery,
} from '@qarabic/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { BookTrialDialog } from '@/components/crm/book-trial-dialog';
import { TrialTeacherPicker } from '@/components/crm/trial-teacher-picker';
import { crmdb } from '@/mocks/crm-db';
import { presentDetail, zonedUtc } from '@/mocks/crm-handlers';
import { MOCK_USERS } from '@/mocks/data';
import { server } from '@/mocks/node';
import { queryOf } from '@/mocks/schedule-handlers';
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

  it('the arrow keys move between the ranked teachers; Space chooses', async () => {
    const user = userEvent.setup();
    const query = queryFor();
    const want = expected(query);
    renderPage(<Harness query={query} />, { path: `/leads/${LEAD}` });
    const group = await screen.findByRole('radiogroup', { name: 'المعلم' });
    const radios = within(group).getAllByRole('radio');
    await user.click(radios[0]!);
    await waitFor(() =>
      expect(screen.getByLabelText('selected')).toHaveTextContent(
        `${want.eligible[0]!.teacher.id}:`,
      ),
    );
    // ArrowDown moves to the next teacher in either direction; Space chooses it (in a browser the
    // arrow also chooses it; jsdom does not run Radix's select-on-focus).
    await user.keyboard('{ArrowDown}');
    expect(radios[1]).toHaveFocus();
    await user.keyboard(' ');
    await waitFor(() =>
      expect(screen.getByLabelText('selected')).toHaveTextContent(
        `${want.eligible[1]!.teacher.id}:`,
      ),
    );
  });

  it('a busy teacher is listed but cannot be chosen; every card shows the teacher’s day and time', async () => {
    const user = userEvent.setup();
    const query = queryFor();
    const real = expected(query);
    const busy = {
      ...real.eligible[0]!,
      eligible: false,
      rank: null,
      reasons: ['busy' as const],
      overridable: false,
    };
    server.use(
      http.get('*/api/v1/leads/:id/trial-teachers', () =>
        HttpResponse.json({
          data: { eligible: real.eligible.slice(1), ineligible: [busy] },
          meta: {
            startsAt: '2026-11-20T16:00:00Z',
            durationMinutes: 30,
            familyZone: 'America/New_York',
            adult: false,
            teacherGenderPref: null,
          },
        }),
      ),
    );
    renderPage(<Harness query={query} />, { path: `/leads/${LEAD}` });
    await user.click(await screen.findByRole('button', { name: 'عرض غير المتاحين (1)' }));
    const radio = screen.getByRole('radio', { name: busy.teacher.name });
    expect(radio).toBeDisabled();
    expect(radio).toHaveAccessibleDescription(/مشغول في هذا الموعد/);
    // 16:00 UTC is 6 pm in Cairo on Friday 20 November.
    expect(radio.closest('label')).toHaveTextContent(/عنده .*20.*6:00 م \(القاهرة\)/);
  });
});

describe('T2 booking dialog', () => {
  async function openDialog() {
    const user = userEvent.setup();
    const row = crmdb.leads.find((l) => l.id === LEAD)!;
    const admin = MOCK_USERS.find((u) => u.email === 'admin@qarabic.test')!;
    // No earlier trial: no teacher is chosen yet.
    const lead = { ...presentDetail(row, admin), trials: [] };
    renderPage(
      <BookTrialDialog lead={lead} onClose={() => undefined} onSaved={() => undefined} />,
      {
        path: `/leads/${LEAD}`,
      },
    );
    const dialog = await screen.findByRole('dialog', { name: 'حجز حصة تجريبية' });
    await user.click(within(dialog).getByRole('button', { name: 'التاريخ' }));
    await user.click(await screen.findByRole('button', { name: 'اذهب إلى الشهر التالي' }));
    const day = screen
      .getAllByRole('gridcell')
      .find((c) => c.textContent?.trim() === '10' && c.querySelector('button:not([disabled])'))!;
    await user.click(within(day).getByRole('button'));
    await user.click(within(dialog).getByRole('combobox', { name: 'الوقت' }));
    await user.click(await screen.findByRole('option', { name: '10:00 ص' }));
    await within(dialog).findByRole('radiogroup', { name: 'المعلم' });
    return { user, dialog };
  }

  it('a teacher from the list brings the booking’s own check; no separate check is asked (#57)', async () => {
    const checks: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (new URL(request.url).pathname.endsWith('/schedule/check')) checks.push(request.url);
    });
    server.use(
      http.get('*/api/v1/leads/:id/trial-teachers', ({ request }) => {
        const lead = crmdb.leads.find((l) => l.id === LEAD)!;
        const q = trialTeachersQuerySchema.parse(queryOf(request));
        const tz = q.timezone ?? lead.timezone;
        const data = trialTeachers(
          lead,
          { ...q, timezone: tz, durationMinutes: q.durationMinutes ?? 30 },
          zonedUtc(q.localDate, q.localTime, tz),
        );
        data.data.eligible = data.data.eligible.map((o) => ({
          ...o,
          check: {
            conflicts: [],
            warnings: [
              {
                code: 'mock_soft_warning',
                severity: 'soft' as const,
                message: 'A test warning',
                with: null,
                firstDate: null,
              },
            ],
          },
        }));
        return HttpResponse.json(data);
      }),
    );
    const { user, dialog } = await openDialog();
    const group = within(dialog).getByRole('radiogroup', { name: 'المعلم' });
    await user.click(within(group).getAllByRole('radio')[0]!);
    expect(await within(dialog).findByText('A test warning')).toBeInTheDocument();
    expect(checks).toHaveLength(0);
    server.events.removeAllListeners('request:start');
  });

  it('booking without a teacher says so and takes the focus to the list', async () => {
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'احجز الحصة' }));
    const group = within(dialog).getByRole('radiogroup', { name: 'المعلم' });
    expect(group).toHaveAccessibleDescription('اختر المعلم.');
    expect(within(group).getAllByRole('radio')[0]).toHaveFocus();
  });

  it('a 422 teacher_not_eligible keeps the reason and shows why; editing the reason allows a retry', async () => {
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: /^عرض غير المتاحين/ }));
    await user.click(within(dialog).getByRole('radio', { name: 'Mahmoud Saeed' }));
    const reason = within(dialog).getByRole('textbox', { name: 'سبب التجاوز' });
    await user.type(reason, 'Family asked');
    server.use(
      http.post(
        '*/api/v1/leads/:id/trials',
        () =>
          HttpResponse.json(
            {
              code: 'teacher_not_eligible',
              message: 'The teacher is not eligible for this trial.',
              errors: { overrideReason: ['Give a reason to book this teacher.'] },
              data: { reasons: ['not_accepting'] },
            },
            { status: 422 },
          ),
        { once: true },
      ),
    );
    for (const tick of within(dialog).queryAllByRole('checkbox')) await user.click(tick);
    await user.click(within(dialog).getByRole('button', { name: 'احجز الحصة' }));
    expect(
      await within(dialog).findByText(
        'هذا المعلم غير مؤهل لهذه الحصة؛ اذكر سبب التجاوز للحجز معه.',
      ),
    ).toBeInTheDocument();
    expect(reason).toHaveValue('Family asked');
    await user.type(reason, ' by name');
    expect(
      within(dialog).queryByText('هذا المعلم غير مؤهل لهذه الحصة؛ اذكر سبب التجاوز للحجز معه.'),
    ).toBeNull();
  });

  it('offer mode (T3): a shortlist needs a teacher; the offer goes to the chosen ones', async () => {
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByRole('radio', { name: 'اعرضها على المعلمين' }));
    await user.click(within(dialog).getByRole('radio', { name: 'قائمة أختارها' }));
    await user.click(within(dialog).getByRole('button', { name: 'أرسل العرض' }));
    expect(await within(dialog).findByText('اختر معلمًا واحدًا على الأقل.')).toBeInTheDocument();
    const boxes = within(dialog).getAllByRole('checkbox');
    await user.click(boxes[0]!);
    await user.click(within(dialog).getByRole('radio', { name: /تطوّع ثم اختيار/ }));
    await user.click(within(dialog).getByRole('button', { name: 'أرسل العرض' }));
    // The seeded offer for this child is still open: the API says so.
    expect(
      await within(dialog).findByText('للطالب عرض مفتوح بالفعل؛ ألغِه أو انتظر نتيجته.'),
    ).toBeInTheDocument();
  });
});
