import type { LessonReportDto } from '@qarabic/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LessonReportsView } from '@/app/(app)/lesson-reports/lesson-reports-view';
import { MyClassesView } from '@/app/(app)/my-classes/my-classes-view';
import { ReportView } from '@/components/reports/report-view';
import { sdb } from '@/mocks/schedule-db';
import { tdb } from '@/mocks/teaching-db';
import { editableUntil } from '@/mocks/teaching-present';
import { lastReplacedUrl, renderPage } from '@/test/people';

const TEACHER = 'teacher@qarabic.test';

/** The demo teacher's (teacher 1) classes in a stage, newest first. */
const ownClasses = (stage: string) =>
  sdb.sessions
    .filter((s) => s.teacherId === 1 && s.stage === stage && !s.deleted)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));

async function reportSheet(path: string) {
  renderPage(<MyClassesView />, { as: TEACHER, path });
  const sheet = await screen.findByRole('dialog', { name: 'تفاصيل الحصة' });
  return sheet;
}

describe('Lesson report form', () => {
  it('a teacher writes the report of an ended class; ayahs are checked against the surah', async () => {
    const user = userEvent.setup();
    const s = ownClasses('ended')[0]!;
    const sheet = await reportSheet(`/my-classes?session=${s.id}&report=1`);
    const form = await within(sheet).findByRole('form', { name: 'تقرير الحصة' });

    // Nothing filled: the summary is required and gets the focus.
    await user.click(within(form).getByRole('button', { name: 'حفظ التقرير' }));
    expect(await within(form).findByText('اكتب ملخص الحصة')).toBeInTheDocument();
    expect(within(form).getByLabelText(/ملخص الحصة/)).toHaveFocus();

    await user.click(within(form).getByLabelText(/ملخص الحصة/));
    await user.paste('Memorised the new ayahs well.');
    // «تابع من آخر موضع» fills the sabaq row from the last position; an ayah past the surah's end
    // is refused with the surah's length.
    const sabaq = within(form).getByRole('group', { name: /الدرس الجديد/ });
    await user.click(within(sabaq).getByRole('button', { name: /تابع من آخر موضع/ }));
    const toAyah = within(sabaq).getAllByLabelText('الآية')[1]!;
    await user.type(toAyah, '999');
    await user.click(within(form).getByRole('button', { name: 'حفظ التقرير' }));
    expect(await within(sabaq).findByText(/عدد آيات هذه السورة/)).toBeInTheDocument();

    const fromAyah = within(sabaq).getAllByLabelText('الآية')[0] as HTMLInputElement;
    await user.clear(toAyah);
    await user.type(toAyah, fromAyah.value);
    await user.click(within(form).getByRole('radio', { name: '4 من 5' }));
    await user.click(within(form).getByLabelText(/ملاحظات داخلية/));
    await user.paste('Needs revision at home.');
    await user.click(within(form).getByRole('button', { name: 'حفظ التقرير' }));

    expect(await screen.findByText(/حُفظ تقرير حصة/)).toBeInTheDocument();
    await waitFor(() => expect(sdb.sessions.find((x) => x.id === s.id)!.stage).toBe('taken'));
    const saved = tdb.reports.get(s.id)!;
    expect(saved).toMatchObject({ rating: 4, teacherNotes: 'Needs revision at home.' });
    expect(saved.hifz).toHaveLength(1);
    expect(saved.hifz[0]!.type).toBe('sabaq');
  }, 30_000);

  it('shows the teacher until when a sent report may still be edited', async () => {
    const s = ownClasses('taken').find((x) => {
      const until = editableUntil(x);
      return tdb.reports.get(x.id) && until && Date.parse(until) > Date.now();
    })!;
    const { unmount } = renderPage(<MyClassesView />, {
      as: TEACHER,
      path: `/my-classes?session=${s.id}`,
    });
    let sheet = await screen.findByRole('dialog', { name: 'تفاصيل الحصة' });
    expect(await within(sheet).findByText('ملخص الحصة')).toBeInTheDocument();
    await userEvent.setup().click(within(sheet).getByRole('button', { name: 'تعديل التقرير' }));
    expect(lastReplacedUrl().searchParams.get('report')).toBe('1');
    unmount();
    sheet = await reportSheet(`/my-classes?session=${s.id}&report=1`);
    expect(await within(sheet).findByText(/يمكنك تعديل التقرير حتى/)).toBeInTheDocument();
    expect(within(sheet).getByText(/تنتهي مدة التعديل/)).toBeInTheDocument();
    // The saved report fills the form.
    expect(within(sheet).getByLabelText(/ملخص الحصة/)).toHaveValue(tdb.reports.get(s.id)!.summary);
  });

  it('locks the report for the teacher once the edit window has passed', async () => {
    const s = ownClasses('taken').find((x) => {
      const until = editableUntil(x);
      return tdb.reports.get(x.id) && until && Date.parse(until) < Date.now();
    })!;
    // The URL asks for the form, but the class no longer offers it: the read-only report shows.
    const sheet = await reportSheet(`/my-classes?session=${s.id}&report=1`);
    expect(
      await within(sheet).findByText('انتهت مدة تعديل التقرير. تواصل مع المتابعة.'),
    ).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'تعديل التقرير' })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('form')).not.toBeInTheDocument();
  });
});

describe('Report view', () => {
  const report: LessonReportDto = {
    id: 1,
    sessionId: 1,
    studentId: 1,
    teacherId: 1,
    summary: 'Revised Al-Mulk.',
    homework: 'Repeat five times.',
    tajweedNotes: null,
    teacherNotes: 'Talk to the parent about revision.',
    rating: 5,
    hifz: [
      {
        type: 'sabaq',
        from: { surah: 78, ayah: 1 },
        to: { surah: 78, ayah: 16 },
        ayahs: 16,
        pages: 0.5,
        grade: 'excellent',
        mistakes: 1,
        notes: null,
      },
    ],
    dueAt: '2026-11-10T12:00:00Z',
    late: false,
    submittedAt: '2026-11-10T10:00:00Z',
    submittedBy: { id: 2, name: 'Ahmed Fathy' },
    updatedAt: '2026-11-10T10:00:00Z',
    updatedBy: { id: 2, name: 'Ahmed Fathy' },
  };

  it('shows staff the internal note, the hifz in words and the rating', async () => {
    renderPage(<ReportView report={report} />);
    expect(await screen.findByText('Talk to the parent about revision.')).toBeInTheDocument();
    expect(screen.getByText('النبأ 1–16')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '5 من 5' })).toBeInTheDocument();
    expect(screen.getByText(/أرسله Ahmed Fathy/)).toBeInTheDocument();
  });

  it('never shows a parent the internal note or the authors', async () => {
    renderPage(<ReportView report={report} />, { as: 'parent@qarabic.test' });
    expect(await screen.findByText('Revised Al-Mulk.')).toBeInTheDocument();
    expect(screen.queryByText('Talk to the parent about revision.')).not.toBeInTheDocument();
    expect(screen.queryByText('ملاحظات داخلية')).not.toBeInTheDocument();
    expect(screen.queryByText(/أرسله/)).not.toBeInTheDocument();
  });
});

describe('Lesson reports list', () => {
  it('has state tabs with counts and filters through the URL', async () => {
    const user = userEvent.setup();
    renderPage(<LessonReportsView />, { path: '/lesson-reports' });
    const tabs = await screen.findByRole('radiogroup', { name: 'تصفية حسب حالة التقرير' });
    await waitFor(() =>
      expect(within(tabs).getByRole('radio', { name: /^الكل\s*\(\d+\)$/ })).toBeInTheDocument(),
    );
    for (const name of ['بانتظار التقرير', 'بلا تقرير', 'سُلّم في موعده', 'سُلّم متأخرًا']) {
      expect(
        within(tabs).getByRole('radio', { name: new RegExp(`^${name}\\s*\\(\\d+\\)$`) }),
      ).toBeInTheDocument();
    }
    await user.click(within(tabs).getByRole('radio', { name: /^بلا تقرير/ }));
    expect(lastReplacedUrl().searchParams.get('state')).toBe('missing');
  });

  it('lists only the classes without a report from the board link', async () => {
    renderPage(<LessonReportsView />, { path: '/lesson-reports?state=missing' });
    const table = await screen.findByRole('table', { name: 'تقارير الحصص' });
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(1));
    const rows = within(table).getAllByRole('row').slice(1);
    for (const row of rows) expect(within(row).getByText('بلا تقرير')).toBeInTheDocument();
  });
});
