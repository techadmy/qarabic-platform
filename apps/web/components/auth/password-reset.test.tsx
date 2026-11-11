import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { MOCK_RESET_TOKEN } from '@/mocks/data';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { ForgotPasswordForm } from './forgot-password-form';
import { ResetPasswordForm } from './reset-password-form';

describe('ForgotPasswordForm', () => {
  it('always confirms that a link was sent', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText('البريد الإلكتروني'), 'someone@qarabic.test');
    await user.click(screen.getByRole('button', { name: 'إرسال الرابط' }));
    expect(await screen.findByText('أُرسل الرابط')).toBeVisible();
  });
});

describe('ResetPasswordForm', () => {
  async function fill(password: string, confirmation: string) {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('كلمة المرور الجديدة'), password);
    await user.type(screen.getByLabelText('تأكيد كلمة المرور'), confirmation);
    await user.click(screen.getByRole('button', { name: 'حفظ كلمة المرور' }));
  }

  it('sends only { token, password } (cleaned) and confirms', async () => {
    let body: unknown;
    server.events.on('request:start', async ({ request }) => {
      if (request.url.endsWith('/auth/reset-password')) body = await request.clone().json();
    });
    renderWithProviders(<ResetPasswordForm token={MOCK_RESET_TOKEN} />);
    await fill('New-password-1\u200f', 'New-password-1');
    expect(await screen.findByText('تغيّرت كلمة المرور. يمكنك تسجيل الدخول الآن.')).toBeVisible();
    expect(body).toEqual({ token: MOCK_RESET_TOKEN, password: 'New-password-1' });
    server.events.removeAllListeners();
  });

  it('checks the minimum length', async () => {
    renderWithProviders(<ResetPasswordForm token={MOCK_RESET_TOKEN} />);
    await fill('short', 'short');
    expect(await screen.findAllByText('8 أحرف على الأقل')).toHaveLength(1);
  });

  it('checks that both passwords match', async () => {
    renderWithProviders(<ResetPasswordForm token={MOCK_RESET_TOKEN} />);
    await fill('New-password-1', 'New-password-2');
    expect(await screen.findByText('كلمتا المرور غير متطابقتين')).toBeVisible();
  });

  it('explains an expired link (422 invalid_reset_token)', async () => {
    renderWithProviders(<ResetPasswordForm token="expired-token-0123456789abcdef" />);
    await fill('New-password-1', 'New-password-1');
    expect(await screen.findByText(/رابط تغيير كلمة المرور غير صالح/)).toBeVisible();
  });

  it('flags a link without a usable token before calling the API', () => {
    renderWithProviders(<ResetPasswordForm token="" />);
    expect(screen.getByText(/رابط تغيير كلمة المرور غير صالح/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'حفظ كلمة المرور' })).toBeDisabled();
  });

  it('caps the password at 128 characters', async () => {
    renderWithProviders(<ResetPasswordForm token={MOCK_RESET_TOKEN} />);
    const long = 'a'.repeat(129);
    await fill(long, long);
    expect(await screen.findAllByText('128 حرفًا على الأكثر')).toHaveLength(1);
  });

  it('shows a generic error when the server fails', async () => {
    server.use(
      http.post('*/api/v1/auth/reset-password', () => new HttpResponse(null, { status: 500 })),
    );
    renderWithProviders(<ResetPasswordForm token={MOCK_RESET_TOKEN} />);
    await fill('New-password-1', 'New-password-1');
    expect(await screen.findByText('حدث خطأ. حاول مرة أخرى.')).toBeVisible();
  });
});
