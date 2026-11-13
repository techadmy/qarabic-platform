import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TicketDetailView } from '@/components/support/ticket-detail';
import { TicketFormDialog } from '@/components/support/ticket-form-dialog';
import { supdb } from '@/mocks/support-db';
import { renderPage } from '@/test/people';

const PARENT = 'parent@qarabic.test';

describe('S3 typed requests', () => {
  it('a teacher change asks for its reason, then sends it with the child', async () => {
    const user = userEvent.setup();
    renderPage(
      <TicketFormDialog
        open
        onOpenChange={() => undefined}
        intent={{
          key: 'teacher_change',
          category: 'teacher',
          subcategory: 'teacher_change',
          picker: 'student',
        }}
      />,
      { as: PARENT, path: '/' },
    );
    const dialog = await screen.findByRole('dialog', { name: 'طلب تغيير المعلم' });
    await user.type(
      within(dialog).getByRole('textbox', { name: /لماذا تريد تغيير المعلم/ }),
      'We would like a teacher who explains in English.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'أرسل' }));
    // The reason is required: the focus goes there.
    const reason = within(dialog).getByRole('combobox', { name: 'سبب طلب تغيير المعلم' });
    await waitFor(() => expect(reason).toHaveFocus());
    await user.click(reason);
    await user.click(await screen.findByRole('option', { name: 'اللغة' }));
    const before = supdb.tickets.length;
    await user.click(within(dialog).getByRole('button', { name: 'أرسل' }));
    await waitFor(() => expect(supdb.tickets.length).toBe(before + 1));
    const t = supdb.tickets.at(-1)!;
    expect(t.request).toMatchObject({
      kind: 'teacher_change',
      state: 'submitted',
      payload: { reason: 'language' },
    });
    expect(typeof (t.request!.payload as { studentId: unknown }).studentId).toBe('number');
  });

  it('staff propose a teacher; the family accepts; staff mark it done', async () => {
    const user = userEvent.setup();
    const t = supdb.tickets.find((x) => x.reporter?.id === 3)!;
    Object.assign(t, {
      category: 'teacher',
      subcategory: 'teacher_change',
      request: {
        kind: 'teacher_change',
        state: 'submitted',
        payload: { studentId: 1, reason: 'level', preferredGender: 'female' },
        proposal: null,
      },
    });
    const first = renderPage(<TicketDetailView id={t.id} />, { path: `/tickets/${t.id}` });
    const card = await screen.findByRole('heading', { name: 'طلب: طلب تغيير المعلم' });
    const box = card.closest('[data-slot="card"]')!;
    expect(box).toHaveTextContent('لا يناسب مستوى الطالب');
    expect(box).toHaveTextContent('معلمة');
    await user.click(within(box as HTMLElement).getByRole('button', { name: 'اقترح معلمًا' }));
    const propose = await screen.findByRole('dialog', { name: 'اقترح معلمًا' });
    await user.click(within(propose).getByRole('combobox', { name: 'المعلم' }));
    await user.click((await screen.findAllByRole('option'))[0]!);
    await user.click(within(propose).getByRole('button', { name: 'أرسل الاقتراح' }));
    await waitFor(() => expect(t.request!.state).toBe('proposed'));
    first.unmount();

    const second = renderPage(<TicketDetailView id={t.id} />, {
      as: PARENT,
      path: `/tickets/${t.id}`,
    });
    await user.click(await screen.findByRole('button', { name: 'أوافق على المعلم المقترح' }));
    // The consequence first (who, from when), then «تأكيد».
    const accept = await screen.findByRole('dialog', { name: 'الموافقة على المعلم المقترح؟' });
    expect(accept).toHaveTextContent(/ابتداءً من/);
    await user.click(within(accept).getByRole('button', { name: 'أوافق على المعلم المقترح' }));
    await waitFor(() => expect(t.request!.state).toBe('accepted'));
    second.unmount();

    renderPage(<TicketDetailView id={t.id} />, { path: `/tickets/${t.id}` });
    // Staff see their own wording of the state.
    expect(await screen.findByText('وافقت الأسرة')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'تم التنفيذ' }));
    const complete = await screen.findByRole('dialog', { name: 'تسجيل الطلب منفّذًا؟' });
    await user.click(within(complete).getByRole('button', { name: 'تم التنفيذ' }));
    await waitFor(() => expect(t.request!.state).toBe('done'));
  });
});
