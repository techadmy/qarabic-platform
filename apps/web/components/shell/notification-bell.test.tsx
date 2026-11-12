import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { crmdb } from '@/mocks/crm-db';
import { renderPage } from '@/test/people';

/** The bell sits in the top bar of the shell; the admin has 2 unread lead alerts and 1 read one. */
async function openBell(user: ReturnType<typeof userEvent.setup>) {
  const bell = await screen.findByRole('button', { name: 'الإشعارات، غير المقروءة: 2' });
  expect(bell).toHaveTextContent('2');
  await user.click(bell);
  return screen.findByRole('list', { name: 'الإشعارات' });
}

describe('Notification bell', () => {
  it('shows the unread count and the latest alerts, unread ones marked', async () => {
    const user = userEvent.setup();
    renderPage(<div />);
    const list = await openBell(user);
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const first = within(list).getByRole('link', { name: /أُسند إليك طلب جديد: Amina Rahman/ });
    expect(first).toHaveAttribute('href', '/leads/1');
    expect(first).toHaveTextContent('غير مقروء:');
    const read = within(list).getByRole('link', { name: /حان موعد المتابعة: Bilal Ahmed/ });
    expect(read).not.toHaveTextContent('غير مقروء:');
  });

  it('opening an alert marks it read', async () => {
    const user = userEvent.setup();
    renderPage(<div />);
    const list = await openBell(user);
    await user.click(within(list).getByRole('link', { name: /Amina Rahman/ }));
    await waitFor(() => expect(crmdb.notifications.find((n) => n.id === 1)!.readAt).not.toBeNull());
    expect(
      await screen.findByRole('button', { name: 'الإشعارات، غير المقروءة: 1' }),
    ).toBeInTheDocument();
  });

  it('«تعليم الكل كمقروء» clears the count', async () => {
    const user = userEvent.setup();
    renderPage(<div />);
    await openBell(user);
    await user.click(screen.getByRole('button', { name: 'تعليم الكل كمقروء' }));
    expect(
      await screen.findByRole('button', { name: 'الإشعارات، غير المقروءة: 0' }),
    ).toBeInTheDocument();
    expect(crmdb.notifications.filter((n) => n.userId === 1 && !n.readAt)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'تعليم الكل كمقروء' })).not.toBeInTheDocument();
  });

  it('says so when there are no alerts', async () => {
    const user = userEvent.setup();
    renderPage(<div />, { as: 'teacher@qarabic.test' });
    await user.click(await screen.findByRole('button', { name: 'الإشعارات، غير المقروءة: 0' }));
    expect(await screen.findByText('لا توجد إشعارات.')).toBeInTheDocument();
  });
});
