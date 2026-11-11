import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { meQueryKey } from '@/lib/auth/use-me';
import { MOCK_PASSWORD } from '@/mocks/data';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { LoginForm } from './login-form';

function setup() {
  const user = userEvent.setup();
  const utils = renderWithProviders(<LoginForm />);
  return { user, ...utils };
}

describe('LoginForm', () => {
  it('signs in with a pasted password that carries invisible bidi marks', async () => {
    let received: { email?: string; password?: string } = {};
    server.events.on('request:start', async ({ request }) => {
      if (request.url.endsWith('/auth/login')) received = await request.clone().json();
    });
    const { user, queryClient } = setup();
    await user.click(screen.getByLabelText('البريد الإلكتروني'));
    await user.paste('‏ admin@qarabic.test‎');
    await user.click(screen.getByLabelText('كلمة المرور'));
    await user.paste(`‫‏${MOCK_PASSWORD}‎﻿\n`);
    await user.click(screen.getByRole('button', { name: 'دخول' }));

    await waitFor(() => expect(queryClient.getQueryData(meQueryKey)).toMatchObject({ id: 1 }));
    expect(received).toEqual({
      email: 'admin@qarabic.test',
      password: MOCK_PASSWORD,
      remember: true,
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    server.events.removeAllListeners();
  });

  it('shows and hides the password', async () => {
    const { user } = setup();
    const input = screen.getByLabelText('كلمة المرور');
    expect(input).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'إظهار كلمة المرور' }));
    expect(input).toHaveAttribute('type', 'text');
    const hide = screen.getByRole('button', { name: 'إخفاء كلمة المرور' });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    await user.click(hide);
    expect(input).toHaveAttribute('type', 'password');
  });

  it('says the credentials are wrong on 422', async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText('البريد الإلكتروني'), 'admin@qarabic.test');
    await user.type(screen.getByLabelText('كلمة المرور'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'دخول' }));
    expect(await screen.findByText('البريد الإلكتروني أو كلمة المرور غير صحيحة.')).toBeVisible();
  });

  it('asks the user to wait on 429', async () => {
    server.use(
      http.post('*/api/v1/auth/login', () =>
        HttpResponse.json(
          { message: 'Too Many Requests.', code: 'too_many_requests' },
          { status: 429 },
        ),
      ),
    );
    const { user } = setup();
    await user.type(screen.getByLabelText('البريد الإلكتروني'), 'admin@qarabic.test');
    await user.type(screen.getByLabelText('كلمة المرور'), 'whatever');
    await user.click(screen.getByRole('button', { name: 'دخول' }));
    expect(await screen.findByText('محاولات كثيرة. حاول مرة أخرى بعد دقيقة.')).toBeVisible();
  });

  it('shows a generic error when the server fails', async () => {
    server.use(http.post('*/api/v1/auth/login', () => new HttpResponse(null, { status: 500 })));
    const { user } = setup();
    await user.type(screen.getByLabelText('البريد الإلكتروني'), 'admin@qarabic.test');
    await user.type(screen.getByLabelText('كلمة المرور'), 'whatever');
    await user.click(screen.getByRole('button', { name: 'دخول' }));
    expect(await screen.findByText('حدث خطأ. حاول مرة أخرى.')).toBeVisible();
  });

  it('validates empty and malformed fields in Arabic without calling the API', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'دخول' }));
    expect(await screen.findAllByText('هذا الحقل مطلوب')).toHaveLength(2);
    await user.type(screen.getByLabelText('البريد الإلكتروني'), 'not-an-email');
    expect(await screen.findByText('أدخل بريدًا إلكترونيًا صحيحًا')).toBeVisible();
  });
});
