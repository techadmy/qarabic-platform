import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { FamiliesView } from '@/app/(app)/families/families-view';
import { FamilyProfile } from '@/app/(app)/families/[id]/family-profile';
import { TeacherProfile } from '@/app/(app)/teachers/[id]/teacher-profile';
import { server } from '@/mocks/node';
import { renderPage } from '@/test/people';
import { routerMock } from '@/test/router-mock';

async function openSheet(name: string) {
  // No delay between keys: each key otherwise waits a macrotask, which a loaded runner stretches.
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole('button', { name }));
  const sheet = await screen.findByRole('dialog');
  // The form shows once the lookups (managers, courses, teachers) are in.
  await within(sheet).findByLabelText(/اسم ولي الأمر|الاسم الأول|الاسم/);
  return { user, sheet };
}

describe('Add / edit sheet', () => {
  it('validates with the shared schema: required fields marked, first invalid field focused', async () => {
    renderPage(<FamiliesView />, { path: '/families' });
    const { user, sheet } = await openSheet('أضف عائلة');
    expect(within(sheet).getByRole('heading', { name: 'عائلة جديدة' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'إنشاء' }));
    expect(await within(sheet).findByText('صحّح الحقول المحددة ثم احفظ.')).toBeInTheDocument();
    const name = within(sheet).getByLabelText(/اسم ولي الأمر/);
    expect(name).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(name).toHaveFocus());
    expect(within(sheet).getAllByText('هذا الحقل مطلوب').length).toBeGreaterThan(0);
    // The phone is checked as E.164 with the shared phoneSchema.
    await user.type(within(sheet).getByLabelText(/^الهاتف/), '12');
    await user.tab();
    expect(
      await within(sheet).findByText('اكتب رقمًا دوليًا صحيحًا مع رمز الدولة'),
    ).toBeInTheDocument();
  });

  it('creates a family (phone with the dial code → E.164, searchable time zone) and opens it', async () => {
    let body: Record<string, unknown> | null = null;
    // A handler wrapper, not `server.events`: no listener can leak into the next test if this fails.
    server.use(
      http.post('*/api/v1/families', async ({ request }) => {
        body = (await request.clone().json()) as Record<string, unknown>;
        return undefined;
      }),
    );
    renderPage(<FamiliesView />, { path: '/families' });
    const { user, sheet } = await openSheet('أضف عائلة');
    await user.type(within(sheet).getByLabelText(/اسم ولي الأمر/), 'Test Parent');
    await user.type(within(sheet).getByLabelText(/البريد الإلكتروني/), 'Test.Parent@Example.com');
    // Country code picker (combobox), then the national number with its leading 0.
    await user.click(within(sheet).getByRole('combobox', { name: 'رمز الدولة' }));
    await user.type(await screen.findByPlaceholderText('ابحث باسم الدولة أو رمزها'), 'المملكة');
    await user.click(await screen.findByRole('option', { name: /المملكة المتحدة \(\+44\)/ }));
    await user.type(within(sheet).getByLabelText(/^الهاتف/), '07700 900555');
    await user.click(within(sheet).getByRole('combobox', { name: /المنطقة الزمنية/ }));
    await user.type(await screen.findByPlaceholderText('ابحث باسم المدينة'), 'لندن');
    await user.click(await screen.findByRole('option', { name: /لندن/ }));
    await user.click(screen.getByRole('button', { name: 'إنشاء' }));
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith('/families/100'));
    expect(body).toMatchObject({
      parentName: 'Test Parent',
      email: 'test.parent@example.com',
      phone: '+447700900555',
      timezone: 'Europe/London',
      status: 'regular',
    });
    expect(await screen.findByText('أُنشئ السجل')).toBeInTheDocument();
  });

  it('maps a 422 from the server onto the field and focuses it', async () => {
    renderPage(<FamilyProfile id={2} />, { path: '/families/2' });
    const { user, sheet } = await openSheet('تعديل');
    const email = within(sheet).getByLabelText(/البريد الإلكتروني/);
    await user.clear(email);
    await user.type(email, 'parent@qarabic.test');
    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await within(sheet).findByText('هذا البريد مستخدم في حساب آخر')).toBeInTheDocument();
    await waitFor(() => expect(email).toHaveFocus());
  });

  it('sends only the changed fields and asks before closing with unsaved changes', async () => {
    let body: unknown = null;
    server.use(
      http.patch('*/api/v1/families/2', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ message: 'stop', code: 'generic' }, { status: 500 });
      }),
    );
    renderPage(<FamilyProfile id={2} />, { path: '/families/2' });
    const { user, sheet } = await openSheet('تعديل');
    await user.type(within(sheet).getByLabelText(/معرّف Zoom/), '123 456');
    await user.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(body).toEqual({ zoomId: '123 456' }));
    await user.click(within(sheet).getByRole('button', { name: 'إلغاء' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'تجاهل التغييرات؟' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'متابعة التعديل' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('Status dialog', () => {
  it('requires the reason the shared FAMILY_STATUSES_NEEDING_REASON lists, explains the effect, then changes it', async () => {
    // The status history is the «السجل» tab (D141 §7).
    renderPage(<FamilyProfile id={2} />, { path: '/families/2?tab=history' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'تغيير الحالة' }));
    const dialog = await screen.findByRole('dialog', { name: 'تغيير حالة Yusuf Hassan' });
    expect(within(dialog).getByText('الحالة الحالية: منتظمة')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: 'معلّقة' }));
    expect(within(dialog).getByText(/تُوقف الاشتراكات مؤقتًا/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'علّق الحساب' }));
    expect(await within(dialog).findByText('اكتب السبب (3 أحرف على الأقل)')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/السبب/), 'Unpaid invoice');
    await user.click(within(dialog).getByRole('button', { name: 'علّق الحساب' }));
    expect(await screen.findByText('تغيّرت الحالة إلى «معلّقة»')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The new status shows in the history with its reason.
    expect(await screen.findByText('من «منتظمة» إلى «معلّقة»')).toBeInTheDocument();
    expect(screen.getAllByText(/Unpaid invoice/).length).toBeGreaterThan(0);
  });

  it('back to regular needs no reason and offers Undo', async () => {
    renderPage(<FamilyProfile id={22} />, { path: '/families/22' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'تغيير الحالة' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'منتظمة' }));
    expect(within(dialog).getByText('(اختياري)')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'أعِد التفعيل' }));
    expect(await screen.findByText('تغيّرت الحالة إلى «منتظمة»')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'تراجع' }));
    expect(await screen.findByText('أُعيدت الحالة السابقة')).toBeInTheDocument();
  });

  it('shows the teacher_has_students refusal with the count', async () => {
    renderPage(<TeacherProfile id={1} />, { path: '/teachers/1' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'تغيير الحالة' }));
    const dialog = await screen.findByRole('dialog');
    // The only other status is preselected; the warning comes before the server refuses.
    expect(within(dialog).getByRole('radio', { name: 'غير نشط' })).toBeChecked();
    expect(within(dialog).getByText(/لا يمكن إيقاف المعلم ولديه/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/السبب/), 'Leaving');
    await user.click(within(dialog).getByRole('button', { name: 'أوقف المعلم' }));
    // The server's refusal joins the warning (both name the 6 active students).
    await waitFor(() =>
      expect(within(dialog).getAllByText(/لا يمكن إيقاف المعلم ولديه/)).toHaveLength(2),
    );
  });
});

describe('Archive', () => {
  it('explains that an active record must be deactivated first', async () => {
    renderPage(<FamilyProfile id={2} />, { path: '/families/2' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'إجراءات أخرى' }));
    await user.click(await screen.findByRole('menuitem', { name: 'حذف' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/لا تُحذف عائلة نشطة/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'احذف' })).not.toBeInTheDocument();
  });

  it('archives a deactivated family with a reason; the profile turns read-only; Undo restores', async () => {
    renderPage(<FamilyProfile id={24} />, { path: '/families/24' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'إجراءات أخرى' }));
    await user.click(await screen.findByRole('menuitem', { name: 'حذف' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'احذف' }));
    expect(await within(dialog).findByText('3 أحرف على الأقل')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/سبب الحذف/), 'Duplicate account');
    await user.click(within(dialog).getByRole('button', { name: 'احذف' }));
    expect(await screen.findByText('سجل محذوف (في الأرشيف)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تغيير الحالة' })).not.toBeInTheDocument();
    const toast = (await screen.findByText('حُذف Rania Jaber ونُقل إلى الأرشيف')).closest('li')!;
    await user.click(within(toast).getByRole('button', { name: 'تراجع' }));
    await waitFor(() =>
      expect(screen.queryByText('سجل محذوف (في الأرشيف)')).not.toBeInTheDocument(),
    );
  });
});
