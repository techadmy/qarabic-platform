import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { PublicTrialForm } from '@/components/crm/public-trial-form';
import { ReferralSection } from '@/components/crm/referral-section';
import { crmdb } from '@/mocks/crm-db';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { renderPage } from '@/test/people';

/** The JSON bodies POSTed to `path` (a handler wrapper, so nothing leaks into the next test). */
function capture(path: string) {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.post(`*/api/v1${path}`, async ({ request }) => {
      bodies.push((await request.clone().json()) as Record<string, unknown>);
      return undefined;
    }),
  );
  return bodies;
}

async function pick(user: ReturnType<typeof userEvent.setup>, box: HTMLElement, option: RegExp) {
  await user.click(box);
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('Public trial form (/trial)', () => {
  it('marks the required fields and sends nothing', async () => {
    const user = userEvent.setup({ delay: null });
    const sent = capture('/public/trial-requests');
    renderWithProviders(<PublicTrialForm />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'احجز حصة تجريبية مجانية' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'أرسل الطلب' }));
    expect(await screen.findByText('راجع الحقول المحددة باللون الأحمر.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^الاسم الكامل/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/^اسم الطالب/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('اختر يومًا واحدًا على الأقل.')).toBeInTheDocument();
    expect(screen.getByText('اختر وقتًا واحدًا على الأقل.')).toBeInTheDocument();
    expect(sent).toHaveLength(0);
  });

  it('sends a complete request and thanks the parent by name', async () => {
    const user = userEvent.setup({ delay: null });
    const sent = capture('/public/trial-requests');
    const before = crmdb.leads.length;
    renderWithProviders(<PublicTrialForm />);
    await user.type(await screen.findByLabelText(/^الاسم الكامل/), 'Test Parent');
    await user.click(screen.getByRole('combobox', { name: /بلد الإقامة/ }));
    await user.type(await screen.findByPlaceholderText('ابحث باسم الدولة أو رمزها'), 'المملكة');
    await user.click(await screen.findByRole('option', { name: /^المملكة المتحدة/ }));
    await user.click(screen.getByRole('combobox', { name: /المنطقة الزمنية/ }));
    await user.type(await screen.findByPlaceholderText('ابحث باسم المدينة'), 'لندن');
    await user.click(await screen.findByRole('option', { name: /لندن/ }));
    // The country picked above sets the WhatsApp dial code (+44).
    await user.type(screen.getByLabelText(/^رقم واتساب/), '7700900555');
    await user.type(screen.getByLabelText(/^البريد الإلكتروني/), 'test.parent@example.com');
    await user.type(screen.getByLabelText(/^اسم الطالب/), 'Yusuf');
    await user.type(screen.getByLabelText(/^العمر/), '8');
    await pick(user, screen.getByRole('combobox', { name: /^الجنس/ }), /^ذكر$/);
    await pick(user, await screen.findByRole('combobox', { name: /^الدورة/ }), /حفظ القرآن الكريم/);
    const days = screen.getByRole('group', { name: /الأيام المناسبة/ });
    await user.click(within(days).getAllByRole('checkbox')[0]!);
    const periods = screen.getByRole('group', { name: /الأوقات المناسبة/ });
    await user.click(within(periods).getAllByRole('checkbox')[0]!);
    await user.click(screen.getByRole('button', { name: 'أرسل الطلب' }));

    const thanks = await screen.findByRole('status');
    expect(
      within(thanks).getByRole('heading', { level: 1, name: 'شكرًا لك، Test Parent' }),
    ).toBeInTheDocument();
    expect(within(thanks).getByText('استلمنا طلب الحصة التجريبية المجانية.')).toBeVisible();
    expect(sent[0]).toMatchObject({
      parentName: 'Test Parent',
      phone: '+447700900555',
      email: 'test.parent@example.com',
      countryCode: 'GB',
      timezone: 'Europe/London',
      children: [{ name: 'Yusuf', age: 8, gender: 'male', courseId: 3 }],
      teacherGenderPref: 'any',
      locale: 'ar',
      website: '',
    });
    expect(crmdb.leads.length).toBe(before + 1);
  });
});

describe('«رشّح صديقًا» (parent home)', () => {
  it('is hidden from staff without leads.refer', async () => {
    renderPage(<ReferralSection />, { as: 'teacher@qarabic.test' });
    await screen.findByRole('button', { name: /الإشعارات/ });
    expect(screen.queryByRole('heading', { name: 'رشّح صديقًا' })).not.toBeInTheDocument();
  });

  it('needs a name and a phone or an email, then sends the referral', async () => {
    const user = userEvent.setup({ delay: null });
    const sent = capture('/me/referrals');
    renderPage(<ReferralSection />, { as: 'parent@qarabic.test' });
    await user.click(await screen.findByRole('button', { name: 'رشّح صديقًا' }));
    const dialog = await screen.findByRole('dialog', { name: 'ترشيح صديق' });
    await user.click(within(dialog).getByRole('button', { name: 'أرسل الترشيح' }));
    const name = within(dialog).getByLabelText(/^اسم ولي الأمر/);
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
    const phone = within(dialog).getByLabelText(/^رقم الهاتف/);
    expect(phone).toHaveAttribute('aria-invalid', 'true');
    // The shared phone-or-email rule shows in Arabic, not in English.
    expect(within(dialog).getByText('أدخل رقم الهاتف أو البريد الإلكتروني.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/Enter a phone/)).toBeNull();
    expect(sent).toHaveLength(0);

    await user.type(name, 'Friend Parent');
    await user.type(within(dialog).getByLabelText(/^البريد الإلكتروني/), 'friend@example.com');
    // Typing the email clears the phone's error at once, before the next submit.
    await waitFor(() => expect(phone).not.toHaveAttribute('aria-invalid', 'true'));
    await user.click(within(dialog).getByRole('button', { name: 'أرسل الترشيح' }));
    expect((await screen.findAllByText('شكرًا لك، أُرسل الترشيح.'))[0]).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ترشيح صديق' })).toBeNull());
    expect(sent[0]).toMatchObject({ parentName: 'Friend Parent', email: 'friend@example.com' });
    expect(crmdb.referrals).toBe(1);
  });
});
