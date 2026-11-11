import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { setLocale } from '@/i18n/actions';
import { MOCK_PASSWORD } from '@/mocks/data';
import { renderPage } from '@/test/people';
import { routerMock } from '@/test/router-mock';
import { AccountView } from './account-view';

function card(title: string) {
  return screen
    .getByText(title, { selector: '[data-slot="card-title"]' })
    .closest('[data-slot="card"]') as HTMLElement;
}

describe('Account page', () => {
  it('saves the name and phone (E.164) with PATCH /me', async () => {
    renderPage(<AccountView />, { path: '/account' });
    const user = userEvent.setup();
    const name = await screen.findByLabelText(/^الاسم/);
    await user.clear(name);
    await user.type(name, 'مدير الأكاديمية');
    await user.type(screen.getByLabelText(/^الهاتف/), '01000000999');
    await user.click(screen.getByRole('button', { name: 'احفظ التغييرات' }));
    expect(await screen.findByText('حُفظت التغييرات')).toBeInTheDocument();
    // The top bar's account menu follows the new name (first letter).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'حسابي' })).toHaveTextContent('م'),
    );
  });

  it('applies a new interface language after saving it', async () => {
    renderPage(<AccountView />, { path: '/account' });
    const user = userEvent.setup();
    await screen.findByLabelText(/^الاسم/);
    await user.click(screen.getByRole('combobox', { name: 'لغة الواجهة' }));
    await user.click(await screen.findByRole('option', { name: 'English' }));
    await user.click(screen.getByRole('button', { name: 'احفظ التغييرات' }));
    await waitFor(() => expect(setLocale).toHaveBeenCalledWith('en'));
    expect(routerMock.refresh).toHaveBeenCalled();
  });

  it('checks the password confirmation and the current password', async () => {
    renderPage(<AccountView />, { path: '/account' });
    const user = userEvent.setup();
    await screen.findByLabelText(/^الاسم/);
    const password = card('كلمة المرور');
    await user.type(within(password).getByLabelText('كلمة المرور الحالية'), 'wrong-password');
    await user.type(within(password).getByLabelText('كلمة المرور الجديدة'), 'new-pass-123');
    await user.type(within(password).getByLabelText('تأكيد كلمة المرور الجديدة'), 'new-pass-124');
    await user.click(within(password).getByRole('button', { name: 'غيّر كلمة المرور' }));
    expect(await within(password).findByText('كلمتا المرور غير متطابقتين')).toBeInTheDocument();

    await user.clear(within(password).getByLabelText('تأكيد كلمة المرور الجديدة'));
    await user.type(within(password).getByLabelText('تأكيد كلمة المرور الجديدة'), 'new-pass-123');
    await user.click(within(password).getByRole('button', { name: 'غيّر كلمة المرور' }));
    expect(await within(password).findByText('كلمة المرور الحالية غير صحيحة')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(password).getByLabelText('كلمة المرور الحالية')).toHaveFocus(),
    );

    await user.clear(within(password).getByLabelText('كلمة المرور الحالية'));
    await user.type(within(password).getByLabelText('كلمة المرور الحالية'), MOCK_PASSWORD);
    await user.click(within(password).getByRole('button', { name: 'غيّر كلمة المرور' }));
    expect(await screen.findByText('تغيّرت كلمة المرور')).toBeInTheDocument();
  });

  it('offers light, dark and system themes', async () => {
    renderPage(<AccountView />, { path: '/account' });
    const theme = await screen.findByRole('radiogroup');
    expect(
      within(theme)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('value')),
    ).toEqual(['light', 'dark', 'system']);
  });
});
