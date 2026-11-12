import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AnnouncementsView } from '@/components/operations/announcements-view';
import { TaskView } from '@/components/operations/task-view';
import { TasksView } from '@/components/operations/tasks-view';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/node';
import { odb } from '@/mocks/operations-db';
import { renderPage } from '@/test/people';
import { routerMock } from '@/test/router-mock';

const MONITOR = 'monitor@qarabic.test';
const ACCOUNTS = 'accounts@qarabic.test';

describe('Tasks list', () => {
  it('opens on my open given tasks with counts; an overdue one is flagged', async () => {
    renderPage(<TasksView />, { as: ACCOUNTS, path: '/tasks' });
    const table = await screen.findByRole('table', { name: 'المهام' });
    await waitFor(() => expect(within(table).getAllByRole('link')).toHaveLength(2));
    expect(within(table).getByText('متأخرة')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByRole('radio').map((r) => r.textContent)).toContain('المفتوحة (2)'),
    );
  });

  it('a monitor has no «كل المهام» box; the admin has', async () => {
    const { unmount } = renderPage(<TasksView />, { as: MONITOR, path: '/tasks' });
    expect(await screen.findByRole('tab', { name: 'المهام التي أصدرتها' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'كل المهام' })).toBeNull();
    unmount();
    renderPage(<TasksView />, { path: '/tasks' });
    expect(await screen.findByRole('tab', { name: 'كل المهام' })).toBeInTheDocument();
  });

  it('gives a new task from a template to a colleague', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    const before = odb.tasks.length;
    renderPage(<TasksView />, { as: MONITOR, path: '/tasks' });
    await user.click(await screen.findByRole('button', { name: 'مهمة جديدة' }));
    const dialog = await screen.findByRole('dialog', { name: 'مهمة جديدة' });
    await user.click(within(dialog).getByRole('button', { name: 'إسناد المهمة' }));
    expect(within(dialog).getByText('اختر الموظف المكلّف.')).toBeInTheDocument();
    await user.click(await within(dialog).findByRole('combobox', { name: 'من قالب' }));
    await user.click(await screen.findByRole('option', { name: 'مراجعة فاتورة' }));
    expect(within(dialog).getByLabelText(/^المهمة/)).toHaveValue('مراجعة فاتورة');
    // The template's due date fills the date picker (written with the month name, D32).
    expect(within(dialog).getByRole('button', { name: 'الموعد النهائي' }).textContent).toMatch(
      /\d{4}/,
    );
    await user.click(within(dialog).getByRole('combobox', { name: /المكلّف/ }));
    await user.click(await screen.findByRole('option', { name: /Accounts Officer/ }));
    await user.click(within(dialog).getByRole('button', { name: 'إسناد المهمة' }));
    await waitFor(() => expect(odb.tasks.length).toBe(before + 1));
    const t = odb.tasks.at(-1)!;
    expect(t).toMatchObject({ title: 'مراجعة فاتورة', status: 'pending', assignee: { id: 13 } });
    expect(t.dueAt).not.toBeNull();
    expect(routerMock.push).toHaveBeenLastCalledWith(`/tasks/${t.id}`);
  });
});

describe('Task detail', () => {
  it('assignee hands it in with a note; the issuer then confirms it', async () => {
    const user = userEvent.setup();
    const task = odb.tasks.find(
      (t) => t.assignee.id === 12 && t.status === 'pending' && t.createdBy.id === 1,
    )!;
    const { unmount } = renderPage(<TaskView id={task.id} />, {
      as: MONITOR,
      path: `/tasks/${task.id}`,
    });
    expect(await screen.findByRole('heading', { level: 1, name: task.title })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'اعتماد الإنجاز' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'تسليم للمراجعة' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'Called twice, confirmed.');
    await user.click(within(dialog).getByRole('button', { name: 'تسليم للمراجعة' }));
    await waitFor(() => expect(task.status).toBe('awaiting'));
    unmount();

    renderPage(<TaskView id={task.id} />, { path: `/tasks/${task.id}` });
    const timeline = await screen.findByRole('list', { name: 'سجل المهمة' });
    expect(within(timeline).getByText('Called twice, confirmed.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'اعتماد الإنجاز' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'اعتماد الإنجاز' }),
    );
    await waitFor(() => expect(task.status).toBe('completed'));
    await user.click(await screen.findByRole('button', { name: 'إجراءات أخرى' }));
    expect(await screen.findByRole('menuitem', { name: 'إعادة فتح' })).toBeInTheDocument();
  });

  it('close needs a reason; comments go on the timeline', async () => {
    const user = userEvent.setup();
    const task = odb.tasks.find(
      (t) => t.createdBy.id === 1 && t.assignee.id === 13 && t.status === 'pending',
    )!;
    renderPage(<TaskView id={task.id} />, { path: `/tasks/${task.id}` });
    await user.type(await screen.findByLabelText('إضافة تعليق'), 'Any update?');
    await user.click(screen.getByRole('button', { name: 'إرسال' }));
    expect(
      await within(screen.getByRole('list', { name: 'سجل المهمة' })).findByText('Any update?'),
    ).toBeInTheDocument();
    // «إغلاق» sits last in the «⋯» menu (destructive).
    await user.click(screen.getByRole('button', { name: 'إجراءات أخرى' }));
    await user.click(await screen.findByRole('menuitem', { name: 'إغلاق المهمة' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'إغلاق المهمة' }));
    expect(task.status).toBe('pending');
    await user.type(within(dialog).getByRole('textbox'), 'No longer needed');
    await user.click(within(dialog).getByRole('button', { name: 'إغلاق المهمة' }));
    await waitFor(() => expect(task.status).toBe('closed'));
    expect(task.closeReason).toBe('No longer needed');
  });

  it('a task outside my boxes is not found, with no retry', async () => {
    const task = odb.tasks.find((t) => t.assignee.id !== 12 && t.createdBy.id !== 12)!;
    renderPage(<TaskView id={task.id} />, { as: MONITOR, path: `/tasks/${task.id}` });
    expect(await screen.findByText('لم يُعثر على المهمة')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /إعادة المحاولة/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'العودة إلى المهام' })).toHaveAttribute(
      'href',
      '/tasks',
    );
  });

  it('a server refusal on the new task lands on its field', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('*/api/v1/tasks', () =>
        HttpResponse.json(
          {
            message: 'Invalid',
            code: 'validation_failed',
            errors: { title: ['The title has already been taken.'] },
          },
          { status: 422 },
        ),
      ),
    );
    renderPage(<TasksView />, { as: MONITOR, path: '/tasks' });
    await user.click(await screen.findByRole('button', { name: 'مهمة جديدة' }));
    const dialog = await screen.findByRole('dialog', { name: 'مهمة جديدة' });
    await user.type(within(dialog).getByLabelText(/^المهمة/), 'Call the family');
    await user.click(within(dialog).getByRole('combobox', { name: /المكلّف/ }));
    await user.click(await screen.findByRole('option', { name: /Accounts Officer/ }));
    await user.click(within(dialog).getByRole('button', { name: 'إسناد المهمة' }));
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/^المهمة/)).toHaveAttribute('aria-invalid', 'true'),
    );
  });
});

describe('Announcements', () => {
  it('a teacher sees what is for teachers, pinned first, and marks one read', async () => {
    const user = userEvent.setup();
    renderPage(<AnnouncementsView />, { as: 'teacher@qarabic.test', path: '/announcements' });
    const feed = await screen.findByRole('list', { name: 'الإعلانات' });
    const titles = within(feed)
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(titles[0]).toBe('تحديث سياسة الإجازات');
    expect(titles).toContain('تدريب المعلمين يوم الخميس');
    expect(titles).not.toContain('جدول مناوبات المشرفين لشهر ديسمبر');
    expect(screen.queryByRole('tab', { name: 'إدارة الإعلانات' })).toBeNull();
    await user.click(within(feed).getAllByRole('button', { name: /تم الاطلاع/ })[0]!);
    await waitFor(() => expect(odb.announcements[0]!.readBy.has(2)).toBe(true));
  });

  it('the admin writes a draft for parents and publishes it', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    renderPage(<AnnouncementsView />, { path: '/announcements?tab=manage' });
    await user.click(await screen.findByRole('button', { name: 'إعلان جديد' }));
    const dialog = await screen.findByRole('dialog', { name: 'إعلان جديد' });
    await user.type(within(dialog).getByLabelText(/^العنوان/), 'Ramadan timetable');
    await user.type(within(dialog).getByLabelText(/نص الإعلان/), 'Classes move one hour later.');
    await user.click(within(dialog).getByRole('checkbox', { name: 'ولي أمر' }));
    await user.click(within(dialog).getByRole('button', { name: 'حفظ المسودة' }));
    await waitFor(() => expect(odb.announcements.at(-1)!.title).toBe('Ramadan timetable'));
    const a = odb.announcements.at(-1)!;
    expect(a).toMatchObject({ status: 'draft', audience: ['parent'] });
    await user.click(await screen.findByRole('button', { name: 'نشر: Ramadan timetable' }));
    // Publishing asks first and names the audience.
    const confirm = await screen.findByRole('alertdialog', { name: 'نشر «Ramadan timetable»؟' });
    expect(within(confirm).getByText(/ولي أمر/)).toBeInTheDocument();
    expect(a.status).toBe('draft');
    await user.click(within(confirm).getByRole('button', { name: 'نشر' }));
    await waitFor(() => expect(a.status).toBe('published'));
  });

  it('archiving acts at once; «تراجع» in the toast brings it back (D31)', async () => {
    const user = userEvent.setup();
    const a = odb.announcements.find((x) => x.status === 'published')!;
    renderPage(<AnnouncementsView />, { path: '/announcements?tab=manage' });
    await user.click(await screen.findByRole('button', { name: `أرشفة ${a.title}` }));
    await waitFor(() => expect(a.status).toBe('archived'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'تراجع' }));
    await waitFor(() => expect(a.status).toBe('published'));
    expect(await screen.findByText('أُعيد الإعلان كما كان.')).toBeInTheDocument();
  });
});
