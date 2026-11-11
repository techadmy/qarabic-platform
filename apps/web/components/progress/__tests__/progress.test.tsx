import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { StudentProgress } from '@/components/progress/student-progress';
import { db as people } from '@/mocks/people-db';
import { sdb } from '@/mocks/schedule-db';
import { tdb } from '@/mocks/teaching-db';
import { renderPage } from '@/test/people';

/** A child of the demo family with reports that hold an internal note. */
function childWithHistory() {
  const kids = people.students.filter((s) => s.familyId === 1).map((s) => s.id);
  const s = sdb.sessions.find(
    (x) => kids.includes(x.studentId) && tdb.reports.get(x.id)?.teacherNotes,
  )!;
  return { studentId: s.studentId, note: tdb.reports.get(s.id)!.teacherNotes! };
}

describe('Student progress', () => {
  it('shows staff the last positions, coverage, ayahs per month and the lesson log', async () => {
    const user = userEvent.setup();
    const { studentId, note } = childWithHistory();
    renderPage(<StudentProgress studentId={studentId} />);
    const card = await screen.findByRole('region', { name: 'التقدم وسجل الدروس' });
    expect(await within(card).findByText('آخر موضع')).toBeInTheDocument();
    expect(within(card).getByText('المحفوظ من القرآن')).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: /^الآيات في الشهر:/ })).toBeInTheDocument();
    expect(within(card).getAllByText(new RegExp(note)).length).toBeGreaterThan(0);
    expect(within(card).getAllByRole('button', { name: 'فتح الحصة' }).length).toBeGreaterThan(0);
    // The log filters by hifz type.
    await user.click(within(card).getByRole('radio', { name: 'منزل' }));
    expect(within(card).getByRole('radio', { name: 'منزل' })).toBeChecked();
  });

  it('gives a parent a read-only view without internal notes', async () => {
    const { studentId, note } = childWithHistory();
    renderPage(<StudentProgress studentId={studentId} />, { as: 'parent@qarabic.test' });
    const card = await screen.findByRole('region', { name: /التقدم وسجل الدروس/ });
    expect(await within(card).findByText('للاطلاع فقط')).toBeInTheDocument();
    expect(await within(card).findByText('سجل الدروس')).toBeInTheDocument();
    expect(within(card).queryByText(new RegExp(note))).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'فتح الحصة' })).not.toBeInTheDocument();
  });
});
