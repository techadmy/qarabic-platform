import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HomeView } from '@/app/(app)/home-view';
import { RowActions } from '@/components/sessions/row-actions';
import { InboxView } from '@/components/support/inbox-view';
import { MyRequestsView } from '@/components/support/my-requests-view';
import { TicketDetailView } from '@/components/support/ticket-detail';
import { MOCK_USERS } from '@/mocks/data';
import { server } from '@/mocks/node';
import { sdb } from '@/mocks/schedule-db';
import { presentSession } from '@/mocks/schedule-handlers';
import { supdb } from '@/mocks/support-db';
import { tdb } from '@/mocks/teaching-db';
import { renderPage } from '@/test/people';

// jsdom cannot draw the page: the report falls back to an upload, as in a browser that refuses.
vi.mock('@/lib/support/screenshot', () => ({ capturePage: vi.fn(async () => null) }));

/** Bodies of the API calls whose path ends with `suffix`, in order. */
function captured(method: string, suffix: string | RegExp) {
  const bodies: unknown[] = [];
  server.events.on('request:start', async ({ request }) => {
    const path = new URL(request.url).pathname;
    const hit = typeof suffix === 'string' ? path.endsWith(suffix) : suffix.test(path);
    if (request.method === method && hit) {
      bodies.push(
        await request
          .clone()
          .json()
          .catch(() => null),
      );
    }
  });
  return bodies;
}

/** The list row that mentions `text` (a ticket number, a title). */
function row(list: HTMLElement, text: RegExp) {
  const found = within(list)
    .getAllByRole('listitem')
    .find((li) => text.test(li.textContent ?? ''));
  if (!found) throw new Error(`No row matches ${text}`);
  return found;
}

async function openHub(user: ReturnType<typeof userEvent.setup>) {
  await user.click((await screen.findAllByRole('button', { name: 'تواصل معنا' }))[0]!);
  return screen.findByRole('dialog', { name: 'تواصل معنا' });
}

async function pick(
  user: ReturnType<typeof userEvent.setup>,
  label: RegExp | string,
  option: string,
) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('«تواصل معنا» hub', () => {
  it('shows a parent the four «بخصوص ماذا؟» cards, «موضوع آخر» and their open requests', async () => {
    const user = userEvent.setup();
    renderPage(<div />, { as: 'parent@qarabic.test' });
    const hub = await openHub(user);
    expect(within(hub).getByRole('heading', { name: 'بخصوص ماذا؟' })).toBeInTheDocument();
    for (const card of [
      'الحصص والمواعيد',
      'المعلم والمستوى الدراسي',
      'الفواتير والاشتراك',
      'مشكلة تقنية أو اقتراح',
    ]) {
      expect(within(hub).getByRole('button', { name: new RegExp(card) })).toBeInTheDocument();
    }
    expect(within(hub).getByRole('button', { name: 'موضوع آخر' })).toBeInTheDocument();
    // «طلباتي» under the cards, open first.
    expect(await within(hub).findByRole('link', { name: /#1 · The meeting link/ })).toBeVisible();
    expect(within(hub).queryByRole('button', { name: /الراتب/ })).not.toBeInTheDocument();
  });

  it('gives a teacher their own cards and staff three cards', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage(<div />, { as: 'teacher@qarabic.test' });
    let hub = await openHub(user);
    expect(within(hub).getByRole('button', { name: /^حصصي/ })).toBeInTheDocument();
    expect(within(hub).getByRole('button', { name: /^الراتب/ })).toBeInTheDocument();
    expect(within(hub).queryByRole('button', { name: /الفواتير والاشتراك/ })).toBeNull();
    unmount();

    renderPage(<div />, { as: 'admin@qarabic.test' });
    hub = await openHub(user);
    expect(within(hub).getByRole('button', { name: /^مشكلة تقنية/ })).toBeInTheDocument();
    expect(within(hub).getByRole('button', { name: /^اقتراح/ })).toBeInTheDocument();
    expect(within(hub).getByRole('button', { name: /طلب نيابةً عن ولي أمر أو طالب/ })).toBeVisible();
    expect(within(hub).queryByRole('button', { name: 'موضوع آخر' })).toBeNull();
  });

  it('files «مشكلة في هذه الحصة» from a class with the class and the page as context', async () => {
    const user = userEvent.setup();
    const sent = captured('POST', '/feedback/tickets');
    renderPage(<div />, { as: 'parent@qarabic.test', path: '/my-classes?week=x' });
    const hub = await openHub(user);
    await user.click(within(hub).getByRole('button', { name: /^الحصص والمواعيد/ }));
    const issue = (await screen.findAllByRole('button', { name: /^مشكلة في هذه الحصة · / }))[0]!;
    await user.click(issue);
    const form = await screen.findByRole('dialog', { name: 'مشكلة في حصة' });
    expect(within(form).getByText(/^الحصة:/)).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'أرسل' }));
    expect(await within(form).findByText('اكتب رسالتك في بضع كلمات.')).toBeInTheDocument();
    await user.type(
      within(form).getByLabelText(/ما المشكلة في هذه الحصة؟/),
      'The link did not work today.',
    );
    await user.click(within(form).getByRole('button', { name: 'أرسل' }));
    expect(await screen.findByText('أُرسل طلبك رقم #9. ستجد الرد في «طلباتي».')).toBeVisible();
    expect(sent[0]).toMatchObject({
      category: 'classes',
      subcategory: 'session_issue',
      subjectType: 'session',
      subjectId: expect.any(Number),
      description: 'The link did not work today.',
      context: expect.objectContaining({ pageUrl: '/my-classes?week=x', portal: 'parent' }),
    });
    expect(supdb.tickets.at(-1)).toMatchObject({ queue: 'scheduling', familyId: 1 });
    server.events.removeAllListeners();
  });

  it('routes a complaint about the teacher to the restricted queue and says so', async () => {
    const user = userEvent.setup();
    renderPage(<div />, { as: 'parent@qarabic.test' });
    const hub = await openHub(user);
    await user.click(within(hub).getByRole('button', { name: /^المعلم والمستوى الدراسي/ }));
    await user.click(await screen.findByRole('button', { name: 'ملاحظة أو شكوى بخصوص المعلم' }));
    const form = await screen.findByRole('dialog', { name: 'ملاحظة أو شكوى بخصوص المعلم' });
    expect(within(form).getByText(/لا يطّلع المعلم على رسالتك/)).toBeInTheDocument();
    expect(await within(form).findByRole('combobox', { name: 'بخصوص' })).toHaveTextContent(
      /Ali|Mariam/,
    );
    await user.type(within(form).getByLabelText(/ما ملاحظتك؟/), 'The teacher ended early again.');
    await user.click(within(form).getByRole('button', { name: 'أرسل' }));
    expect((await screen.findAllByText(/أُرسل طلبك رقم #9/))[0]).toBeVisible();
    expect(supdb.tickets.at(-1)).toMatchObject({
      queue: 'complaints',
      visibility: 'restricted',
      subjectType: 'student',
    });
  });

  it('opens the technical report with the details it sends', async () => {
    const user = userEvent.setup();
    const sent = captured('POST', '/feedback/tickets');
    renderPage(<div />, { as: 'admin@qarabic.test', path: '/today' });
    const hub = await openHub(user);
    await user.click(within(hub).getByRole('button', { name: /^مشكلة تقنية/ }));
    const report = await screen.findByRole('dialog', { name: 'مشكلة تقنية أو اقتراح' });
    expect(within(report).getByText('تعذّر التقاط صورة الشاشة؛ يمكنك إرفاق صورة.')).toBeVisible();
    await user.click(within(report).getByRole('button', { name: 'التفاصيل المرسلة تلقائيًا' }));
    expect(within(report).getByText('/today')).toBeVisible();
    await user.type(within(report).getByLabelText(/ماذا حدث؟/), 'The board did not refresh.');
    await user.click(within(report).getByRole('button', { name: 'أرسل' }));
    expect((await screen.findAllByText(/أُرسل طلبك رقم #9/))[0]).toBeVisible();
    expect(sent[0]).toMatchObject({ type: 'bug', category: 'technical' });
    server.events.removeAllListeners();
  });
});

describe('class «⋯» → «طلب بخصوص هذه الحصة»', () => {
  it('opens the form with the class as its subject', async () => {
    const user = userEvent.setup();
    const sent = captured('POST', '/feedback/tickets');
    const staff = MOCK_USERS.find((u) => u.email === 'admin@qarabic.test')!;
    const s = sdb.sessions.find((x) => x.stage === 'scheduled' && !x.deleted)!;
    renderPage(<RowActions session={presentSession(s, staff)} />, { path: '/today' });
    await user.click(await screen.findByRole('button', { name: /^إجراءات أخرى: / }));
    await user.click(await screen.findByRole('menuitem', { name: 'طلب بخصوص هذه الحصة' }));
    const form = await screen.findByRole('dialog', { name: 'مشكلة في حصة' });
    expect(within(form).getByText(/^الحصة:/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/ما المشكلة/), 'The student could not hear.');
    await user.click(within(form).getByRole('button', { name: 'أرسل' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ subjectType: 'session', subjectId: s.id, category: 'classes' });
    server.events.removeAllListeners();
  });
});

describe('«طلباتي» and the ticket', () => {
  it('lists tickets and class requests, open first, with the news dot and the next step', async () => {
    renderPage(<MyRequestsView />, { as: 'parent@qarabic.test', path: '/my-requests' });
    const list = await screen.findByRole('list', { name: 'طلباتي' });
    const fixed = row(list, /#1 · The meeting link/);
    expect(within(fixed).getByText('تحديث جديد')).toBeVisible();
    expect(within(fixed).getByText(/أكّد لنا هل حُلّت المشكلة/)).toBeVisible();
    const reply = row(list, /#5 · /);
    expect(within(reply).getByText(/مطلوب ردك/)).toBeVisible();
    // The closed one is under «المغلقة».
    expect(within(list).queryByText(/How is Ali doing/)).toBeNull();
    expect(screen.getByRole('radio', { name: /^المفتوحة/ })).toBeChecked();
  });

  it('clears the dot on open and lets the requester confirm the fix', async () => {
    const user = userEvent.setup();
    const seen = captured('POST', '/feedback/tickets/1/seen');
    renderPage(<TicketDetailView id={1} />, { as: 'parent@qarabic.test', path: '/tickets/1' });
    expect(await screen.findByRole('heading', { level: 1, name: /#1/ })).toBeVisible();
    await waitFor(() => expect(seen).toHaveLength(1));
    // Public replies only: the staff's internal note is not there.
    expect(screen.getByText('Thank you, we are checking the link now.')).toBeVisible();
    expect(screen.queryByText(/Zoom host had expired/)).toBeNull();
    expect(screen.getByText('هل حُلّت المشكلة؟')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'نعم، حُلّت' }));
    expect(await screen.findByText('شكرًا لتأكيدك.')).toBeVisible();
    expect(supdb.tickets.find((t) => t.id === 1)?.status).toBe('verified');
    expect(screen.queryByText('هل حُلّت المشكلة؟')).toBeNull();
    server.events.removeAllListeners();
  });

  it('never shows a teacher a complaint about them', async () => {
    renderPage(<TicketDetailView id={3} />, { as: 'teacher@qarabic.test', path: '/tickets/3' });
    expect(await screen.findByText('هذا الطلب غير موجود أو ليس لك')).toBeVisible();
    expect(screen.queryByText(/late twice/)).toBeNull();
  });
});

describe('«صندوق الطلبات»', () => {
  it('shows the queue tabs with counts, overdue first, and takes a ticket', async () => {
    const user = userEvent.setup();
    renderPage(<InboxView />, { as: 'admin@qarabic.test', path: '/support' });
    const tabs = await screen.findByRole('radiogroup', { name: 'الأقسام' });
    expect(
      await within(tabs).findByRole('radio', { name: 'الحسابات والفواتير (1) · متأخرة: 1' }),
    ).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'صندوق الطلبات' });
    const first = within(list).getAllByRole('listitem')[0]!;
    expect(first).toHaveTextContent(/#2 · I paid the November invoice/);
    expect(within(first).getByText(/^متأخر /)).toBeVisible();
    await user.click(within(first).getByRole('button', { name: 'استلام: #2' }));
    expect(await screen.findByText('استلمتَ الطلب.')).toBeVisible();
    await waitFor(() => expect(row(list, /#2 · I paid/)).toHaveTextContent('المسؤول: مدير النظام'));
    expect(supdb.tickets.find((t) => t.id === 2)?.assignee?.id).toBe(1);
  });

  it('enforces the lifecycle: a note for «بانتظار معلومات منك», a priority, a PR link for a technical fix', async () => {
    const user = userEvent.setup();
    renderPage(<InboxView />, { as: 'admin@qarabic.test', path: '/support' });
    const list = await screen.findByRole('list', { name: 'صندوق الطلبات' });

    // #6 (new): needs_info needs a public note.
    const six = row(list, /#6 · /);
    await user.click(within(six).getByRole('button', { name: 'تغيير الحالة: #6' }));
    let dialog = await screen.findByRole('dialog', { name: /تغيير حالة الطلب|الحالة الجديدة/ });
    await pick(user, 'الحالة الجديدة', 'بانتظار معلومات منك');
    await user.click(within(dialog).getByRole('button', { name: 'نقل' }));
    expect(
      await within(dialog).findAllByText('هذه الحالة تتطلب ملاحظة لمقدّم الطلب.'),
    ).not.toHaveLength(0);
    await user.type(within(dialog).getByLabelText(/ملاحظة لمقدّم الطلب/), 'Which day suits you?');
    await user.click(within(dialog).getByRole('button', { name: 'نقل' }));
    expect(await screen.findByText('حُفظ.')).toBeVisible();
    expect(supdb.tickets.find((t) => t.id === 6)?.status).toBe('needs_info');

    // #8 (a suggestion without a priority): «قيد المراجعة» asks for one first.
    const eight = row(list, /#8 · /);
    await user.click(within(eight).getByRole('button', { name: 'تغيير الحالة: #8' }));
    dialog = await screen.findByRole('dialog', { name: /الحالة الجديدة/ });
    await pick(user, 'الحالة الجديدة', 'قيد المراجعة');
    await user.click(within(dialog).getByRole('button', { name: 'نقل' }));
    expect(await within(dialog).findByText('حدّد الأولوية أولًا.')).toBeVisible();
    await pick(user, /^الأولوية/, 'منخفضة (P3) — فكرة أو صياغة');
    await user.click(within(dialog).getByRole('button', { name: 'نقل' }));
    await waitFor(() => expect(supdb.tickets.find((t) => t.id === 8)?.status).toBe('triaged'));
    expect(supdb.tickets.find((t) => t.id === 8)?.priority).toBe('p3');

    // #4 (technical, in progress): «تم الحل» needs the pull request link.
    const four = row(list, /#4 · /);
    await user.click(within(four).getByRole('button', { name: 'تغيير الحالة: #4' }));
    dialog = await screen.findByRole('dialog', { name: /الحالة الجديدة/ });
    await pick(user, 'الحالة الجديدة', 'تم الحل (بانتظار التأكيد)');
    await user.click(within(dialog).getByRole('button', { name: 'نقل' }));
    expect(
      await within(dialog).findAllByText('الإصلاح التقني يتطلب رابط طلب الدمج.'),
    ).not.toHaveLength(0);
    await user.type(
      within(dialog).getByRole('textbox', { name: /الإصلاح التقني/ }),
      'https://example.com/x',
    );
    await user.click(within(dialog).getByRole('button', { name: 'نقل' }));
    expect(await within(dialog).findByText('رابط طلب الدمج غير صحيح.')).toBeVisible();
    await user.clear(within(dialog).getByRole('textbox', { name: /الإصلاح التقني/ }));
    await user.type(
      within(dialog).getByRole('textbox', { name: /الإصلاح التقني/ }),
      'https://github.com/qarabicacademy/qarabic-platform/pull/42',
    );
    await user.click(within(dialog).getByRole('button', { name: 'نقل' }));
    await waitFor(() => expect(supdb.tickets.find((t) => t.id === 4)?.status).toBe('fixed'));
    expect(supdb.tickets.find((t) => t.id === 4)?.prUrl).toMatch(/pull\/42$/);
  });

  it('shows the family and teacher in the side panel', async () => {
    const user = userEvent.setup();
    renderPage(<InboxView />, { as: 'admin@qarabic.test', path: '/support' });
    const list = await screen.findByRole('list', { name: 'صندوق الطلبات' });
    const two = row(list, /#2 · /);
    await user.click(within(two).getByRole('button', { name: 'عرض بيانات ولي أمر تجريبي' }));
    const panel = await screen.findByRole('dialog', { name: 'بيانات الأسرة والمعلم' });
    expect(await within(panel).findByText('الأسرة: ولي أمر تجريبي')).toBeVisible();
    expect(within(panel).getByText(/Ali، Mariam|Mariam، Ali/)).toBeVisible();
  });
});

describe('parent home', () => {
  it('shows the children, the next class, the coming week and the latest reports without internal notes', async () => {
    renderPage(<HomeView />, { as: 'parent@qarabic.test', path: '/' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'مرحبًا، ولي أمر تجريبي' }),
    ).toBeVisible();
    for (const name of ['Ali', 'Mariam']) {
      expect(await screen.findByRole('heading', { name })).toBeVisible();
    }
    expect(screen.getAllByText('الحصة القادمة').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'الأيام السبعة القادمة' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: /^إجراءات · / }).length).toBeGreaterThan(0);
    const reports = screen.getByRole('heading', { name: 'آخر تقارير الحصص' }).parentElement!;
    const notes = [...tdb.reports.values()].map((r) => r.teacherNotes).filter(Boolean) as string[];
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) expect(within(reports).queryByText(note)).toBeNull();
    expect(within(reports).getAllByRole('listitem').length).toBeGreaterThan(0);
  });
});
