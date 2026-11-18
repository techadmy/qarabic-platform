import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { RequestsView } from '@/app/(app)/requests/requests-view';
import { RequestDialog } from '@/components/requests/request-dialog';
import { RowActions } from '@/components/sessions/row-actions';
import { MOCK_USERS } from '@/mocks/data';
import { db as people } from '@/mocks/people-db';
import { presentSession } from '@/mocks/schedule-handlers';
import { sdb, type SessionRow } from '@/mocks/schedule-db';
import { server } from '@/mocks/node';
import { renderPage } from '@/test/people';

/**
 * QA journey J4 (docs/31): a class on leave takes a make-up («حصة تعويضية») from the screens, with
 * the API's window; the parent's leave has no «وقت الإبلاغ»; «طلبات الحصص» keeps a request and
 * its dialog until the server answers an approval.
 */
const PARENT = 'parent@qarabic.test';
const userOf = (email: string) => MOCK_USERS.find((u) => u.email === email)!;
const DAY = 86_400_000;

/** One of the demo parent's classes, put on leave `daysAgo` days ago at an odd minute. */
function leaveClass(daysAgo: number): SessionRow {
  const family = people.families.find((f) => f.parentUserId === userOf(PARENT).id)!;
  const kids = new Set(people.students.filter((s) => s.familyId === family.id).map((s) => s.id));
  const s = sdb.sessions.find((x) => !x.deleted && kids.has(x.studentId))!;
  const at = new Date(Date.now() - daysAgo * DAY);
  at.setUTCHours(3, 7, 0, 0);
  Object.assign(s, { stage: 'leave', stageReason: 'student', startsAt: at.toISOString() });
  return s;
}

beforeEach(() => {
  // A free time for the server's own check: no work hours or holidays to warn about.
  sdb.workHours.clear();
  sdb.holidays.length = 0;
});

describe('make-up of a leave class (J4)', () => {
  it('the parent finds «حصة تعويضية» in the class menu; it opens the make-up request', async () => {
    const user = userEvent.setup();
    const s = leaveClass(2);
    renderPage(<RowActions session={presentSession(s, userOf(PARENT))} />, { as: PARENT });
    await user.click(await screen.findByRole('button', { name: /^إجراءات أخرى/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'حصة تعويضية' }));
    const dialog = await screen.findByRole('dialog', { name: /^حصة تعويضية — / });
    expect(within(dialog).getByText(/خلال المدة التي تسمح بها الأكاديمية/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/السبب/), 'Missed for a family trip');
    await user.click(within(dialog).getByRole('button', { name: 'أرسل الطلب' }));
    expect(await screen.findByText(/^أُرسل الطلب/)).toBeInTheDocument();
    const made = sdb.requests.at(-1)!;
    expect(made).toMatchObject({ type: 'reschedule', sessionId: s.id, status: 'pending' });
    // The leave class stays on leave until staff approve.
    expect(s.stage).toBe('leave');
  });

  it('a time outside the make-up window is refused with a clear message', async () => {
    const user = userEvent.setup();
    const s = leaveClass(20); // the mock window is 14 days; the dialog starts from tomorrow
    renderPage(
      <RequestDialog
        session={presentSession(s, userOf(PARENT))}
        type="reschedule"
        open
        onOpenChange={() => {}}
      />,
      { as: PARENT },
    );
    const dialog = await screen.findByRole('dialog', { name: /^حصة تعويضية — / });
    await user.type(within(dialog).getByLabelText(/السبب/), 'Late make-up');
    await user.click(within(dialog).getByRole('button', { name: 'أرسل الطلب' }));
    expect(
      await within(dialog).findByText(/خارج المدة المسموح بها للحصة التعويضية/),
    ).toBeInTheDocument();
  });

  it('staff offer it from the approved leave on «طلبات الحصص»', async () => {
    const user = userEvent.setup();
    const s = leaveClass(1);
    const leave = sdb.requests.find((r) => r.type === 'leave')!;
    Object.assign(leave, { sessionId: s.id, status: 'approved' });
    renderPage(<RequestsView />, { path: '/requests?status=decided' });
    const card = await screen.findByRole('button', { name: /^اطلب حصة تعويضية/ });
    await user.click(card);
    expect(await screen.findByRole('dialog', { name: /^حصة تعويضية — / })).toBeInTheDocument();
  });
});

describe('the leave dialog (J4)', () => {
  const scheduled = () => {
    const family = people.families.find((f) => f.parentUserId === userOf(PARENT).id)!;
    const kids = new Set(people.students.filter((s) => s.familyId === family.id).map((s) => s.id));
    const s = sdb.sessions.find(
      (x) => !x.deleted && kids.has(x.studentId) && x.stage === 'scheduled',
    )!;
    s.startsAt = new Date(Date.now() + 3 * DAY).toISOString();
    return s;
  };

  it('has no «وقت الإبلاغ» for a parent', async () => {
    const s = scheduled();
    renderPage(
      <RequestDialog
        session={presentSession(s, userOf(PARENT))}
        type="leave"
        open
        onOpenChange={() => {}}
      />,
      { as: PARENT },
    );
    await screen.findByRole('dialog');
    expect(screen.queryByLabelText('وقت الإبلاغ')).not.toBeInTheDocument();
  });

  it('keeps it for staff', async () => {
    const s = scheduled();
    renderPage(
      <RequestDialog
        session={presentSession(s, userOf('admin@qarabic.test'))}
        type="leave"
        open
        onOpenChange={() => {}}
      />,
    );
    expect(await screen.findByLabelText('وقت الإبلاغ')).toBeInTheDocument();
  });
});

describe('approving on «طلبات الحصص» waits for the server (J4)', () => {
  it('keeps the request and its dialog while saving, and shows a refusal', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('*/api/v1/session-requests/:id/approve', async () => {
        await delay(300);
        return HttpResponse.json(
          { message: 'Already decided.', code: 'conflict' },
          { status: 409 },
        );
      }),
    );
    renderPage(<RequestsView />, { path: '/requests' });
    const list = await screen.findByRole('list', { name: 'طلبات الحصص' });
    const before = within(list).getAllByRole('listitem').length;
    const leave = within(list)
      .getAllByRole('listitem')
      .find((i) => within(i).queryByText('طلب إجازة'))!;
    const name = within(leave).getAllByRole('button')[0]!.textContent!;
    await user.click(within(leave).getByRole('button', { name: `موافقة: ${name}` }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'وافق على الطلب' }));
    expect(within(dialog).getByRole('button', { name: /وافق على الطلب/ })).toBeDisabled();
    // Escape while saving does not close it (the answer would be lost).
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/تغيّرت الحالة/);
    expect(
      screen.getAllByRole('listitem', { hidden: true }).filter((li) => list.contains(li)),
    ).toHaveLength(before);
    await waitFor(() => expect(sdb.requests.some((r) => r.status === 'pending')).toBe(true));
  });
});
