import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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

  it('saves the new password with a valid link', async () => {
    renderWithProviders(<ResetPasswordForm token="valid-token" email="admin@qarabic.test" />);
    await fill('New-password-1', 'New-password-1');
    expect(await screen.findByText('تغيّرت كلمة المرور. يمكنك تسجيل الدخول الآن.')).toBeVisible();
  });

  it('checks the minimum length', async () => {
    renderWithProviders(<ResetPasswordForm token="valid-token" email="admin@qarabic.test" />);
    await fill('short', 'short');
    expect(await screen.findAllByText('8 أحرف على الأقل')).toHaveLength(2);
  });

  it('checks that both passwords match', async () => {
    renderWithProviders(<ResetPasswordForm token="valid-token" email="admin@qarabic.test" />);
    await fill('New-password-1', 'New-password-2');
    expect(await screen.findByText('كلمتا المرور غير متطابقتين')).toBeVisible();
  });

  it('explains an expired link', async () => {
    renderWithProviders(<ResetPasswordForm token="expired" email="admin@qarabic.test" />);
    await fill('New-password-1', 'New-password-1');
    expect(await screen.findByText(/رابط تغيير كلمة المرور غير صالح/)).toBeVisible();
  });
});
