import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SessionSheet } from '@/components/sessions/session-sheet';
import { MOCK_USERS } from '@/mocks/data';
import { db as people } from '@/mocks/people-db';
import { addEvent, sdb, type SessionRow } from '@/mocks/schedule-db';
import { renderPage } from '@/test/people';

/**
 * QA journey J1 bugs: join evidence is for class managers only (P0-4), so a teacher or a parent
 * never sees «لم يدخل» on a class both joined; every timeline event has a label, never a raw key.
 */
const userId = (email: string) => MOCK_USERS.find((u) => u.email === email)!.id;

/** A taken class both people joined, with Zoom events and one type the web has no label for. */
function joinedClass(pick: (s: SessionRow) => boolean) {
  const s = sdb.sessions.find((x) => !x.deleted && pick(x))!;
  const at = new Date(Date.parse(s.startsAt) + 60_000).toISOString();
  Object.assign(s, { stage: 'taken', activatedAt: at, teacherJoinedAt: at, studentJoinedAt: at });
  addEvent(s.id, 'zoom_meeting_started', null, null, null, { at });
  addEvent(s.id, 'zoom_meeting_ended', null, null, null, { at });
  addEvent(s.id, 'legacy_unknown_type', null, null, null);
  return s.id;
}

async function openSheet(id: number, as?: string) {
  renderPage(<SessionSheet />, { path: `/today?session=${id}`, ...(as ? { as } : {}) });
  const sheet = await screen.findByRole('dialog', { name: 'تفاصيل الحصة' });
  await within(sheet).findByText('سجل الحصة');
  return sheet;
}

describe('class sheet by role (J1)', () => {
  it('without lateness or evidence for the viewer, the section is not drawn at all', async () => {
    const teacherId = people.teachers.find((t) => t.userId === userId('teacher@qarabic.test'))!.id;
    const id = joinedClass((s) => s.teacherId === teacherId);
    sdb.sessions.find((s) => s.id === id)!.activatedAt = sdb.sessions.find(
      (s) => s.id === id,
    )!.startsAt;
    const sheet = await openSheet(id, 'teacher@qarabic.test');
    expect(within(sheet).queryByText('إثبات الحضور')).not.toBeInTheDocument();
  });

  it('a manager sees who joined', async () => {
    const id = joinedClass(() => true);
    const sheet = await openSheet(id);
    expect(within(sheet).getByText('إثبات الحضور')).toBeInTheDocument();
    expect(within(sheet).getByText('دخول المعلم')).toBeInTheDocument();
    expect(within(sheet).queryByText('لم يدخل')).not.toBeInTheDocument();
  });

  it('the class’s teacher sees no join evidence, not a false «لم يدخل»', async () => {
    const teacherId = people.teachers.find((t) => t.userId === userId('teacher@qarabic.test'))!.id;
    const id = joinedClass((s) => s.teacherId === teacherId);
    const sheet = await openSheet(id, 'teacher@qarabic.test');
    expect(within(sheet).queryByText('دخول المعلم')).not.toBeInTheDocument();
    expect(within(sheet).queryByText('لم يدخل')).not.toBeInTheDocument();
  });

  it('a parent sees no join evidence on their child’s class', async () => {
    const familyId = people.families.find(
      (f) => f.parentUserId === userId('parent@qarabic.test'),
    )!.id;
    const kids = new Set(people.students.filter((s) => s.familyId === familyId).map((s) => s.id));
    const id = joinedClass((s) => kids.has(s.studentId));
    const sheet = await openSheet(id, 'parent@qarabic.test');
    expect(within(sheet).queryByText('دخول الطالب')).not.toBeInTheDocument();
    expect(within(sheet).queryByText('لم يدخل')).not.toBeInTheDocument();
  });

  it('labels the Zoom timeline events and never shows a raw event key', async () => {
    const id = joinedClass(() => true);
    const sheet = await openSheet(id);
    expect(within(sheet).getByText('بدأ اجتماع Zoom')).toBeInTheDocument();
    expect(within(sheet).getByText('انتهى اجتماع Zoom')).toBeInTheDocument();
    expect(within(sheet).getByText('حدث آخر')).toBeInTheDocument();
    expect(within(sheet).queryByText(/zoom_meeting|legacy_unknown_type/)).not.toBeInTheDocument();
  });
});
