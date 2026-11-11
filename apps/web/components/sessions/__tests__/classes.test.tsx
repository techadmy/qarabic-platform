import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { MyClassesView } from '@/app/(app)/my-classes/my-classes-view';
import { TodayView } from '@/app/(app)/today/today-view';
import { addDays, dateKeyIn } from '@/lib/schedule-time';
import { db as people } from '@/mocks/people-db';
import { sdb } from '@/mocks/schedule-db';
import { server } from '@/mocks/node';
import { lastReplacedUrl, renderPage } from '@/test/people';

const tomorrow = () => addDays(dateKeyIn('Africa/Cairo'), 1);

async function firstRow() {
  const table = await screen.findByRole('table', { name: 'حصص اليوم' });
  await waitFor(() => expect(table.querySelector('tr[data-session-id]')).not.toBeNull());
  const row = table.querySelector<HTMLElement>('tr[data-session-id]')!;
  return {
    row,
    id: Number(row.dataset.sessionId),
    name: within(row).getAllByRole('button')[0]!.textContent!,
  };
}

describe('Class detail sheet', () => {
  it('opens from the row into the URL and shows the timeline, evidence and actions', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage(<TodayView />, { path: `/today?date=${tomorrow()}` });
    const { id, name } = await firstRow();
    await user.click(screen.getAllByRole('button', { name })[0]!);
    expect(lastReplacedUrl().searchParams.get('session')).toBe(String(id));
    unmount();

    renderPage(<TodayView />, { path: `/today?date=${tomorrow()}&session=${id}` });
    const sheet = await screen.findByRole('dialog', { name: 'تفاصيل الحصة' });
    expect(await within(sheet).findByText('سجل الحصة')).toBeInTheDocument();
    expect(within(sheet).getByText('أُنشئت من الجدول')).toBeInTheDocument();
    expect(within(sheet).getByText('إثبات الحضور')).toBeInTheDocument();
    // Viewer's time first, then the student's labelled time.
    expect(within(sheet).getByText(/\(القاهرة\)/)).toBeInTheDocument();
    expect(within(sheet).getAllByText(/^الطالب /).length).toBeGreaterThan(0);
    expect(
      within(sheet).getByRole('button', { name: `إجراءات أخرى: ${name}` }),
    ).toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: 'الاشتراك' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/schedule\/\d+$/),
    );
  });
});

describe('Change a class time (reschedule)', () => {
  it('checks the new time live: a hard conflict blocks, a warning needs its tick, then saves', async () => {
    const user = userEvent.setup();
    let checks = 0;
    let patch: Record<string, unknown> | null = null;
    server.use(
      http.post('*/api/v1/schedule/check', () => {
        checks += 1;
        return HttpResponse.json({
          data:
            checks === 1
              ? {
                  conflicts: [
                    {
                      code: 'teacher_overlap',
                      severity: 'hard',
                      message: 'Overlaps another class of the teacher.',
                      with: { type: 'session', id: 1, label: 'Musa Saleh' },
                      firstDate: null,
                    },
                  ],
                  warnings: [],
                }
              : {
                  conflicts: [],
                  warnings: [
                    {
                      code: 'outside_work_hours',
                      severity: 'soft',
                      message: 'Outside the teacher’s work hours.',
                      with: null,
                      firstDate: null,
                    },
                  ],
                },
        });
      }),
    );
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PATCH' && /\/sessions\/\d+$/.test(request.url))
        patch = await request.clone().json();
    });
    renderPage(<TodayView />, { path: `/today?date=${tomorrow()}` });
    const { row, name } = await firstRow();
    await user.click(within(row).getByRole('button', { name: `إجراءات أخرى: ${name}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'تعديل الموعد' }));
    const dialog = await screen.findByRole('dialog', { name: `تعديل موعد حصة ${name}` });
    const save = within(dialog).getByRole('button', { name: 'احفظ الموعد' });
    expect(save).toBeDisabled();

    // 45 minutes: the teacher is busy (hard) — no override.
    await user.click(within(dialog).getByRole('combobox', { name: 'المدة' }));
    await user.click(await screen.findByRole('option', { name: '45 دقيقة' }));
    expect(await within(dialog).findByText('لا يمكن الحفظ: يوجد تعارض')).toBeInTheDocument();
    expect(within(dialog).getByText(/تعارض مع حصة أخرى للمعلم/)).toBeInTheDocument();
    expect(save).toBeDisabled();

    // 60 minutes: only a warning, saved once it is ticked.
    await user.click(within(dialog).getByRole('combobox', { name: 'المدة' }));
    await user.click(await screen.findByRole('option', { name: '60 دقيقة' }));
    const tick = await within(dialog).findByRole('checkbox', { name: 'خارج ساعات عمل المعلم' });
    expect(save).toBeDisabled();
    await user.click(tick);
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    expect(await screen.findByText(`تغيّر موعد حصة ${name}`)).toBeInTheDocument();
    expect(patch).toMatchObject({
      durationMinutes: 60,
      expectedStage: 'scheduled',
      acknowledgeWarnings: ['outside_work_hours'],
    });
    server.events.removeAllListeners();
  });
});

describe('Teacher «حصصي»', () => {
  it('lists only the teacher’s own classes, with «ابدأ الحصة» where allowed', async () => {
    renderPage(<MyClassesView />, { as: 'teacher@qarabic.test', path: '/my-classes' });
    expect(await screen.findByRole('heading', { level: 1, name: 'حصصي' })).toBeInTheDocument();
    const own = new Set(sdb.sessions.filter((s) => s.teacherId === 1).map((s) => s.studentId));
    const names = new Set(people.students.filter((s) => own.has(s.id)).map((s) => s.name));
    await waitFor(() => expect(screen.getAllByRole('table').length).toBeGreaterThan(0));
    const shown = screen
      .getAllByRole('table')
      .flatMap((t) => Array.from(t.querySelectorAll('tr[data-session-id]')))
      .map((r) => within(r as HTMLElement).getAllByRole('button')[0]!.textContent!);
    expect(shown.length).toBeGreaterThan(0);
    for (const n of shown) expect(names.has(n)).toBe(true);
    // No teacher column on the teacher's own list.
    expect(screen.queryByRole('columnheader', { name: 'المعلم' })).not.toBeInTheDocument();
  });
});
